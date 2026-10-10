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

## 定制合作

私有化打包、按业务配规则、宝塔/ Docker 交付、内嵌管理端、报表口径定制。加微信备注「分流网关」。

生产环境请设置非空 `admin_token`，勿把空鉴权示例直接暴露公网。

---

## SEO / GEO 字段预留

网关本体做 IP/区域分流；**产品介绍页**仍需下表 SEO 字段。规则侧 GEO 见 `doc/` 区域分流。

> 做成独立产品页 / 站群页时，模板与配置预留下列字段（先占位，落地页或导出 HTML 时填入）。

| 字段 | 类型 | 用途 |
|---|---|---|
| `seo_title` | string | `<title>` / OG title |
| `seo_description` | string | meta description |
| `seo_keywords` | string[] | 可选关键词 |
| `canonical_url` | url | 规范链接 |
| `og_image` | url | 分享图 |
| `robots` | string | 如 `index,follow` |
| `json_ld_type` | string | 如 `SoftwareApplication` / `WebPage` / `FAQPage` |
| `geo_region` | string | 地域页：省/州代码或名称 |
| `geo_placename` | string | 城市/地标名（城市站、本地服务页） |
| `geo_position` | string | 可选 lat,long |
| `hreflang` | map | 多语言备用，如 `zh-CN` / `en` |
| `site_name` | string | 品牌名（白标） |


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

