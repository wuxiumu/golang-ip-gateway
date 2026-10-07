Go IP分流网关方案

需求：

1. Go实现流量入口，HTTP请求按IP做302跳转

2. Redis优先读取规则，Redis挂了本地配置文件兜底

3. 前期简单IP/IP段 → 域名映射；预留复杂规则扩展（后续可加国家、UA、请求路径、时间、权重、灰度等）

4. 不需要MySQL，配置：Redis + yaml本地兜底文件

5. 追求快速上线，高性能，规则内存常驻，热加载，不用重启服务

6. 支持后台简单触发刷新配置接口，不用重启程序

7. 2核2G机器，充分利用多核；拒绝每次请求查Redis/文件，规则全放内存
核心设计要点：

• 业务规则常驻内存，请求路径完全不走IO；Redis/文件只做配置源。

• 启动时：优先加载Redis规则；Redis不可用自动降级读取本地yaml兜底文件。

• 提供管理接口手动刷新内存规则；后续可以套简易后台调用这个接口。

• 结构体全部预留扩展字段，后期加复杂条件不用大改现有逻辑。
项目结构
ip‑gateway/
├── config.yaml        # 兜底本地配置文件
├── go.mod
├── go.sum
├── main.go
├── internal
│   ├── rule           # 规则定义、加载、ip匹配
│   │   └── rule.go
│   └── redisclient    # redis封装，带断线容错
│       └── redis.go
└── systemd.service    # 部署脚本
go.mod
module ip‑gateway

go 1.23

require (
	github.com/gin‑gonic/gin v1.10.0
	github.com/go‑redis/redis/v9 v9.0.5
	gopkg.in/yaml.v3 v3.0.1
	net v0.27.0
)
config.yaml（本地兜底配置）
# ip分流兜底配置，redis挂掉自动加载这个
rules:
  - ip_cidr: "192.168.1.0/24"
    target: "https://a.example.com"
    enable: true
    # 预留扩展字段，后面复杂规则直接加在这里
    weight: 100
    ua_contains: ""
    path_prefix: ""
    country: ""
    remark: "内网A组"

  - ip_cidr: "10.0.0.0/8"
    target: "https://b.example.com"
    enable: true
    weight: 100
    ua_contains: ""
    path_prefix: ""
    country: ""
    remark: "内网B组"

default_target: "https://default.example.com"
redis_key: "ip_gateway:rules"
listen: ":8080"
admin_token: "your‑secret‑admin‑123456" # 管理接口鉴权token
internal/rule/rule.go
package rule

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"sync"

	"github.com/go‑redis/redis/v9"
	"gopkg.in/yaml.v3"
)

// Rule 【重点：全部预留扩展字段，后续复杂条件直接扩展结构体，不改动主流程】
type Rule struct {
	IPCidr     string `json:"ip_cidr" yaml:"ip_cidr"`
	Target     string `json:"target" yaml:"target"`
	Enable     bool   `json:"enable" yaml:"enable"`
	Weight     int    `json:"weight" yaml:"weight"`
	UAContains string `json:"ua_contains" yaml:"ua_contains"`
	PathPrefix string `json:"path_prefix" yaml:"path_prefix"`
	Country    string `json:"country" yaml:"country"`
	Remark     string `json:"remark" yaml:"remark"`

	netIPNet *net.IPNet // 预编译CIDR，匹配的时候直接用，不要每次解析字符串
}

type AppConfig struct {
	Rules         []Rule `yaml:"rules"`
	DefaultTarget string `yaml:"default_target"`
	RedisKey      string `yaml:"redis_key"`
	Listen        string `yaml:"listen"`
	AdminToken    string `yaml:"admin_token"`
}

// 全局内存缓存，所有http请求只读这个，无锁读；更新时整体替换指针
var (
	globalConfig *AppConfig
	mu           sync.RWMutex
)

// GetGlobalConfig 读配置，请求路径调用，RWMutex读锁，性能极高
func GetGlobalConfig() *AppConfig {
	mu.RLock()
	defer mu.RUnlock()
	return globalConfig
}

// SetGlobalConfig 原子替换内存配置
func SetGlobalConfig(cfg *AppConfig) {
	// 预编译所有cidr，提前解析IP网段，请求阶段不再做字符串解析
	for i := range cfg.Rules {
		_, ipNet, err := net.ParseCIDR(cfg.Rules[i].IPCidr)
		if err == nil {
			cfg.Rules[i].netIPNet = ipNet
		}
	}
	mu.Lock()
	globalConfig = cfg
	mu.Unlock()
}

// LoadFromFile 从yaml文件加载兜底配置
func LoadFromFile(filePath string) (*AppConfig, error) {
	data, err := os.ReadFile(filePath)
	if err != nil {
		return nil, err
	}
	var cfg AppConfig
	if err := yaml.Unmarshal(data, &cfg); err != nil {
		return nil, err
	}
	return &cfg, nil
}

// LoadFromRedis 从redis加载配置；redis存json数组
func LoadFromRedis(ctx context.Context, rdb *redis.Client, redisKey string) (*AppConfig, error) {
	val, err := rdb.Get(ctx, redisKey).Result()
	if err != nil {
		return nil, err
	}
	var rules []Rule
	if err := json.Unmarshal([]byte(val), &rules); err != nil {
		return nil, err
	}
	cfg := GetGlobalConfig()
	newCfg := &AppConfig{
		Rules:         rules,
		DefaultTarget: cfg.DefaultTarget,
		RedisKey:      cfg.RedisKey,
		Listen:        cfg.Listen,
		AdminToken:    cfg.AdminToken,
	}
	return newCfg, nil
}

// MatchIP 核心匹配逻辑，后期这里叠加UA、path、国家、权重、灰度逻辑
func MatchIP(clientIP net.IP, cfg *AppConfig) string {
	for _, r := range cfg.Rules {
		if !r.Enable {
			continue
		}
		if r.netIPNet != nil && r.netIPNet.Contains(clientIP) {
			// =========未来扩展点=========
			// 在这里追加规则判断：UA匹配、path前缀、国家、时间、权重分流、多目标随机
			// if r.UAContains != "" && !strings.Contains(userAgent, r.UAContains) continue
			// if r.PathPrefix != "" && !strings.HasPrefix(reqPath, r.PathPrefix) continue
			return r.Target
		}
	}
	return cfg.DefaultTarget
}
internal/redisclient/redis.go
package redisclient

import (
	"context"
	"time"

	"github.com/go‑redis/redis/v9"
)

func NewRedisClient(addr string, password string, db int) *redis.Client {
	rdb := redis.NewClient(&redis.Options{
		Addr:         addr,
		Password:     password,
		DB:           db,
		DialTimeout:  2 * time.Second,
		ReadTimeout:  1 * time.Second,
		WriteTimeout: 1 * time.Second,
		PoolSize:     8,
	})
	ctx, cancel := context.WithTimeout(context.Background(), time.Second*2)
	defer cancel()
	_ = rdb.Ping(ctx).Err()
	return rdb
}
main.go
package main

import (
	"context"
	"net"
	"net/http"
	"os"

	"github.com/gin‑gonic/gin"
	"ip‑gateway/internal/redisclient"
	"ip‑gateway/internal/rule"
)

const configFile = "./config.yaml"

func main() {
	// 第一步：先加载本地兜底配置到内存
	baseCfg, err := rule.LoadFromFile(configFile)
	if err != nil {
		panic("load config.yaml fail:" + err.Error())
	}
	rule.SetGlobalConfig(baseCfg)

	// 初始化redis
	rdb := redisclient.NewRedisClient("127.0.0.1:6379", "", 0)
	ctx := context.Background()

	// 尝试加载redis；失败自动保留文件兜底配置
	redisCfg, err := rule.LoadFromRedis(ctx, rdb, baseCfg.RedisKey)
	if err == nil {
		rule.SetGlobalConfig(redisCfg)
		println("success load rules from redis")
	} else {
		println("redis load fail, use file config as fallback, err:", err.Error())
	}

	gin.SetMode(gin.ReleaseMode)
	r := gin.New()
	r.Use(gin.Recovery())

	// 管理接口：手动刷新配置；redis崩会自动切回文件配置；需要header鉴权
	// curl -H "X‑Admin‑Token: your‑secret‑admin‑123456" http://127.0.0.1:8080/admin/reload
	r.GET("/admin/reload", func(c *gin.Context) {
		token := c.GetHeader("X‑Admin‑Token")
		cfg := rule.GetGlobalConfig()
		if token != cfg.AdminToken {
			c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"msg": "forbidden"})
			return
		}
		newCfg, err := rule.LoadFromRedis(ctx, rdb, cfg.RedisKey)
		if err != nil {
			// Redis异常，降级读取本地文件
			println("reload redis failed, fallback to local file")
			newCfg, err = rule.LoadFromFile(configFile)
			if err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"msg": "reload fail, keep old config", "err": err.Error()})
				return
			}
		}
		rule.SetGlobalConfig(newCfg)
		c.JSON(http.StatusOK, gin.H{"msg": "reload success"})
	})

	// 核心分流入口：所有其他请求进入IP匹配跳转
	r.NoRoute(func(c *gin.Context) {
		cfg := rule.GetGlobalConfig()
		clientIPStr := c.ClientIP()
		clientIP := net.ParseIP(clientIPStr)
		var target string
		if clientIP == nil {
			target = cfg.DefaultTarget
		} else {
			target = rule.MatchIP(clientIP, cfg)
		}
		c.Redirect(http.StatusFound, target) //302临时跳转
	})

	println("gateway listen on", cfg.Listen)
	if err := r.Run(cfg.Listen); err != nil {
		os.Exit(1)
	}
}
运行逻辑流程

1. 程序启动

◦ 第一步读取本地config.yaml兜底配置写入内存。

◦ 尝试读取Redis key ip_gateway:rules JSON规则。

◦ Redis正常：内存替换为Redis的规则。

◦ Redis连接失败/key不存在：保留本地yaml配置兜底，程序正常启动，不崩溃。

2. 线上更新规则
Redis中写入json数组规则示例：
[
  {"ip_cidr":"223.5.5.0/24","target":"https://a1.example.com","enable":true,"weight":100}
]
写入redis key ip_gateway:rules。
调用管理接口刷新内存：
curl -H "X‑Admin‑Token: your‑secret‑admin‑123456" http://127.0.0.1:8080/admin/reload
⚠️刷新接口只是更新内存规则，不需要重启go程序。
3. Redis故障场景

• Redis宕机，调用/admin/reload会自动fallback加载本地config.yaml，网关继续工作，不会断流。

• 业务HTTP请求全程完全不碰Redis和磁盘，全部读内存，性能拉满，可以把CPU吃满。

4. 后续扩展复杂规则（不用大改架构）
在MatchIP函数直接加条件：

• UA匹配、path路径匹配

• 国家IP库（maxmind）

• 权重随机多目标域名

• 时间窗口、灰度、黑名单、白名单
结构体Rule已经预留字段，只需要业务判断，http主流程不变。

部署要点（2核2G服务器）

1. 编译
CGO_ENABLED=0 go build -o ip‑gateway main.go
输出单二进制，上传服务器直接运行。

2. systemd托管，开机自启。
[Unit]
Description=ip‑gateway
After=network.target

[Service]
WorkingDirectory=/opt/ip‑gateway
ExecStart=/opt/ip‑gateway/ip‑gateway
Restart=always
RestartSec=3
LimitNOFILE=65535

[Install]
WantedBy=multi‑user.target
LimitNOFILE=65535调高文件句柄，高并发流量必备。
3. 真实IP问题
如果前面有LB/云负载均衡，gin c.ClientIP() 需要配置信任代理：
// main.go增加，设置信任的代理IP段
_ = r.SetTrustedProxies([]string{"127.0.0.1","10.0.0.0/8"})
否则拿到的IP是负载均衡的内网IP，分流全部错乱。

Redis写入规则小提示

你后台管理程序，直接把规则序列化为JSON set到redis ip_gateway:rules；然后HTTP调用/admin/reload网关就生效。
网关不会主动轮询Redis，由外部管理侧触发reload，避免频繁redis请求；你如果想要自动定时刷新，可以加个time.Ticker定时调用reload逻辑。
关键风险点

1. 所有请求不走redis、不走磁盘，全部内存；redis仅作为配置存储源。

2. Redis挂了，网关还能依靠本地yaml继续跑流量，实现降级兜底。

3. CIDR网段在加载配置阶段预解析，请求路径不会做字符串解析，性能极高。

4. admin接口必须强token鉴权，不能暴露公网无保护。

如果你需要，我可以给你：

1. 定时自动reload版本代码；

2. 增加maxmind国家地域匹配示例；

3. 简单前端html管理页面直接内嵌进go二进制，不用单独部署前端。