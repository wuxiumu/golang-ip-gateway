package main

import (
	"fmt"
	"net"

	"ip-gateway/internal/geo"
)

func main() {
	if err := geo.Init(); err != nil {
		fmt.Println("init err:", err)
		return
	}
	for _, ip := range []string{"14.215.177.39", "61.135.169.121", "202.96.134.33", "223.5.5.5", "36.152.44.96", "104.16.132.229", "8.8.8.8", "1.1.1.1"} {
		fmt.Printf("%-16s -> [%s]\n", ip, geo.Query(net.ParseIP(ip)))
	}
}
