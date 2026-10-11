package rule

import (
	"context"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"hash/fnv"
	"math/big"
	"net"
	"os"
	"strings"
	"sync"

	"github.com/redis/go-redis/v9"
	"gopkg.in/yaml.v3"
)

// 规则分类：选中哪类就按哪类的逻辑匹配
const (
	TypeBasic   = "basic"   // 基础：固定一个域名
	TypeRandom  = "random"  // 随机固定：IP 按哈希随机分到一个域名，之后永久固定
	TypeSegment = "segment" // 分段固定：IP 段按域名数量均分，每段固定一个域名
	TypeRegion  = "region"  // 区域分流：IP 归属地命中关键词（国家/省/市/运营商）→ 固定域名
)

// NormalizeType 兼容旧数据：空 type 一律按基础规则处理
func NormalizeType(t string) string {
	switch t {
	case TypeRandom, TypeSegment, TypeRegion:
		return t
	default:
		return TypeBasic
	}
}

// TypeName 分类的中文名，用于接口提示信息
func TypeName(t string) string {
	switch NormalizeType(t) {
	case TypeRandom:
		return "随机固定"
	case TypeSegment:
		return "分段固定"
	case TypeRegion:
		return "区域分流"
	default:
		return "基础"
	}
}

// RegionLookup 归属地查询函数，由 main 注入（internal/geo）；
// 返回如「中国|0|广东省|深圳市|电信」，未注入或查询失败返回空。
var RegionLookup func(ip net.IP) string

// RuleID 由规则内容生成稳定 ID：内容相同 → ID 相同。
// Set 加载时为缺 ID 的旧规则补齐，保存后持久化，从此不再变化（改内容不影响已保存的 ID）。
func RuleID(r *Rule) string {
	h := fnv.New32a()
	_, _ = h.Write([]byte(r.Type))
	_, _ = h.Write([]byte{0})
	_, _ = h.Write([]byte(r.Country))
	_, _ = h.Write([]byte{0})
	_, _ = h.Write([]byte(r.IPCidr))
	_, _ = h.Write([]byte{0})
	_, _ = h.Write([]byte(r.Target))
	for _, t := range r.Targets {
		_, _ = h.Write([]byte{1})
		_, _ = h.Write([]byte(t))
	}
	return "r" + hex.EncodeToString(h.Sum(nil))
}

// Rule 分流规则；weight/ua_contains/path_prefix/country 为预留字段，本期不参与匹配，
// 后续扩展在 Match 中叠加条件即可，不动主流程。
type Rule struct {
	ID         string   `json:"id,omitempty" yaml:"id,omitempty"`     // 规则稳定 ID，供 /admin/go 单规则测试定位
	Type       string   `json:"type" yaml:"type"`                     // basic / random / segment，空视为 basic
	Host       string   `json:"host,omitempty" yaml:"host,omitempty"` // 接入域名（可选）：空=所有域名；支持 *.example.com 通配
	IPCidr     string   `json:"ip_cidr" yaml:"ip_cidr"`
	Target     string   `json:"target" yaml:"target"`                       // basic 用
	Targets    []string `json:"targets,omitempty" yaml:"targets,omitempty"` // random / segment 用
	Weights    []int    `json:"weights,omitempty" yaml:"weights,omitempty"` // random 用：与 targets 对齐的权重，全 0/缺省 = 平均
	Enable     bool     `json:"enable" yaml:"enable"`
	Weight     int      `json:"weight" yaml:"weight"`
	UAContains string   `json:"ua_contains" yaml:"ua_contains"`
	PathPrefix string   `json:"path_prefix" yaml:"path_prefix"`
	Country    string   `json:"country" yaml:"country"`
	Remark     string   `json:"remark" yaml:"remark"`

	netIPNet *net.IPNet // 加载阶段预编译的 CIDR，请求路径不再解析字符串
}

// Contains 判断 IP 是否落在本规则的网段内（网段无效或 IP 为空时恒为 false）
func (r *Rule) Contains(ip net.IP) bool {
	return r.netIPNet != nil && ip != nil && r.netIPNet.Contains(ip)
}

// TargetList 统一取候选域名列表：random/segment 用 targets；兼容只有 target 的旧规则
func (r *Rule) TargetList() []string {
	if len(r.Targets) > 0 {
		return r.Targets
	}
	if strings.TrimSpace(r.Target) != "" && NormalizeType(r.Type) != TypeBasic {
		return []string{r.Target}
	}
	return nil
}

// Validate 保存前校验单条规则
func (r *Rule) Validate() error {
	// 区域分流：不需要网段，需要归属地关键词 + 目标域名
	if NormalizeType(r.Type) == TypeRegion {
		if strings.TrimSpace(r.Country) == "" {
			return fmt.Errorf("region keyword required")
		}
		if strings.TrimSpace(r.Target) == "" {
			return fmt.Errorf("target required")
		}
		return nil
	}
	if _, err := ParseCIDROrIP(r.IPCidr); err != nil {
		return err
	}
	switch NormalizeType(r.Type) {
	case TypeBasic:
		if strings.TrimSpace(r.Target) == "" {
			return fmt.Errorf("target required")
		}
	default:
		if len(r.TargetList()) == 0 {
			return fmt.Errorf("at least 1 target required")
		}
		for _, t := range r.TargetList() {
			if strings.TrimSpace(t) == "" {
				return fmt.Errorf("targets contain empty domain")
			}
		}
	}
	return nil
}

type RedisConfig struct {
	Addr         string   `json:"addr" yaml:"addr"`
	Password     string   `json:"-" yaml:"password"` // 不从管理接口回显
	DB           int      `json:"db" yaml:"db"`
	Key          string   `json:"key" yaml:"key"`
	DialTimeout  Duration `json:"-" yaml:"dial_timeout,omitempty"`
	ReadTimeout  Duration `json:"-" yaml:"read_timeout,omitempty"`
	WriteTimeout Duration `json:"-" yaml:"write_timeout,omitempty"`
	PoolSize     int      `json:"-" yaml:"pool_size,omitempty"`
}

// LogConfig 进程日志。Access 为 false 时请求路径不打访问日志（默认，与原先一致）。
type LogConfig struct {
	Level   string `json:"-" yaml:"level,omitempty"`    // info | debug
	Access  bool   `json:"-" yaml:"access,omitempty"`   // true 时记录每次 302
	GinMode string `json:"-" yaml:"gin_mode,omitempty"` // release | debug | test
}

// RateLimitConfig 按客户端 IP 的令牌桶。RPS <= 0 表示关闭。
type RateLimitConfig struct {
	RPS   float64 `json:"-" yaml:"rps,omitempty"`
	Burst float64 `json:"-" yaml:"burst,omitempty"`
}

// AppConfig 全局配置。Source 标记当前内存规则的来源（file/redis/admin），
// 仅用于 admin 接口展示，不落盘。
type AppConfig struct {
	Listen             string          `json:"listen" yaml:"listen"`
	DefaultTarget      string          `json:"default_target" yaml:"default_target"`
	AdminToken         string          `json:"-" yaml:"admin_token"`
	CORSOrigin         string          `json:"-" yaml:"cors_origin,omitempty"`
	Log                LogConfig       `json:"-" yaml:"log,omitempty"`
	RateLimit          RateLimitConfig `json:"-" yaml:"rate_limit,omitempty"`
	StatsFlushInterval Duration        `json:"-" yaml:"stats_flush_interval,omitempty"`
	ShutdownTimeout    Duration        `json:"-" yaml:"shutdown_timeout,omitempty"`
	TrustedProxies     []string        `json:"-" yaml:"trusted_proxies"`
	Redis              RedisConfig     `json:"redis" yaml:"redis"`
	Rules              []Rule          `json:"rules" yaml:"rules"`
	Source             string          `json:"source,omitempty" yaml:"-"`
}

// 内存配置：请求路径 RLock 读指针，更新时整体替换，无空窗。
var (
	mu     sync.RWMutex
	global *AppConfig
)

// Get 返回当前内存配置快照（指针只读，禁止外部修改其字段）。
func Get() *AppConfig {
	mu.RLock()
	defer mu.RUnlock()
	return global
}

// Set 预编译全部 CIDR、规范化 Host、补齐规则 ID 后原子替换内存配置。
func Set(cfg *AppConfig) {
	for i := range cfg.Rules {
		cfg.Rules[i].Host = strings.ToLower(strings.TrimSpace(cfg.Rules[i].Host))
		if cfg.Rules[i].ID == "" {
			cfg.Rules[i].ID = RuleID(&cfg.Rules[i])
		}
		ipNet, err := ParseCIDROrIP(cfg.Rules[i].IPCidr)
		if err == nil {
			cfg.Rules[i].netIPNet = ipNet
		} else {
			cfg.Rules[i].netIPNet = nil // 无效网段不参与匹配，避免单条脏数据影响启动
		}
	}
	mu.Lock()
	global = cfg
	mu.Unlock()
}

// FindRuleByID 按 ID 查找规则（供单规则测试 /admin/go 使用）
func FindRuleByID(cfg *AppConfig, id string) (*Rule, int) {
	for i := range cfg.Rules {
		if cfg.Rules[i].ID == id {
			return &cfg.Rules[i], i
		}
	}
	return nil, -1
}

// ParseCIDROrIP 同时支持 CIDR 网段（1.2.3.0/24）与单 IP（1.2.3.4 等价 /32）。
func ParseCIDROrIP(s string) (*net.IPNet, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil, fmt.Errorf("empty ip_cidr")
	}
	if strings.Contains(s, "/") {
		_, ipNet, err := net.ParseCIDR(s)
		if err != nil {
			return nil, fmt.Errorf("invalid cidr %q: %w", s, err)
		}
		return ipNet, nil
	}
	ip := net.ParseIP(s)
	if ip == nil {
		return nil, fmt.Errorf("invalid ip %q", s)
	}
	bits := 32
	if ip.To4() == nil {
		bits = 128
	}
	return &net.IPNet{IP: ip, Mask: net.CIDRMask(bits, bits)}, nil
}

// MatchRule 评估单条规则对某个 IP 的结果，返回命中目标与说明。
// 供整链 Match 与单规则测试 /admin/go 复用；未命中返回空串。
func MatchRule(r *Rule, ip net.IP) (target string, detail string) {
	switch NormalizeType(r.Type) {
	case TypeRegion:
		kw := strings.TrimSpace(r.Country)
		if kw == "" || r.Target == "" || RegionLookup == nil {
			return "", ""
		}
		region := RegionLookup(ip)
		if region == "" {
			return "", ""
		}
		if strings.Contains(region, kw) {
			return r.Target, fmt.Sprintf("区域分流：归属地 [%s] 命中「%s」", region, kw)
		}
		return "", ""
	case TypeRandom:
		list := r.TargetList()
		if len(list) == 0 {
			return "", ""
		}
		ws := normalizeWeights(r.Weights, len(list))
		// 纯哈希分配：同一 IP 永远得到同一结果，不落库、重启/重载不变形
		idx := stickyIndexW(ip, r.IPCidr, ws)
		detail := fmt.Sprintf("随机固定：IP哈希 → 第 %d 个域名（共 %d 个候选）", idx+1, len(list))
		if !allEqual(ws) {
			detail = fmt.Sprintf("随机固定：按权重 %v 加权分配 → 第 %d 个域名", ws, idx+1)
		}
		return list[idx], detail
	case TypeSegment:
		list := r.TargetList()
		if len(list) == 0 {
			return "", ""
		}
		idx := segmentIndex(ip, r.netIPNet, len(list))
		return list[idx], fmt.Sprintf("分段固定：第 %d 段 / 共 %d 段", idx+1, len(list))
	default: // basic
		if r.Target == "" {
			return "", ""
		}
		return r.Target, "基础规则：固定域名"
	}
}

// matchHost 接入域名匹配：规则未配置 host 时匹配所有请求域名
func matchHost(ruleHost, reqHost string) bool {
	if ruleHost == "" {
		return true
	}
	if reqHost == "" {
		return false
	}
	if ruleHost == reqHost {
		return true
	}
	// 通配：*.example.com 匹配任意子域（不含自身）
	if strings.HasPrefix(ruleHost, "*.") && strings.HasSuffix(reqHost, ruleHost[1:]) {
		return true
	}
	return false
}

// normalizeReqHost 请求域名小写化并去掉端口
func normalizeReqHost(host string) string {
	host = strings.ToLower(strings.TrimSpace(host))
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	}
	return strings.Trim(host, "[]")
}

// Match 核心匹配：按数组顺序返回第一条命中规则；未命中或 IP 无效返回默认目标。
// host 为请求的接入域名（Host 头，可空）。
// detail 返回命中过程说明，供 /admin/test 展示。
// 后续复杂条件（UA/path/国家/权重/灰度）在循环体内追加判断。
func Match(ip net.IP, host string, cfg *AppConfig) (target string, ruleIndex int, detail string) {
	reqHost := normalizeReqHost(host)
	if ip != nil {
		for i := range cfg.Rules {
			r := &cfg.Rules[i]
			if !r.Enable {
				continue
			}
			if !matchHost(r.Host, reqHost) {
				continue
			}
			// 区域规则不需要网段，归属地关键词命中即可
			if NormalizeType(r.Type) == TypeRegion {
				if t, d := MatchRule(r, ip); t != "" {
					return t, i, d
				}
				continue
			}
			if r.netIPNet == nil {
				continue
			}
			if !r.netIPNet.Contains(ip) {
				continue
			}
			// ====== 未来扩展点：UA、path 前缀、时间窗口、灰度 ======
			if t, d := MatchRule(r, ip); t != "" {
				return t, i, d
			}
		}
	}
	return cfg.DefaultTarget, -1, "未命中规则 → 默认目标"
}

// normalizeWeights 把权重数组对齐到 n 个域名：长度不符 → 全 1（平均）；全 0 → 全 1；负数按 0（不参与）
func normalizeWeights(weights []int, n int) []int {
	ws := make([]int, n)
	for i := range ws {
		ws[i] = 1
	}
	if len(weights) != n {
		return ws
	}
	copy(ws, weights)
	total := 0
	for _, w := range ws {
		if w > 0 {
			total += w
		}
	}
	if total == 0 {
		for i := range ws {
			ws[i] = 1
		}
		return ws
	}
	for i := range ws {
		if ws[i] < 0 {
			ws[i] = 0
		}
	}
	return ws
}

func allEqual(ws []int) bool {
	for _, w := range ws {
		if w != ws[0] {
			return false
		}
	}
	return true
}

// fnvHash 同一 IP + 同一 salt → 稳定哈希
func fnvHash(ip net.IP, salt string) uint32 {
	h := fnv.New32a()
	_, _ = h.Write([]byte(salt))
	_, _ = h.Write([]byte{0})
	_, _ = h.Write([]byte(ip.String()))
	return h.Sum32()
}

// stickyIndexW 同一 IP + 同一规则 → 固定同一个下标。
// 等权时退化为取模（兼容历史分配）；带权重时按累计权重边界落位。
func stickyIndexW(ip net.IP, salt string, ws []int) int {
	h := fnvHash(ip, salt)
	if allEqual(ws) {
		return int(h % uint32(len(ws)))
	}
	total := 0
	for _, w := range ws {
		total += w
	}
	pos := int(h % uint32(total))
	acc := 0
	for i, w := range ws {
		acc += w
		if pos < acc {
			return i
		}
	}
	return len(ws) - 1
}

// segmentIndex 把网段按 n 个域名均分，返回 ip 所在段下标；末段包含除不尽的余数
func segmentIndex(ip net.IP, ipNet *net.IPNet, n int) int {
	if n <= 1 {
		return 0
	}
	ones, bits := ipNet.Mask.Size()
	// IPv4 快路径
	if ip4 := ip.To4(); ip4 != nil && bits == 32 {
		base := binary.BigEndian.Uint32(ipNet.IP.To4())
		off := uint64(binary.BigEndian.Uint32(ip4) - base) // Contains 已保证不回绕
		segLen := (uint64(1) << uint(32-ones)) / uint64(n)
		if segLen == 0 {
			segLen = 1
		}
		idx := off / segLen
		if idx >= uint64(n) {
			idx = uint64(n) - 1
		}
		return int(idx)
	}
	// IPv6 路径
	base := new(big.Int).SetBytes(ipNet.IP.To16())
	ipInt := new(big.Int).SetBytes(ip.To16())
	total := new(big.Int).Lsh(big.NewInt(1), uint(bits-ones))
	segLen := new(big.Int).Div(total, big.NewInt(int64(n)))
	if segLen.Sign() == 0 {
		segLen = big.NewInt(1)
	}
	off := new(big.Int).Sub(ipInt, base)
	if off.Sign() < 0 {
		return 0
	}
	idx := new(big.Int).Div(off, segLen)
	if idx.Cmp(big.NewInt(int64(n-1))) > 0 {
		idx = big.NewInt(int64(n - 1))
	}
	return int(idx.Int64())
}

// LoadFromFile 读取本地兜底配置。
func LoadFromFile(path string) (*AppConfig, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var cfg AppConfig
	if err := yaml.Unmarshal(data, &cfg); err != nil {
		return nil, fmt.Errorf("yaml parse %s: %w", path, err)
	}
	if strings.TrimSpace(cfg.DefaultTarget) == "" {
		return nil, fmt.Errorf("default_target required in %s", path)
	}
	ApplyDefaults(&cfg)
	cfg.Source = "file"
	return &cfg, nil
}

// SaveToFile 将配置回写到本地 yaml（兜底文件与内存保持一致）。
func SaveToFile(path string, cfg *AppConfig) error {
	data, err := yaml.Marshal(cfg)
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0644)
}

// LoadRulesFromRedis 读取 Redis 中的规则 JSON 数组（key 由配置指定）。
func LoadRulesFromRedis(ctx context.Context, rdb *redis.Client, key string) ([]Rule, error) {
	val, err := rdb.Get(ctx, key).Result()
	if err != nil {
		return nil, err
	}
	var rules []Rule
	if err := json.Unmarshal([]byte(val), &rules); err != nil {
		return nil, fmt.Errorf("redis rules json invalid: %w", err)
	}
	return rules, nil
}

// SaveRulesToRedis 将规则数组 JSON 写入 Redis。
func SaveRulesToRedis(ctx context.Context, rdb *redis.Client, key string, rules []Rule) error {
	data, err := json.Marshal(rules)
	if err != nil {
		return err
	}
	return rdb.Set(ctx, key, data, 0).Err()
}
