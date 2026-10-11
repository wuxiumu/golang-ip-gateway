// Package ratelimit 是按 key 的内存令牌桶。RPS <= 0 时 Allow 恒为 true，不改变原有请求路径。
package ratelimit

import (
	"sync"
	"time"
)

type bucket struct {
	tokens float64
	last   time.Time
}

// Limiter 进程内限流器。不持久化，重启即清空。
type Limiter struct {
	rps   float64
	burst float64
	mu    sync.Mutex
	items map[string]*bucket
	now   func() time.Time
}

// New 创建限流器。rps <= 0 表示关闭。burst <= 0 时与 rps 相同。
func New(rps, burst float64) *Limiter {
	if rps > 0 && burst <= 0 {
		burst = rps
	}
	return &Limiter{
		rps:   rps,
		burst: burst,
		items: map[string]*bucket{},
		now:   time.Now,
	}
}

// Enabled 报告限流是否生效。
func (l *Limiter) Enabled() bool {
	return l != nil && l.rps > 0
}

// Allow 消耗 1 个令牌。关闭时直接放行。
func (l *Limiter) Allow(key string) bool {
	if !l.Enabled() {
		return true
	}
	now := l.now()
	l.mu.Lock()
	defer l.mu.Unlock()

	b := l.items[key]
	if b == nil {
		b = &bucket{tokens: l.burst, last: now}
		l.items[key] = b
	} else {
		elapsed := now.Sub(b.last).Seconds()
		if elapsed > 0 {
			b.tokens += elapsed * l.rps
			if b.tokens > l.burst {
				b.tokens = l.burst
			}
			b.last = now
		}
	}
	if len(l.items) > 4096 {
		cutoff := now.Add(-2 * time.Minute)
		for k, item := range l.items {
			if item.last.Before(cutoff) {
				delete(l.items, k)
			}
		}
	}
	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}
