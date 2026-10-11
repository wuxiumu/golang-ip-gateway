package rule

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

// Duration 在 yaml 里写成 30s / 2s，避免 time.Duration 落盘成纳秒整数。
type Duration time.Duration

func (d Duration) MarshalYAML() (any, error) {
	return time.Duration(d).String(), nil
}

func (d *Duration) UnmarshalYAML(value *yaml.Node) error {
	if value == nil || value.Tag == "!!null" {
		*d = 0
		return nil
	}
	if value.Tag == "!!int" {
		n, err := strconv.ParseInt(strings.TrimSpace(value.Value), 10, 64)
		if err != nil {
			return err
		}
		*d = Duration(n)
		return nil
	}
	s := strings.TrimSpace(value.Value)
	if s == "" || s == "0" || s == "~" || s == "null" {
		*d = 0
		return nil
	}
	parsed, err := time.ParseDuration(s)
	if err != nil {
		return fmt.Errorf("invalid duration %q: %w", s, err)
	}
	*d = Duration(parsed)
	return nil
}

func (d Duration) D() time.Duration { return time.Duration(d) }

// ApplyDefaults 补齐未写的运行参数。已有值保持不变，因此零值限流仍然是关闭。
func ApplyDefaults(cfg *AppConfig) {
	if cfg.Listen == "" {
		cfg.Listen = ":8080"
	}
	if cfg.CORSOrigin == "" {
		cfg.CORSOrigin = "*"
	}
	if cfg.Log.Level == "" {
		cfg.Log.Level = "info"
	}
	cfg.Log.Level = strings.ToLower(cfg.Log.Level)
	if cfg.Log.GinMode == "" {
		cfg.Log.GinMode = "release"
	}
	cfg.Log.GinMode = strings.ToLower(cfg.Log.GinMode)
	if cfg.StatsFlushInterval == 0 {
		cfg.StatsFlushInterval = Duration(30 * time.Second)
	}
	if cfg.ShutdownTimeout == 0 {
		cfg.ShutdownTimeout = Duration(5 * time.Second)
	}
	if cfg.Redis.DialTimeout == 0 {
		cfg.Redis.DialTimeout = Duration(2 * time.Second)
	}
	if cfg.Redis.ReadTimeout == 0 {
		cfg.Redis.ReadTimeout = Duration(time.Second)
	}
	if cfg.Redis.WriteTimeout == 0 {
		cfg.Redis.WriteTimeout = Duration(time.Second)
	}
	if cfg.Redis.PoolSize == 0 {
		cfg.Redis.PoolSize = 8
	}
	if cfg.RateLimit.RPS > 0 && cfg.RateLimit.Burst <= 0 {
		cfg.RateLimit.Burst = cfg.RateLimit.RPS
	}
}

// ApplyEnv 用环境变量覆盖 yaml。空字符串不覆盖，便于 Docker 只注入令牌和 Redis 密码。
func ApplyEnv(cfg *AppConfig) {
	set := func(key string, apply func(string)) {
		v, ok := os.LookupEnv(key)
		if !ok {
			return
		}
		v = strings.TrimSpace(v)
		if v == "" {
			return
		}
		apply(v)
	}
	set("IPGW_LISTEN", func(v string) { cfg.Listen = v })
	set("IPGW_ADMIN_TOKEN", func(v string) { cfg.AdminToken = v })
	set("IPGW_DEFAULT_TARGET", func(v string) { cfg.DefaultTarget = v })
	set("IPGW_CORS_ORIGIN", func(v string) { cfg.CORSOrigin = v })
	set("IPGW_REDIS_ADDR", func(v string) { cfg.Redis.Addr = v })
	set("IPGW_REDIS_PASSWORD", func(v string) { cfg.Redis.Password = v })
	set("IPGW_REDIS_KEY", func(v string) { cfg.Redis.Key = v })
	set("IPGW_REDIS_DB", func(v string) {
		n, err := strconv.Atoi(v)
		if err == nil {
			cfg.Redis.DB = n
		}
	})
	set("IPGW_LOG_LEVEL", func(v string) { cfg.Log.Level = strings.ToLower(v) })
	set("IPGW_GIN_MODE", func(v string) { cfg.Log.GinMode = strings.ToLower(v) })
	set("IPGW_LOG_ACCESS", func(v string) {
		cfg.Log.Access = v == "1" || strings.EqualFold(v, "true") || strings.EqualFold(v, "yes")
	})
	set("IPGW_RATE_LIMIT_RPS", func(v string) {
		n, err := strconv.ParseFloat(v, 64)
		if err == nil {
			cfg.RateLimit.RPS = n
		}
	})
	set("IPGW_RATE_LIMIT_BURST", func(v string) {
		n, err := strconv.ParseFloat(v, 64)
		if err == nil {
			cfg.RateLimit.Burst = n
		}
	})
}
