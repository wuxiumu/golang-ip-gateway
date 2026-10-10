package ratelimit

import (
	"testing"
	"time"
)

func TestDisabledAlwaysAllows(t *testing.T) {
	l := New(0, 0)
	for i := 0; i < 5; i++ {
		if !l.Allow("1.2.3.4") {
			t.Fatal("disabled limiter rejected a request")
		}
	}
}

func TestBurstThenRefill(t *testing.T) {
	l := New(1, 2)
	now := time.Unix(1_000, 0)
	l.now = func() time.Time { return now }

	if !l.Allow("10.0.0.1") || !l.Allow("10.0.0.1") {
		t.Fatal("burst of 2 should pass")
	}
	if l.Allow("10.0.0.1") {
		t.Fatal("third call should be limited")
	}
	if !l.Allow("10.0.0.2") {
		t.Fatal("other key should have its own bucket")
	}

	now = now.Add(time.Second)
	if !l.Allow("10.0.0.1") {
		t.Fatal("one token should refill after 1s at 1 rps")
	}
	if l.Allow("10.0.0.1") {
		t.Fatal("only one token should have refilled")
	}
}
