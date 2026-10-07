package stats

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"
)

// 流量命中统计：内存聚合（请求路径只做加锁自增，无 IO），定时落盘 stats.json，重启自动恢复。
// 只存聚合数据（域名计数/小时桶），不存明细 IP，规避个人信息合规问题。

const keepHours = 48 // 小时桶保留 48 小时

type Stats struct {
	mu      sync.Mutex
	total   int64
	targets map[string]int64
	hourly  map[int64]map[string]int64 // unix 小时桶 -> 域名计数
	since   time.Time                  // 本轮统计起点
}

func New() *Stats {
	return &Stats{
		targets: map[string]int64{},
		hourly:  map[int64]map[string]int64{},
		since:   time.Now(),
	}
}

// Record 记一次跳转命中（target 可能为 default_target）
func (s *Stats) Record(target string) {
	if target == "" {
		return
	}
	h := time.Now().Unix() / 3600
	s.mu.Lock()
	s.total++
	s.targets[target]++
	b := s.hourly[h]
	if b == nil {
		b = map[string]int64{}
		s.hourly[h] = b
	}
	b[target]++
	// 低频清理过期桶
	if len(s.hourly) > keepHours*2 {
		cut := h - keepHours
		for k := range s.hourly {
			if k < cut {
				delete(s.hourly, k)
			}
		}
	}
	s.mu.Unlock()
}

// Reset 清零本轮统计
func (s *Stats) Reset() {
	s.mu.Lock()
	s.total = 0
	s.targets = map[string]int64{}
	s.hourly = map[int64]map[string]int64{}
	s.since = time.Now()
	s.mu.Unlock()
}

// TargetCount 单域名命中数（导出给接口用）
type TargetCount struct {
	Target string `json:"target"`
	Count  int64  `json:"count"`
}

// HourBucket 小时桶视图
type HourBucket struct {
	Label   string           `json:"label"` // 本地时间 MM-DD HH时
	Total   int64            `json:"total"`
	Targets map[string]int64 `json:"targets"`
}

// View 生成接口视图：总数 + 域名计数（降序）+ 最近 24 小时桶（升序）
func (s *Stats) View() map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()

	targets := make([]TargetCount, 0, len(s.targets))
	for t, c := range s.targets {
		targets = append(targets, TargetCount{Target: t, Count: c})
	}
	sort.Slice(targets, func(i, j int) bool { return targets[i].Count > targets[j].Count })

	curHour := time.Now().Unix() / 3600
	hours := make([]HourBucket, 0, 24)
	for i := 23; i >= 0; i-- {
		h := curHour - int64(i)
		b := s.hourly[h]
		total := int64(0)
		m := map[string]int64{}
		for t, c := range b {
			total += c
			m[t] = c
		}
		hours = append(hours, HourBucket{
			Label:   time.Unix(h*3600, 0).Format("01-02 15时"),
			Total:   total,
			Targets: m,
		})
	}

	return map[string]any{
		"total":   s.total,
		"since":   s.since.Format("01-02 15:04"),
		"targets": targets,
		"hourly":  hours,
	}
}

// Save 落盘到 dir/stats.json（临时文件 + 原子改名）
func (s *Stats) Save(dir string) error {
	s.mu.Lock()
	snap := struct {
		Total   int64                      `json:"total"`
		Targets map[string]int64           `json:"targets"`
		Hourly  map[int64]map[string]int64 `json:"hourly"`
		Since   time.Time                  `json:"since"`
	}{s.total, s.targets, s.hourly, s.since}
	s.mu.Unlock()

	data, err := json.Marshal(snap)
	if err != nil {
		return err
	}
	final := filepath.Join(dir, "stats.json")
	tmp := final + ".tmp"
	if err := os.WriteFile(tmp, data, 0644); err != nil {
		return err
	}
	return os.Rename(tmp, final)
}

// Load 启动时恢复历史统计（文件不存在视为无历史）
func (s *Stats) Load(dir string) error {
	data, err := os.ReadFile(filepath.Join(dir, "stats.json"))
	if err != nil {
		return nil // 无历史文件不是错误
	}
	var snap struct {
		Total   int64                      `json:"total"`
		Targets map[string]int64           `json:"targets"`
		Hourly  map[int64]map[string]int64 `json:"hourly"`
		Since   time.Time                  `json:"since"`
	}
	if err := json.Unmarshal(data, &snap); err != nil {
		return nil // 坏文件忽略，从零开始
	}
	s.mu.Lock()
	s.total = snap.Total
	if snap.Targets != nil {
		s.targets = snap.Targets
	}
	if snap.Hourly != nil {
		// 只保留 48 小时内的桶
		cut := time.Now().Unix()/3600 - keepHours
		for h, b := range snap.Hourly {
			if h >= cut {
				s.hourly[h] = b
			}
		}
	}
	if !snap.Since.IsZero() {
		s.since = snap.Since
	}
	s.mu.Unlock()
	return nil
}
