package redisclient

import (
	"time"

	"github.com/redis/go-redis/v9"

	"ip-gateway/internal/rule"
)

// New 按配置创建 redis 客户端。超时和连接池来自配置，未写时使用与原先相同的短超时。
func New(cfg rule.RedisConfig) *redis.Client {
	dial := cfg.DialTimeout.D()
	read := cfg.ReadTimeout.D()
	write := cfg.WriteTimeout.D()
	pool := cfg.PoolSize
	if dial == 0 {
		dial = 2 * time.Second
	}
	if read == 0 {
		read = time.Second
	}
	if write == 0 {
		write = time.Second
	}
	if pool == 0 {
		pool = 8
	}
	return redis.NewClient(&redis.Options{
		Addr:         cfg.Addr,
		Password:     cfg.Password,
		DB:           cfg.DB,
		DialTimeout:  dial,
		ReadTimeout:  read,
		WriteTimeout: write,
		PoolSize:     pool,
	})
}
