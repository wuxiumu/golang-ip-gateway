# golang-ip-gateway · 深优化建议（文档先行）

> 与父仓 `docs/OPTIMIZATION-NEXT.md` Top3 对齐。  
> 轻量加固：✅ C1 PR（可配限流/日志 / `config.example.yaml` / Compose / `go test`）。**下列留给下一轮代码。**

## 现状对照

| 项 | 现状 |
|---|---|
| 配置 | 本地常见 `config.yaml`；`admin_token: ""` 空口令需生产强制 |
| 验证 | `scripts/verify.sh`；`deploy/ip-gateway.service` + nginx 样例已有 |
| 文档 | `doc/01`–`05`（需求/验证/宝塔/商业化） |
| 风险 | 公网误开 + 空 `admin_token` |

## 建议（可执行）

| # | 建议 | 类型 | 验收 |
|---|---|---|---|
| 1 | `config.example.yaml` 与 Compose 对齐；默认只监听内网，公网误开处加醒目注释 | 安全 | 复制示例不会默认裸奔公网 |
| 2 | 生产 profile：`admin_token` / API Token 强制非空，缺则 `exit 1` | 安全 | 空口令无法以 production 启动 |
| 3 | Demo：三条规则 + `curl` 断言写进 README，挂到 `./scripts/verify.sh` | Demo | 一键绿 |
| 4 | 宝塔一键包：`dist/baota/`（二进制 + systemd unit，复用 `deploy/`） | 定制 | 解压按 README 可装 |
| 5 | 命中统计导出 CSV（管理 API 或 `scripts/export-hits.sh`） | 定制 | 谈单可下载报表 |
| 6 | GeoIP 数据更新说明与许可证提示（独立一页 `doc/` 或本目录） | 文档 | 运维可跟做更新 |

## 建议落地顺序

2 → 1 → 3 → 4 → 5 → 6。

## 定制联系

微信 **qingbao199101**（备注：分流网关）· [wuxiumu@163.com](mailto:wuxiumu@163.com)
