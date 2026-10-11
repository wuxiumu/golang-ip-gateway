package rule

import (
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestLoadFromFileDefaults(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")
	body := []byte("default_target: https://example.com\nrules: []\n")
	if err := os.WriteFile(path, body, 0o644); err != nil {
		t.Fatal(err)
	}
	cfg, err := LoadFromFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Listen != ":8080" {
		t.Fatalf("listen=%q", cfg.Listen)
	}
	if cfg.Log.Level != "info" || cfg.Log.GinMode != "release" || cfg.Log.Access {
		t.Fatalf("log=%+v", cfg.Log)
	}
	if cfg.CORSOrigin != "*" {
		t.Fatalf("cors=%q", cfg.CORSOrigin)
	}
	if cfg.StatsFlushInterval.D() != 30*time.Second || cfg.ShutdownTimeout.D() != 5*time.Second {
		t.Fatalf("intervals flush=%s shutdown=%s", cfg.StatsFlushInterval.D(), cfg.ShutdownTimeout.D())
	}
	if cfg.Redis.DialTimeout.D() != 2*time.Second || cfg.Redis.PoolSize != 8 {
		t.Fatalf("redis=%+v", cfg.Redis)
	}
	if cfg.RateLimit.RPS != 0 {
		t.Fatalf("rate limit should stay off, rps=%v", cfg.RateLimit.RPS)
	}
}

func TestApplyEnvOverrides(t *testing.T) {
	cfg := &AppConfig{
		Listen:        ":18080",
		DefaultTarget: "https://file.example",
		AdminToken:    "",
		Redis:         RedisConfig{Addr: "127.0.0.1:6379"},
	}
	t.Setenv("IPGW_LISTEN", ":9090")
	t.Setenv("IPGW_ADMIN_TOKEN", "from-env")
	t.Setenv("IPGW_REDIS_ADDR", "redis:6379")
	t.Setenv("IPGW_REDIS_PASSWORD", "s3cret")
	t.Setenv("IPGW_LOG_ACCESS", "true")
	t.Setenv("IPGW_LOG_LEVEL", "debug")
	t.Setenv("IPGW_RATE_LIMIT_RPS", "20")
	t.Setenv("IPGW_DEFAULT_TARGET", "")
	ApplyEnv(cfg)
	ApplyDefaults(cfg)

	if cfg.Listen != ":9090" || cfg.AdminToken != "from-env" {
		t.Fatalf("listen/token = %s / %s", cfg.Listen, cfg.AdminToken)
	}
	if cfg.DefaultTarget != "https://file.example" {
		t.Fatalf("empty env should not clear default target, got %s", cfg.DefaultTarget)
	}
	if cfg.Redis.Addr != "redis:6379" || cfg.Redis.Password != "s3cret" {
		t.Fatalf("redis=%+v", cfg.Redis)
	}
	if !cfg.Log.Access || cfg.Log.Level != "debug" {
		t.Fatalf("log=%+v", cfg.Log)
	}
	if cfg.RateLimit.RPS != 20 || cfg.RateLimit.Burst != 20 {
		t.Fatalf("rate=%+v", cfg.RateLimit)
	}
}

func TestDurationYAMLRoundTrip(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")
	raw := "listen: :18080\ndefault_target: https://example.com\nstats_flush_interval: 15s\nredis:\n  dial_timeout: 3s\nrules: []\n"
	if err := os.WriteFile(path, []byte(raw), 0o644); err != nil {
		t.Fatal(err)
	}
	cfg, err := LoadFromFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.StatsFlushInterval.D() != 15*time.Second || cfg.Redis.DialTimeout.D() != 3*time.Second {
		t.Fatalf("parsed flush=%s dial=%s", cfg.StatsFlushInterval.D(), cfg.Redis.DialTimeout.D())
	}
	if err := SaveToFile(path, cfg); err != nil {
		t.Fatal(err)
	}
	out, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	text := string(out)
	if !strings.Contains(text, "15s") || !strings.Contains(text, "3s") {
		t.Fatalf("duration should stay human readable:\n%s", text)
	}
}

func TestAdminJSONOmitsSecrets(t *testing.T) {
	cfg := &AppConfig{
		AdminToken: "secret-token",
		Redis:      RedisConfig{Addr: "127.0.0.1:6379", Password: "redis-pass"},
		Log:        LogConfig{Level: "debug"},
	}
	b, err := json.Marshal(cfg)
	if err != nil {
		t.Fatal(err)
	}
	s := string(b)
	for _, hidden := range []string{"secret-token", "redis-pass", "password", "admin_token"} {
		if strings.Contains(s, hidden) {
			t.Fatalf("json leaked %q: %s", hidden, s)
		}
	}
}

func TestMatchBasicCIDR(t *testing.T) {
	cfg := &AppConfig{
		DefaultTarget: "https://default.example.com",
		Rules: []Rule{{
			Type:   TypeBasic,
			IPCidr: "192.168.1.0/24",
			Target: "https://a.example.com",
			Enable: true,
		}},
	}
	Set(cfg)
	target, idx, _ := Match(net.ParseIP("192.168.1.10"), "", Get())
	if target != "https://a.example.com" || idx != 0 {
		t.Fatalf("target=%s idx=%d", target, idx)
	}
	target, idx, _ = Match(net.ParseIP("8.8.8.8"), "", Get())
	if target != "https://default.example.com" || idx != -1 {
		t.Fatalf("default target=%s idx=%d", target, idx)
	}
}
