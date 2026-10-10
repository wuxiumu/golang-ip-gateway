package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/redis/go-redis/v9"

	"ip-gateway/internal/geo"
	"ip-gateway/internal/ratelimit"
	"ip-gateway/internal/redisclient"
	"ip-gateway/internal/rule"
	"ip-gateway/internal/stats"
)

func main() {
	configPath := flag.String("config", "./config.yaml", "配置文件路径")
	flag.Parse()
	configDir := filepath.Dir(*configPath)

	// 0. 命中统计：启动恢复历史，运行期内存聚合
	st := stats.New()
	_ = st.Load(configDir)

	// 0.5 IP 归属地库（内嵌 ip2region IPv4，无需外部数据文件）
	if err := geo.Init(); err != nil {
		log.Printf("geo init failed (%v), region routing disabled", err)
	} else {
		log.Printf("geo loaded: ip2region ipv4 embedded, region routing enabled")
	}
	rule.RegionLookup = geo.Query

	// 第一步：先加载本地兜底配置，保证任何情况下都有可用规则
	baseCfg, err := rule.LoadFromFile(*configPath)
	if err != nil {
		log.Fatalf("load config %s failed: %v", *configPath, err)
	}
	rule.ApplyEnv(baseCfg)
	rule.ApplyDefaults(baseCfg)
	rule.Set(baseCfg)
	log.Printf("loaded fallback config from %s, rules=%d", *configPath, len(baseCfg.Rules))
	log.Printf("runtime listen=%s log_level=%s access=%v gin=%s rate_limit_rps=%g cors=%s",
		baseCfg.Listen, baseCfg.Log.Level, baseCfg.Log.Access, baseCfg.Log.GinMode, baseCfg.RateLimit.RPS, baseCfg.CORSOrigin)

	// 第二步：尝试用 Redis 规则覆盖内存；失败保留文件兜底，正常启动
	var rdb *redis.Client
	if baseCfg.Redis.Addr != "" {
		rdb = redisclient.New(baseCfg.Redis)
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		rules, err := rule.LoadRulesFromRedis(ctx, rdb, baseCfg.Redis.Key)
		cancel()
		if err == nil {
			newCfg := *baseCfg
			newCfg.Rules = rules
			newCfg.Source = "redis"
			rule.Set(&newCfg)
			log.Printf("loaded rules from redis key=%s, rules=%d", baseCfg.Redis.Key, len(rules))
		} else {
			log.Printf("redis unavailable (%v), keep file fallback", err)
		}
	} else {
		log.Printf("redis addr empty, running in file-only mode")
	}

	switch baseCfg.Log.GinMode {
	case "debug":
		gin.SetMode(gin.DebugMode)
	case "test":
		gin.SetMode(gin.TestMode)
	default:
		gin.SetMode(gin.ReleaseMode)
	}
	r := gin.New()
	r.Use(gin.Recovery())
	// CORS：默认 *，与原先本地管理端直连一致；私有化可改成具体源。
	r.Use(func(c *gin.Context) {
		origin := "*"
		if cfg := rule.Get(); cfg != nil && cfg.CORSOrigin != "" {
			origin = cfg.CORSOrigin
		}
		c.Header("Access-Control-Allow-Origin", origin)
		c.Header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		c.Header("Access-Control-Allow-Headers", "Content-Type, X-Admin-Token")
		if c.Request.Method == http.MethodOptions {
			c.AbortWithStatus(http.StatusNoContent)
			return
		}
		c.Next()
	})
	if lim := ratelimit.New(baseCfg.RateLimit.RPS, baseCfg.RateLimit.Burst); lim.Enabled() {
		r.Use(func(c *gin.Context) {
			if !lim.Allow(c.ClientIP()) {
				c.AbortWithStatusJSON(http.StatusTooManyRequests, gin.H{"msg": "rate limited"})
				return
			}
			c.Next()
		})
		log.Printf("rate limit enabled: rps=%g burst=%g per client ip", baseCfg.RateLimit.RPS, baseCfg.RateLimit.Burst)
	}
	// 前置 nginx/LB 时必须信任其网段，否则 ClientIP 是代理 IP，分流全错
	if err := r.SetTrustedProxies(baseCfg.TrustedProxies); err != nil {
		log.Printf("set trusted proxies warning: %v", err)
	}

	registerAdmin(r, rdb, *configPath, st)
	registerGateway(r, st)

	// 定时把统计刷盘，间隔来自配置（默认 30 秒）
	go func() {
		t := time.NewTicker(baseCfg.StatsFlushInterval.D())
		defer t.Stop()
		for range t.C {
			_ = st.Save(configDir)
		}
	}()

	srv := &http.Server{Addr: baseCfg.Listen, Handler: r}
	go func() {
		cfg := rule.Get()
		log.Printf("gateway listening on %s, default_target=%s, source=%s",
			cfg.Listen, cfg.DefaultTarget, cfg.Source)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("listen failed: %v", err)
		}
	}()

	// 优雅退出：systemd/守护进程发 SIGTERM 时不再接新请求，等存量请求收尾
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit
	log.Printf("shutting down...")
	ctx, cancel := context.WithTimeout(context.Background(), baseCfg.ShutdownTimeout.D())
	defer cancel()
	_ = srv.Shutdown(ctx)
	_ = st.Save(configDir) // 退出前保存统计
}

// registerGateway 核心分流入口：除 /admin 外的所有路径都进 IP 匹配 302，并计入流量统计。
func registerGateway(r *gin.Engine, st *stats.Stats) {
	r.NoRoute(func(c *gin.Context) {
		if c.Request.URL.Path == "/admin" || strings.HasPrefix(c.Request.URL.Path, "/admin/") {
			c.JSON(http.StatusNotFound, gin.H{"msg": "not found"})
			return
		}
		cfg := rule.Get()
		clientIP := net.ParseIP(c.ClientIP())
		target, _, _ := rule.Match(clientIP, c.Request.Host, cfg)
		st.Record(target) // 流量统计（仅真实请求，/admin/go 等测试通道不计）
		if cfg.Log.Access {
			log.Printf("access ip=%s host=%s target=%s", c.ClientIP(), c.Request.Host, target)
		}
		c.Redirect(http.StatusFound, target)
	})
}

// registerAdmin 管理接口：admin_token 非空时校验 X-Admin-Token，留空不鉴权（本期决策）。
func registerAdmin(r *gin.Engine, rdb *redis.Client, configPath string, st *stats.Stats) {
	r.GET("/healthz", func(c *gin.Context) {
		cfg := rule.Get()
		c.JSON(http.StatusOK, gin.H{
			"status":         "ok",
			"listen":         cfg.Listen,
			"rules":          len(cfg.Rules),
			"source":         cfg.Source,
			"redis":          cfg.Redis.Addr,
			"geo":            geo.Loaded(),
			"log_level":      cfg.Log.Level,
			"rate_limit_rps": cfg.RateLimit.RPS,
		})
	})

	admin := r.Group("/admin")
	admin.Use(func(c *gin.Context) {
		if token := rule.Get().AdminToken; token != "" && c.GetHeader("X-Admin-Token") != token {
			c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"msg": "forbidden"})
			return
		}
		c.Next()
	})

	// 当前内存配置
	admin.GET("/rules", func(c *gin.Context) {
		c.JSON(http.StatusOK, rule.Get())
	})

	// 保存规则并热生效：内存替换 → 回写 yaml（必写）→ 写 Redis（尽力）
	admin.POST("/rules", func(c *gin.Context) {
		var req struct {
			DefaultTarget string      `json:"default_target"`
			Rules         []rule.Rule `json:"rules"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"msg": "bad request", "err": err.Error()})
			return
		}
		if strings.TrimSpace(req.DefaultTarget) == "" {
			c.JSON(http.StatusBadRequest, gin.H{"msg": "default_target required"})
			return
		}
		for i := range req.Rules {
			if err := req.Rules[i].Validate(); err != nil {
				c.JSON(http.StatusBadRequest, gin.H{"msg": fmt.Sprintf("rules[%d]: %v", i, err)})
				return
			}
		}

		cur := rule.Get()
		newCfg := *cur
		newCfg.DefaultTarget = req.DefaultTarget
		newCfg.Rules = req.Rules
		newCfg.Source = "admin"
		rule.Set(&newCfg)

		redisStatus := "skipped"
		if rdb != nil {
			ctx, cancel := context.WithTimeout(c.Request.Context(), 2*time.Second)
			if err := rule.SaveRulesToRedis(ctx, rdb, cur.Redis.Key, req.Rules); err != nil {
				redisStatus = "error: " + err.Error()
			} else {
				redisStatus = "ok"
			}
			cancel()
		}
		if err := rule.SaveToFile(configPath, &newCfg); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{
				"msg": "memory updated but save file failed", "err": err.Error(), "redis": redisStatus})
			return
		}
		c.JSON(http.StatusOK, gin.H{"msg": "saved and applied", "rules": len(req.Rules), "file": "ok", "redis": redisStatus})
	})

	// 手动重载：Redis 优先，失败回退本地 yaml，都失败保留旧配置不断流
	admin.POST("/reload", func(c *gin.Context) {
		cur := rule.Get()
		if rdb != nil {
			ctx, cancel := context.WithTimeout(c.Request.Context(), 2*time.Second)
			rules, err := rule.LoadRulesFromRedis(ctx, rdb, cur.Redis.Key)
			cancel()
			if err == nil {
				newCfg := *cur
				newCfg.Rules = rules
				newCfg.Source = "redis"
				rule.Set(&newCfg)
				c.JSON(http.StatusOK, gin.H{"msg": "reloaded from redis", "rules": len(rules)})
				return
			}
			log.Printf("reload from redis failed (%v), fallback to file", err)
		}
		newCfg, err := rule.LoadFromFile(configPath)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"msg": "reload failed, keep old config", "err": err.Error()})
			return
		}
		rule.Set(newCfg)
		c.JSON(http.StatusOK, gin.H{"msg": "reloaded from file", "rules": len(newCfg.Rules)})
	})

	// 规则验证工具：模拟某 IP 的匹配结果，上线前核对分流
	// ?ip=1.2.3.4                → 整链匹配
	// ?ip=1.2.3.4&host=x.com     → 整链匹配并指定接入域名
	// ?ip=1.2.3.4&rule=ID        → 只看指定规则对该 IP 的分配结果
	admin.GET("/test", func(c *gin.Context) {
		ipStr := strings.TrimSpace(c.Query("ip"))
		ip := net.ParseIP(ipStr)
		cfg := rule.Get()
		host := c.Query("host")

		if ruleID := strings.TrimSpace(c.Query("rule")); ruleID != "" {
			r, idx := rule.FindRuleByID(cfg, ruleID)
			if r == nil {
				c.JSON(http.StatusNotFound, gin.H{"msg": "rule not found: " + ruleID, "matched_rule": -1})
				return
			}
			if !r.Contains(ip) {
				c.JSON(http.StatusBadRequest, gin.H{
					"msg":          fmt.Sprintf("IP %q 不匹配规则#%d【%s·%s】", ipStr, idx+1, rule.TypeName(r.Type), r.IPCidr),
					"matched_rule": -1, "target": "",
				})
				return
			}
			target, detail := rule.MatchRule(r, ip)
			c.JSON(http.StatusOK, gin.H{"ip": ipStr, "host": host, "matched_rule": idx, "target": target, "detail": detail, "type": rule.TypeName(r.Type)})
			return
		}

		target, idx, detail := rule.Match(ip, host, cfg)
		c.JSON(http.StatusOK, gin.H{"ip": ipStr, "host": host, "matched_rule": idx, "target": target, "detail": detail})
	})

	// 流量统计：总命中、各域名命中数、最近 24 小时分布（仅真实请求计数，测试通道不计）
	admin.GET("/stats", func(c *gin.Context) {
		c.JSON(http.StatusOK, st.View())
	})

	// 统计清零
	admin.POST("/stats/reset", func(c *gin.Context) {
		st.Reset()
		_ = st.Save(filepath.Dir(configPath))
		c.JSON(http.StatusOK, gin.H{"msg": "stats reset"})
	})

	// 真实跳转测试：浏览器打开后就是一次真正的 302，能直观看到跳到哪个域名。
	// /admin/go?ip=1.2.3.4            → 按完整规则链匹配
	// /admin/go?ip=1.2.3.4&rule=rXX   → 只测指定规则（不看其他规则是否命中）
	// &count=1                        → 额外把这次命中计入流量统计（Demo 页生成演示数据用）
	admin.GET("/go", func(c *gin.Context) {
		ipStr := strings.TrimSpace(c.Query("ip"))
		ip := net.ParseIP(ipStr)
		cfg := rule.Get()

		if ruleID := strings.TrimSpace(c.Query("rule")); ruleID != "" {
			r, idx := rule.FindRuleByID(cfg, ruleID)
			if r == nil {
				c.JSON(http.StatusNotFound, gin.H{"msg": "rule not found: " + ruleID})
				return
			}
			if !r.Contains(ip) {
				c.JSON(http.StatusBadRequest, gin.H{
					"msg": fmt.Sprintf("IP %q 不匹配规则#%d【%s·%s】", ipStr, idx+1, rule.TypeName(r.Type), r.IPCidr)})
				return
			}
			target, detail := rule.MatchRule(r, ip)
			if target == "" {
				c.JSON(http.StatusBadRequest, gin.H{"msg": "该规则没有可用目标域名"})
				return
			}
			log.Printf("rule-test: ip=%s rule#%d(%s) -> %s (%s)", ipStr, idx+1, r.ID, target, detail)
			c.Redirect(http.StatusFound, target)
			return
		}

		target, _, _ := rule.Match(ip, c.Query("host"), cfg)
		if target == "" {
			c.JSON(http.StatusBadRequest, gin.H{"msg": "no target, check default_target"})
			return
		}
		if c.Query("count") == "1" {
			st.Record(target) // 演示流量打点
		}
		log.Printf("chain-test: ip=%s -> %s", ipStr, target)
		c.Redirect(http.StatusFound, target)
	})
}
