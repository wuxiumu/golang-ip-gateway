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

```bash
# 需要本机 Go
go run . -config config.yaml
# 默认监听见 config.yaml（本地常为 :18080）

# 管理端（仅本地开发，不默认部署到服务器）
cd admin-ui && npm i && npm run dev

# 回归
./scripts/verify.sh
```

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

私有化打包、按业务配规则、宝塔/ Docker 交付、内嵌管理端、报表口径定制。加微信备注「分流网关」。

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
