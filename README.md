# IP 智能分流网关（golang-ip-gateway）

> 按 **IP / 网段 / 权重 / 区域(GeoIP)** 做入口 **302 跳转**：同一访客永远落到同一域名，适合投放落页、镜像分发、灰度入口。  
> 规则内存匹配（请求路径零 IO）；Redis 主配置 + 本地 yaml 兜底；本地 React 管理端可演示。

**定制 / 部署咨询：** 微信 **qingbao199101**（备注：分流网关）｜邮箱 [wuxiumu@163.com](mailto:wuxiumu@163.com)

## 谁需要

| 客户 | 痛点 | 你能交付 |
|---|---|---|
| 投放 / 渠道运营 | 多落页要按人固定、又不会写 nginx | 可视化配规则 + 宝塔部署 |
| 下载 / 镜像站 | 不同网段走不同源 | 分段 / 随机粘性 / 区域分流 |
| 中小团队 | 要入口级 AB，不要改业务代码 | 权重分流 + 命中统计 |

## 已具备能力（MVP+）

- 三分类：随机粘性分配 · IP 分段 · 区域分流（内嵌 ip2region）
- Host 维度隔离、权重、命中统计（24h）、Demo 预览三件套
- Admin API 热加载；`scripts/verify.sh` 自动化断言
- 文档：`doc/01` 需求 · `doc/03` 验证 · `doc/04` 宝塔部署 · `doc/05` 商业化建议

## 快速开始

Go 模块路径是 `ip-gateway`，`go.mod` 要求 **Go 1.26**。本地端口以仓库配置为准。

| 进程 | 端口 | 配置位置 |
|---|---|---|
| 网关 | **18080** | `config.yaml` 的 `listen: :18080` |
| 管理端 dev | **6183** | `admin-ui/vite.config.js`，把 `/admin`、`/healthz` 代理到 `http://127.0.0.1:18080` |
| 回归脚本 | **18099** 起自动选空闲端口 | `scripts/verify.sh` |

宝塔文档和 `deploy/nginx-ip-gateway.conf` 里的 **8080** 是线上 `listen`，和上面的本地 18080 不是同一个端口。

```bash
# 需要本机 Go 1.26+
go run . -config config.yaml
curl -s http://127.0.0.1:18080/healthz

# 管理端（仅本地开发，不默认部署到服务器）
cd admin-ui && npm i && npm run dev
# 打开 http://127.0.0.1:6183

# 最小冒烟（CI 同款，见 .github/workflows/smoke.yml）
go test ./...
CGO_ENABLED=0 go build -o ip-gateway .

# 全量回归
./scripts/verify.sh
```

新环境复制 `config.example.yaml` 为 `config.yaml`。令牌、Redis 密码放 `.env`（从 `.env.example` 复制），`.env` 不入库。

## 配置、日志与限流

规则和监听以 yaml 为准。环境变量只覆盖部署时不想写进文件的项（见 `.env.example`），空值不会覆盖文件。

| 项 | 默认 | 说明 |
|---|---|---|
| `log.level` / `IPGW_LOG_LEVEL` | `info` | `debug` 或 `info` |
| `log.access` / `IPGW_LOG_ACCESS` | `false` | `true` 时记录每次 302（`access ip= host= target=`） |
| `log.gin_mode` / `IPGW_GIN_MODE` | `release` | `release` / `debug` / `test` |
| `rate_limit.rps` | `0` | `0` 关闭限流，请求路径与原来一致；大于 0 时按客户端 IP 令牌桶，超限返回 429 |
| `cors_origin` | `*` | 管理端跨域来源 |
| `stats_flush_interval` | `30s` | 命中统计落盘间隔 |
| `shutdown_timeout` | `5s` | SIGTERM 后等待存量请求的时间 |
| `redis.dial_timeout` 等 | `2s` / `1s` / 池大小 `8` | Redis 客户端超时，未写时与原先硬编码相同 |

改监听、日志、限流、CORS、Redis 连接后需要重启。`/admin/reload` 只热更新规则。管理端保存规则会把当前内存配置回写到 `config.yaml`（含环境变量覆盖后的 `admin_token`），生产令牌不要提交。

## Docker

```bash
cp config.example.yaml config.yaml   # 已有 config.yaml 可跳过
cp .env.example .env                 # 按需填写 IPGW_ADMIN_TOKEN 等
docker compose up --build
curl -s http://127.0.0.1:18080/healthz
```

Compose 把宿主机 `18080` 映射到容器内 `18080`，并用 `IPGW_REDIS_ADDR=redis:6379` 覆盖 yaml 里的本机 Redis 地址。Redis 不映射到宿主机。镜像内默认配置来自 `config.example.yaml`，不含令牌。

交叉编译 Linux 与宝塔步骤见 [doc/04-宝塔部署指南.md](doc/04-宝塔部署指南.md)。

## 文档索引

| 文档 | 说明 |
|---|---|
| [doc/01-核心需求梳理.md](doc/01-核心需求梳理.md) | 需求与边界 |
| [doc/02-开发计划.md](doc/02-开发计划.md) | 接口与结构 |
| [doc/03-现状梳理与验证指南.md](doc/03-现状梳理与验证指南.md) | 怎么用、怎么验 |
| [doc/04-宝塔部署指南.md](doc/04-宝塔部署指南.md) | 上线 |
| [doc/05-商业化建议.md](doc/05-商业化建议.md) | 怎么卖 |
| [plan.md](plan.md) | 原始方案（拟迁入 doc/） |



## SEO 字段预留（产品页 HTML 统一生成时用）

| 字段 | 用途 |
|---|---|
| `seo_title` | `<title>` / OG title |
| `seo_description` | meta description |
| `canonical_url` | 规范 URL |
| `og_image` | 分享图 |
| `robots` | 如 `index,follow` |
| `json_ld_type` | SoftwareApplication / WebPage / FAQPage |
| `hreflang` | zh-CN / en |
| `site_name` | 白标品牌名 |

> 说明：**GEO ≠ 地理定位**。GEO = Generative Engine Optimization（生成式引擎优化），见下一节。

## GEO（生成式引擎优化）

面向 ChatGPT / Perplexity / Gemini 等生成式答案引擎的**可引用结构**：中文为主、双语关键词、事实摘要前置、FAQ 收尾。

### 关键词（中英）

- 中文：IP分流网关, 302跳转, 投放落页分配, GeoIP区域分流, 私有化网关
- English: IP routing gateway, 302 redirect, sticky traffic split, GeoIP, private deployment

### 事实摘要

- 产品：按 IP/网段/权重/区域将访客 302 到不同域名，同 IP 可固定落点。
- 适合：投放运营、镜像下载、需要入口级分配且不想写 nginx 的人。
- 交付：Go 单二进制 + 本地管理端；可私有化部署与规则代配。
- 不做：不回源代理内容；管理端默认仅本地开发模式。

### FAQ（便于生成式引擎引用）

**Q：这是什么？**  
A：见上方事实摘要「产品」一行。

**Q：适合谁付钱定制？**  
A：见「适合」；具体加微信 `qingbao199101` 备注项目名。

**Q：开源仓库是否已含全部数据/密钥？**  
A：默认不含 API Key；数据/图片是否入库以各项目说明为准。

**Q：是否自动发帖或自动运营第三方平台？**  
A：内容工厂类项目明确不自动发帖；其它项目以 README「不做」边界为准。


## 下一步 / 深优化

下一轮可执行建议见 [`docs/OPTIMIZATION.md`](docs/OPTIMIZATION.md)。轻量/C 加固已完成；深优化按文档验收后再改代码。

## 定制合作

私有化打包、按业务配规则、宝塔或本仓库 `docker compose` 交付、内嵌管理端、报表口径定制。加微信备注「分流网关」。

生产环境请设置非空 `admin_token`，勿把空鉴权示例直接暴露公网。

---


---

## 联系方式

定制、演示或合作：

- 邮箱：[wuxiumu@163.com](mailto:wuxiumu@163.com)
- 微信：**qingbao199101**（添加请备注来意）

### 赞助支持

如果内容对你有帮助，欢迎自愿赞助。

| 微信赞赏码 | 支付宝收款码 |
|---|---|
| ![微信赞赏码](https://chiguashentan-test.oss-cn-beijing.aliyuncs.com/wxprogram/zan/20261002185236_31_227.png) | ![支付宝收款码](https://chiguashentan-test.oss-cn-beijing.aliyuncs.com/wxprogram/zan/20261002185309_32_227.jpg) |
