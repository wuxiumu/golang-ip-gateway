// Package geo 提供 IP 归属地查询能力。
// 数据来自 ip2region（IPv4 xdb，~11MB）直接内嵌进二进制，部署时无需额外数据文件；
// 查询结果格式：国家|区域|省份|城市|ISP，如「中国|0|广东省|深圳市|电信」。
package geo

import (
	"embed"
	"net"
	"strings"
	"sync/atomic"

	"github.com/lionsoul2014/ip2region/binding/golang/xdb"
)

//go:embed ip2region_v4.xdb
var xdbFS embed.FS

var searcher atomic.Pointer[xdb.Searcher]

// Init 加载内嵌的 IPv4 地理库到内存（进程内共享，并发安全）
func Init() error {
	cBuff, err := xdb.LoadContentFromFS(xdbFS, "ip2region_v4.xdb")
	if err != nil {
		return err
	}
	s, err := xdb.NewWithBuffer(xdb.IPv4, cBuff)
	if err != nil {
		return err
	}
	searcher.Store(s)
	return nil
}

// Loaded 地理库是否已加载
func Loaded() bool {
	return searcher.Load() != nil
}

// Query 返回 IP 归属地字符串（如 中国|0|广东省|深圳市|电信）。
// 未加载、非 IPv4、私网或未知地址返回空串。
func Query(ip net.IP) string {
	if ip == nil {
		return ""
	}
	s := searcher.Load()
	if s == nil {
		return ""
	}
	val, err := s.Search(strings.TrimSpace(ip.String()))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(val)
}
