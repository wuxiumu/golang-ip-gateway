package redisclient

import (
	"time"

	"github.com/redis/go-redis/v9"

	"ip-gateway/internal/rule"
)

// New 按配置创建 redis 客户端；短超时配置，故障时快速失败走降级路径。
func New(cfg rule.RedisConfig) *redis.Client {
	return redis.NewClient(&redis.Options{
		Addr:         cfg.Addr,
		Password:     cfg.Password,
		DB:           cfg.DB,
		DialTimeout:  2 * time.Second,
		ReadTimeout:  1 * time.Second,
		WriteTimeout: 1 * time.Second,
		PoolSize:     8,
	})
}
