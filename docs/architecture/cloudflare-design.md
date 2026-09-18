# JevNews：Cloudflare 优先技术详细设计

> 版本：v1.0  
> 日期：2026-09-19（UTC+8）  
> 状态：设计，尚未部署或完成远程性能验证。  
> 产品基线：[产品需求](../product-requirements.md)  
> 数据模型：[D1 / SQLite 参考 schema](cloudflare-schema.sql)

## 0. 决策摘要与变更

采用 **Cloudflare Workers + Static Assets + D1 + R2 Standard + Cron Triggers + Queues + Turnstile**。公共文章判断继续由平台调用 Jev 并承担费用；自然语言规则编译优先尝试 Workers AI 的免费额度。

目标是尽量使用免费资源，而不是以削弱密码安全、隐藏漏数据或删掉私人规则功能换取零账单。设两个运行档位：

- **Free 验证档**：用免费额度实测完整链路；满足 CPU、读写和消息预算后才开放对应能力。基础设施有机会为 $0，但 Jev、独立域名及其他外部服务不是 Cloudflare 免费资源。
- **低成本完整档**：任一必要操作无法稳定满足免费 CPU 或额度时，使用 Workers Paid，当前最低 $5/月，再加实际超额与其他费用。不会自动开通任何付费服务。[S1]

取代此前的技术起点：

| 旧方案 | 本方案 | 原因 |
| --- | --- | --- |
| 自建 PostgreSQL | 单个 D1 数据库，正文和大对象放 R2 | 不维护数据库服务器，利用托管免费额度。 |
| 三个常驻容器 | 事件驱动 Workers | 不租常驻服务器，不运行永久轮询进程。 |
| 部分端点每 10 秒检查 | 默认 1 分钟发现，其他对象分层刷新 | Cloudflare Cron 是五字段、分钟级调度；不是秒级调度器。[S2] |
| Next.js 作为优先起点 | Hono + TypeScript + 服务端 HTML + 少量原生 JS | HN 风格不需要复杂客户端应用；优先减少运行时开销。不是声称 Next.js 不能运行。 |
| 内部全文与关系数据混放 | D1 关系与小 JSON；R2 正文、快照和导出 | 避免数据库容量和扫描负担。 |

产品不变：独立网页、HN 原样布局、不限热门、七套公共预设、注册后的私人规则、暂时免费、真实 HN 写操作回原站。用户名密码注册仍保留，不静默改为仅 GitHub 登录。

## 1. 免费资源的准确边界

以下为 2026-09-19 查阅的官方文档，不是永久价格承诺。额度多数按账户共享，不能通过多建 Worker 或数据库当作无限倍增额度。

| 资源 | 当前免费额度/能力 | 本项目使用方式 |
| --- | --- | --- |
| Workers | 100,000 请求/日；HTTP 和 Cron 免费 CPU 各为 10ms；128MB 内存 | 页面、API、轻量同步。实际 CPU 必须部署测量。[S1][S3] |
| Static Assets | 不进入 Worker 脚本的静态资源请求免费且不限次数 | CSS、JS、图标、静态说明与故障页；动态 HTML 不因此免费。[S4] |
| D1 | 5M 行读/日、100K 行写/日、账户合计 5GB；免费单库 500MB、最多 10 库 | 初期一个库，350MB 预警。索引也影响读写与容量。[S5][S6] |
| Cron Triggers | 免费账户最多 5 个；最小分钟级；UTC | 初始使用 3 个 Cron，不占满额度。[S2][S3] |
| Queues | 10,000 操作/日；免费消息保留 24 小时 | 文章抽取、分析、预设发布、私人专项任务；一般一条消息至少读/写/删三次。[S7] |
| R2 Standard | 10GB-month、每月 1M Class A 与 10M Class B 操作；互联网出站免费 | 内部正文、版本化快照、导出。超额可计费，不是硬限额免费沙箱。[S8] |
| Turnstile | 免费计划可用于大多数生产应用，挑战不限次数 | 注册、登录和高成本操作的反滥用入口，不每次浏览都挑战。[S9] |
| Workers AI | 每日 10,000 Neurons 免费额度，不是 10,000 tokens | 私人规则编译实验；不代替 Jev，也不承诺足以处理全站正文。[S10] |
| Workers Builds | 免费每月 3,000 构建分钟，1 个并发构建 | GitHub 推送后的构建部署；不是每分钟数据更新工具。[S11] |
| Workers Logs | 免费每日 200,000 事件，保留 3 天 | 脱敏结构日志和抽样，长期统计聚合保存。[S1] |
| workers.dev | Cloudflare 分配的免费子域名 | 首次试运行，不购买域名也能访问。[S12] |

### 1.1 域名不等于 DNS

`jevnews.<账户子域>.workers.dev` 是地址格式示例，尚未创建或确认可用。`pages.dev` 也是托管子域名，不是独立注册域名。

`jevnews.com` 等独立域名需要购买及续费；Cloudflare Registrar 是按注册局与 ICANN 成本收费，不是免费注册。现有域名的一个子域也可以接入 Cloudflare，不需要为每个子域另买域名。[S12][S13]

本方案先使用 workers.dev；正式域名可稍后绑定，迁移时更新规范链接、Cookie、Turnstile 允许域和回调地址。官方将 workers.dev 定位为个人/爱好项目起步地址，更重要的生产服务建议使用自有域名。[S12]

### 1.2 免费不保证超额继续服务

Workers、D1 等免费限额耗尽可能直接报错。D1 官方定价说明，超过日读写额度后查询会失败，直到 UTC 零点重置；存储超额需清理或升级。不能把免费额度当作软提醒。[S3][S5]

R2 需要在控制台完成订阅开通流程；包含免费用量不等于没有订阅、付款资料或超额账单，开通时核对控制台要求。本次未开通任何资源。[S8][S14]

## 2. 逻辑架构

```text
浏览器：HN 风格 HTML / 原生链接 / 少量增强脚本
       |
       +-- Static Assets：CSS、JS、自有图标、离线说明
       |
       +-- jevnews-web Worker（Hono）
              |-- 页面、账户、私人规则、hide/收藏
              |-- D1：元数据、会话、权限、分析、快照指针
              |-- R2：读取内部排序快照，不公开 bucket
              |-- Turnstile：服务端校验

3 个 Cron --> jevnews-sync Worker
              |-- HN 官方 API：列表、增量 ID、变更提示
              |-- D1：游标、有限元数据更新、持久任务账本
              |-- Queues：投递任务 ID，而非整篇正文

Queues --> jevnews-jobs Worker
              |-- 抽取：外链/项目说明/投稿文本 --> R2
              |-- 公共判断：R2正文 --> Jev --> D1画像
              |-- 排序发布：D1画像与预设 --> R2不可变快照
              |-- 私人规则编译：Workers AI --> 校验 --> 用户确认
              |-- 私人专项判断：有限候选 --> Jev
```

三个 Worker 是部署单元，不是三台服务器。初期放同一个 TypeScript monorepo。同步与重任务和网页分离，避免 Cron 改动破坏页面；不依赖拆分 Worker 绕过账户额度，也不假定 Service Binding 能无限增加 CPU。[S1]

第一版不引入 Redis、向量库、图数据库、容器或独立搜索集群。D1 是 SQLite 语义，不是免费 PostgreSQL；SQL 和迁移按 SQLite 编写。[S15]

## 3. Web 和界面实现

### 3.1 技术栈

采用 Hono、TypeScript、轻量服务端 HTML 模板、普通 CSS 和少量原生 JS，使用 Wrangler 构建发布。Hono 有 Cloudflare 官方部署指南。[S16]

不把整个页面做成必须下载大型 JS 后才显示的 SPA。首屏有真实 HTML，标题和 More 是普通链接，保持浏览器返回、新标签打开、选中文本和禁用部分 JS 时的基础可读性。JS 只负责评论折叠、规则编辑增强、更新提示和本地阅读状态。

可以参考前一版考察过的 MIT HN 示例的样式、组件结构和测试样本，但不必继承其框架。来源及许可证保留在 THIRD_PARTY_NOTICES；未审核的组件不直接复制上线。

### 3.2 路由

| 路由 | 作用 |
| --- | --- |
| `/` | 默认 Jev/Balanced 列表，记住用户上次选择。 |
| `/news?view=hn`、`/newest`、`/ask`、`/show`、`/jobs` | 官方列表顺序和常用入口，保持 HN 链接语义。 |
| `/item?id=<hn_id>` | 本地显示 HN 投稿与评论；未缓存分支有限补取。 |
| `/user?id=<hn_name>` | HN 公共资料，与本站用户完全分开。 |
| `/login`、`/register`、`/logout` | 本站账户；logout 使用 POST。 |
| `/rules`、`/rules/<id>` | 私人规则管理，必须鉴权和 owner 检查。 |
| `/saved`、`/hidden` | 本站阅读状态。 |
| `/api/feed-version` | 用户停留时可低频检查版本，不推送重排。 |
| `/api/items/<id>/children` | 分批补评论；不是无限递归抓取接口。 |
| `/api/rules/compile`、`/api/rules/<id>/activate` | 创建编译任务与激活已验证规则，POST。 |
| `/api/item-state` | hide/收藏幂等写入，POST/DELETE。 |
| `/healthz` | 轻量健康检查，不触发 HN/AI 全链路。 |

私人写接口限制体积、校验 Origin/CSRF、验证身份；参数只能来自预定义 schema。HN 原生写操作继续跳转原站，不增加本地假票数。

### 3.3 静态资源与缓存

CSS/JS 的内容哈希文件由 Static Assets 直接服务，不使用 `run_worker_first: true` 覆盖全部路径。动态 SSR、读取 R2 的 Worker 响应、Cache API 命中都不能统称为无限免费静态访问。[S1][S4]

Cache API 只做可丢失的公共加速，例如不可变排序 ID 快照；不是数据库，不用来保存唯一游标、任务或额度。它不是全局强一致缓存，本地删除也不是全球立即清除。[S17]

初期最终列表 HTML 不做长 TTL 公共缓存：按快照取 30 个 ID，再批量读 D1 最新显示字段和 deleted/dead 状态后渲染。私人页面与账户接口使用 `Cache-Control: private, no-store`；公开缓存绝不包含 Cookie、账户名或私人规则。

## 4. HN 数据同步

### 4.1 来源与发现

使用官方 Firebase HN API；元数据与正文分开。`newstories` 是快速发现入口，`maxitem` 加持久游标负责补缺，`updates` 只是刷新提示，不视为可重放日志。HN item 包括评论，不把全部新 ID 送去文章分析。[S18]

保留两个位点：`observed_max_id` 和已完成扫描的高水位；同时维护已记录的 gap/range。一个 null/失败 ID 进入有上限的退避重试，不阻塞所有新 ID，也不被假装为已完整同步。显示 `coverage_since`、`lag_ids` 和 `oldest_gap_at`。

首次部署先载入当前列表，再逐步回填最近 7 天。回填未完成时显示实际覆盖，不能把当前 500 条新帖当成完整历史。低票内容不设置准入门槛；队列按等待时间保障公平，不只优先热门。

### 4.2 Cron 默认配置

| Cron（UTC） | 任务 | 边界 |
| --- | --- | --- |
| `* * * * *` | 快速发现、少量补缺、任务投递 | 一分钟一次；轻量、有界、可重复。 |
| `*/10 * * * *` | 合并脏预设发布请求、失效租约检查、用量检查 | 七个预设各至多一个未完成发布任务。 |
| `23 * * * *` | 冷数据校验、限量清理、生成运维摘要 | 大清理拆成小任务，不在一次 Cron 内扫全库。 |

Cron 没有秒字段。付费 Workers 也不会把 Cron 自动变成十秒调度。将来确有需求，可评估 Durable Objects alarm 协调与补偿 Cron；本版不依赖常驻 `setInterval`、sleep 循环或无限长 Firebase 订阅。[S2][S19]

### 4.3 每分钟任务不能全量运行

每次快速 tick 的初始配额：最多 16 个补缺 item、8 个待刷新 item，以及本轮到期控制端点；网络并发最多 4，预留重定向、DNS 检查与重试预算。快照列表只保存发生改变的数据。

免费 Worker 外部子请求上限为 50；D1 每次 invocation 也有查询数量限制。单 tick 内 D1 批量语句数同样计入预算，不能因为用了 batch 就把 500 条 SQL 当作一次无限配额。CPU 仍需实测，配额按结果降低。[S3][S6]

这不是对 HN 全量峰值吞吐的保证。补缺净速度低于新 ID 增速时，提高在预算内的并行工作量或升级，不丢弃非热门内容来伪造及时性。

### 4.4 对象刷新周期

| 对象 | 运行默认值 |
| --- | --- |
| newstories、maxitem | 每分钟。 |
| topstories | 每分钟，保存列表顺序，不因每次轮询都重写 500 行。 |
| updates | 每分钟，按需合并刷新。 |
| ask、show、best | 每 5 分钟；未到期不请求。 |
| jobs | 每 10 分钟。 |
| 当前首页及被访问帖子详情 | 按变化和访问刷新；通常 2–5 分钟，受预算控制。 |
| 评论 | 按线程/分支访问加载；缓存约 2 分钟，首批最多补 20 个节点。 |
| HN 用户资料 | 按需，约 30 分钟 TTL。 |
| 公共 Jev 排序 | 有新分析或规则变化时合并发布，目标每 10 分钟；读写压力下可降到 20–30 分钟并标注更新时间。 |
| 正文 | 初次获取；合理的条件重验证，不随分数变化重抓。 |
| 前端版本提示 | 仅前台活跃标签，最多每 2 分钟检查；不自动重排。 |

后台发现新帖、正文分析完成、预设快照发布是不同时间。网页不承诺一分钟内一定完成全文分析。

## 5. 内容抽取与公共分析

### 5.1 抽取

外链获取只接受服务器已从 HN 取得的 URL，不公开任意 URL 代理。使用普通 fetch 与 HTMLRewriter/受控解析，优先 main/article 和明确正文区域；HTMLRewriter 是流式 HTML 处理能力，不是自动保证准确的正文提取器。[S20]

初始输入上限：下载响应体 1MiB、抽取文本 128KiB，最多 3 次重定向、总超时 15 秒。限制是设计值，不是 Cloudflare 最大值。流式读取过程中执行上限；不能仅信任 Content-Length。超过上限标为 partial/too_large，不谎称全文。

去除脚本、样式、导航等非正文，但保持 pre/code、标题、段落与链接语义。保留文本位置和片段编号用于依据引用。HN 自带文本也要按不可信 HTML 处理。

需要浏览器渲染的网站第一版保留链接和 metadata_only/partial 状态；不默认开启付费代理或 headless 浏览器。Browser Run 免费额度只有每日 10 分钟，不适合作为每篇文章的必经流程。[S21]

### 5.2 公共判断

输入为规范化正文和版本化评价问题，产出沿用产品定义：主题、内容形态、实现与解释深度、经验与证据、门槛、目的、分析覆盖。

程序直接计算长度、规范 URL、哈希和同文关系；Jev 做结构化内容判断；七套预设由代码组合同一份画像，不为每个访客重新理解一遍。

分析幂等键：`hash(实际输入 + 抽取版本 + rubric版本 + 固定模型版本 + 影响结果的参数)`。HN score/评论数变化不影响这个键。投稿信息参与输入时必须包含在哈希中；不能一边使用不同标题做判断，一边错误复用相同缓存。

模型别名上线前解析并记录实际版本。结构化输出仍可能语义判断错误；严格 schema、有限置信使用和真实标注集验收不可省略。证据必须定位到原文，模板解释不能虚构引用。

Jev 是外部依赖，密钥仅放 jobs Worker Secret。官网当前列出输入每十亿 tokens $42，即每百万 $0.042；它不是 Cloudflare 免费额度。最终账单以真实 usage 与账户价格为准；本轮没有完成 Jev API 联调。[S22]

## 6. 排序、私人规则与稳定分页

### 6.1 七套预设

Balanced、Engineering、AI & Agents、Systems & Databases、Show & Build、Products & Startups、Curiosity 沿用产品基线。每份画像生成七个基础分和规则版本；只有正文/画像/预设变化才重算。公开展示的 HN points 不被模型分替代。

可采用对固定正向基础分进行时间衰减的索引排序：`priority = ln(max(base, epsilon)) + submitted_at / tau`；对同一预设，当前时间项为共同常量，不必每分钟因年龄增长重写全表。该式只是可测试起点，不是 HN 官方排序。多样性与同文控制在候选列表程序后处理。

近期窗口默认 7 天。保存完整窗口 ID 快照，不把只取热门前 100 条称为“全部候选”。snapshot 只固定顺序，显示字段从最新缓存补齐；source deleted/dead 是覆盖条件。

### 6.2 不在每次页面请求扫描全站

公共预设的排序共享发布；原始 HN 模式复用官方有序 ID；私人结果按 `user + profile_version + corpus_generation` 缓存。首次私人重建返回 processing/上一有效快照，不阻塞页面等待多篇 Jev 调用。

免费预算下允许合并多次刷新，限制私人重建频率，并显示生成时间。不能把额度不足伪装成新规则已执行。

### 6.3 规则编译

自然语言 -> Workers AI 结构化输出 -> 代码校验 -> 可读规则预览 -> 用户保存激活。模型名放配置，先对中英文真实规则集验证，再固定版本；不因有免费模型就假设它足够准确。

允许的 DSL 仅包含 topics、content_types、depth、soft_preferences、hard_filters、exceptions、有限 semantic_conditions。拒绝任意 SQL、JS、网络工具或可执行表达式。模型提供的 topic、字段、运算符必须在白名单内。

Workers AI JSON Mode 官方也不保证每次都能满足 schema；失败最多一次受限修复，仍失败就展示失败，保留原规则。[S23] 免费 Neurons 用尽后，已有规则和预设继续可用，新编译明确排队/暂停；不自动切换另一个收费模型。

### 6.4 私人边界与容量

保留每账号 3 套规则、每套最多 3 个专项条件、每日最多 100 篇版本专项复判、每日 20 次编译的产品上限。它们不是平台保证为每位用户立即执行的吞吐。

另设全站池；Free 起始预算可设每天 100 篇私人专项、100 次私人完整快照重建，公共新内容分析优先。通过公平队列分配，未获处理的部分显示 pending/unknown。参数可配置并需在界面说明。

仅偏好类规则可先用公共画像排序。硬条件匹配列表只显示已满足的结果，单独提供未评估数量和入口，不静默放松条件。

### 6.5 快照协议

D1 保存 manifest：id、scope、owner、rule_version、生成时间、覆盖窗口、R2 key、过期时间；R2 保存不可变 ID 列表和必要排序依据引用。先写 R2，再提交 D1 manifest/head；失败的孤儿对象稍后清理。

More 使用 `snapshot_id + offset`，初始每页 30 项。私人 snapshot 的每次读取必须校验 owner，而不是只依赖 URL 难猜。过期后提示刷新，不混合新旧页。

读取列表时叠加最新 deleted/dead；已知删除不从旧快照复活。浏览器已下载的内容无法远程保证立即消失，不将这一点包装成实时强一致承诺。保留浏览位置，不因后台更新跳位。

## 7. D1 数据模型和访问规则

[参考 SQL](cloudflare-schema.sql) 列出 21 张逻辑表，分为四组；表数量不代表 21 个服务。

| 数据组 | 表 |
| --- | --- |
| 来源 | hn_items、source_documents、document_versions、story_documents |
| 画像与排序 | article_analyses、story_analyses、preset_versions、preset_scores、feed_snapshots、feed_heads |
| 用户 | users、sessions、recovery_tokens、private_profiles、private_profile_versions、private_evaluations、user_item_state |
| 运行控制 | jobs、sync_state、budgets、budget_reservations |

D1 使用 TEXT 存 JSON，需要 JSON 校验；全文与大数组不放重复关系行。使用 SQLite 参数绑定和少量显式 SQL，初期不引入沉重 ORM。D1 batch 可提供原子批处理，但不能用 PostgreSQL 的 SKIP LOCKED、连接池或长事务模式照搬。[S15][S24]

SQL 要求：

- HN ID 使用 INTEGER，本站用户独立 ID；分数和评论数不建高频写索引。
- 私人对象查询必须带 user_id；SQL 外键约束只是加固，不替代请求鉴权。
- 列表批量读取 30 个 item，避免每条各一个数据库往返；D1 单条绑定参数限制为 100，不无界扩展 IN 子句。[S6]
- 每次写前比较实际 payload hash；仅 fetched_at 变化不强制写整条 item，轮询检查时间可按批记在 sync_state。
- `rows_read`/`rows_written` 使用 D1 返回 meta 与账户仪表盘观测；只看 SQL 条数会低估开销。[S5]
- 初期单库；容量达到 350MB 预警，先清缓存，再判断是否升级，不用无限分库冒充无限免费容量。

## 8. Queues、租约和失败恢复

### 8.1 账本与运输分开

D1 jobs 是任务真相；Queues 负责运送 ID。免费 Queues 只保留 24h，不能把未完成工作的唯一状态放在消息里。[S7]

任务类型：EXTRACT、ANALYZE_PUBLIC、COMPILE_PROFILE、EVAL_PRIVATE、PUBLISH_PRESET、BUILD_PRIVATE_SNAPSHOT、CLEANUP。轻量 HN 元数据获取直接在有界同步 tick 做，避免给每个评论都发消息。

初始 consumer `max_batch_size=1`、并发最多 2；每条消息一般只做一个受控阶段。抽取和分析分开，减少单 invocation CPU 峰值。消息仅带 job_id/schema_version，不带正文、密码或全量私人规则。

### 8.2 投递与幂等

先用唯一 dedupe_key 写 jobs，再发送 queue。D1 和 Queue 不存在本项目可依赖的跨服务原子事务，因此可能“写账本成功而发送失败”或“发送成功但未标记”。扫描器重投，consumer 必须去重，不能声称 exactly-once。

处理前用条件 UPDATE ... RETURNING 领取有期限租约；完成写入也检查同一个 lease_owner。超时失联可以被接管，旧 worker 不能覆盖新结果。租约时长覆盖外部请求超时与重试窗口；长任务拆分或续约。

```sql
UPDATE jobs
SET state = 'running', lease_owner = ?1, lease_until = ?2,
    attempts = attempts + 1, updated_at = ?3
WHERE id = ?4 AND available_at <= ?3
  AND (state IN ('pending','queued','retry')
       OR (state = 'running' AND lease_until < ?3))
RETURNING id, payload_json;
```

业务结果与 job 状态尽量在 D1 batch 提交；成功后 ack。收到已 done 消息直接 ack。发现正在有效租约中，延迟该消息而非并行重复处理。恢复扫描对队列过期、丢失投递和孤儿 running 进行补偿。

### 8.3 重试

网络、429 和临时 5xx 使用 Retry-After 或带抖动指数退避，起点 1、5、15、60 分钟，最多 5 次；401/权限错误、格式不支持等不无限重试。失败进入 dead 并保留可人工重试记录。

外部 AI 已处理但响应丢失时，重试可能再次计费。除非提供方实际支持已验证幂等键，不承诺严格单次收费；保留 attempt 和 uncertain usage，预算按保守方式占用。

## 9. 账户、安全和发信

### 9.1 保留用户名密码

延续 HN 风格的用户名密码表单，不把 OAuth 强行作为唯一入口。Workers 的 node:crypto 文档目前不支持内置 argon2；本设计采用成熟 scrypt 实现，使用 OWASP 列出的安全配置之一作为验证起点：N=32768、r=8、p=3，独立随机盐，显式足够 maxmem。[S25][S26]

上线前验证生产 Workers 对算法、内存、CPU 和并发的真实支持。若安全参数无法在 Free 10ms 稳定运行，完整账号服务应升级 Workers Paid，或者另行确认 OAuth/托管认证方案；绝不为了免费把算法改成快速 SHA-256 或降低到不安全参数。

密码字段只存带算法/参数/盐的 hash；认证实现要有独立安全审查，不自行发明算法。高熵随机 session token 放 HttpOnly、Secure、SameSite Cookie，D1 只存 token hash。默认会话不每次访问写续期时间，避免写放大。退出和改密撤销会话。

注册/异常登录服务端验证 Turnstile、限制来源和失败速率、采用通用错误信息。Turnstile 不是身份提供方，也不替代 CSRF、速率和账号权限检查。[S9]

### 9.2 找回与邮件

不要把免费 Email Routing 当作给任意注册用户发验证码的免费 SMTP。当前 Cloudflare Email Service 向任意收件人发信需要 Workers Paid，含每月 3,000 封，再按量收费；免费向账户内已验证目的地址发送与普通用户发信是两件事。[S27]

Free 验证档可先提供一次性高熵恢复码，邮箱字段不标为已验证，不承诺未配置的邮件找回；正式启用邮件找回需开通合适服务与发信域。用户无邮箱且丢失恢复码时，不通过人工猜测身份重置。

### 9.3 不可信内容与 SSRF

外链和用户规则都是数据，不能覆盖系统指令、读取 Secret 或发起工具调用。模型生成的内容永不直接变成 SQL/JS。评论 HTML 做白名单清洗，URL 仅 http/https，禁止 script、事件属性和危险协议。

抓取不接收任意用户指定 URL。验证 HN 来源仍不能替代 SSRF 防护：禁止 IP 字面量、localhost、私网/保留网段、非允许端口、URL 凭据；校验每次重定向和 DNS 结果。解析后再 fetch 存在 DNS rebinding/TOCTOU 风险，域名预检查不是完美防线；抓取 Worker 不绑定内网服务/私人 tunnel，不携带任何账户 Cookie，严格限制响应体，必要时只允许已验证公网域或采用能绑定目标 IP 的受控出口。

任何 Secret 不出现在公共仓库、日志、R2 公开桶或前端包。Sync 不拥有 Jev 密钥；仅 jobs 拥有必要 AI 权限。生产和预览数据库、bucket、Turnstile key 完全分开。

## 10. 存储与生命周期

| 数据 | 存放 | 默认保留/策略 |
| --- | --- | --- |
| 活跃投稿与小画像 | D1 | 90 天起点，7 天参与默认排序；容量预警时优先清可重建缓存。 |
| 评论缓存 | D1 | 按需，约 7 天活跃 TTL；极大文本限制体积。 |
| 抽取后的正文 | 私有 R2 Standard | 默认 30 天；不保存全部原始 HTML，不公开全文镜像。 |
| 公共排序快照 | 私有 R2 + D1 指针 | 48 小时，支持稳定翻页；活跃读者过期后明确刷新。 |
| 私人快照 | 私有 R2 + D1 owner | 默认 24 小时；删除账号/规则时进入清理任务。 |
| 用户规则、收藏 | D1 | 用户删除或按公开政策处理；不因清 HN 缓存而删除收藏。 |
| 已完成任务 | D1 | 7 天后批量清理，长期只保留聚合统计。 |
| 失败任务与必要审计 | D1 | 默认 30 天，脱敏。 |

清理 D1 时遵守外键依赖顺序：无引用的旧分析/文档版本才删除。R2 生命周期是兜底，不能先删正文后仍声称提供原文证据。删除账号先停用会话与访问，再清数据库和 R2 私人对象；失败可重试。

D1 Free Time Travel 当前为 7 天。额外导出仅通过受限运维流程进行，导出加密后存私有 R2，绝不把包含密码 hash 和私人规则的备份提交到公开 GitHub。[S6]

## 11. 容量与费用：用工作量而非用户数口号估算

以下全部是工程示例，不是 HN 实际投稿量、实测延迟或容量保证。Cloudflare 和 AI 用量分开算。

### 11.1 假设基线

每天 500 个待理解的独立正文版本，7 天 3,500 个候选；100 日活，每人 10 次动态列表访问；每日 100 个私人完整排序重建、100 个私人专项判断。假设默认模型输入约 5,000 tokens/公共版本，实际计数必须包含问题等输入。

### 11.2 Workers 与子请求

粗算动态请求为页面/API + Cron + consumer + 注册等。三个 Cron 每日 1,440+144+24=1,608 次；一篇正文两个阶段约 1,000 次 consumer；公开发布上限 7×144=1,008 次。加上浏览和私人操作，示例仍低于 100,000/日。

外部 fetch 子请求不等于每个都被计为新的 HTTP 入站请求，但有单 invocation 限制和上游负载。更重要的风险通常是单次 10ms CPU，不是总请求条数。[S1][S3]

### 11.3 Queues

公共抽取与分析：500×2=1,000 消息；公共发布：7×144=1,008 消息；私人重建与专项合计 200 消息。合计 2,208 消息，一般至少 6,624 操作/日；加 20% 重试/额外余量约 7,949，尚未包含任意额外任务。

所以每个评论、每次元数据检查都进队列不是免费好方案。超过预算时先降低公共发布频率、减少冷内容重验证、排队私人重建，不永久丢弃低热度投稿。单用户额度不能保证全站额度足够。[S7]

### 11.4 D1 读放大

全量扫描 3,500 候选、7 预设、每天 144 次，会产生至少 `3,500×7×144=3,528,000` 行读，尚未包含 join 和索引。每日 100 个私人重建再增加约 350,000 候选行读。这个量已接近 5M 日额度，不能因为 SQL 只有几条就认为几乎免费。

因此：公共分数预计算并建必要索引；无新分析和规则变化时复用；使用脏标记合并；优先局部更新；读预算超过 70% 后将发布间隔从 10 分钟调到 20–30 分钟。完整快照是否全量构建由实际 rows_read 决定；不能靠减掉冷门候选掩盖扫描成本。

页面只 hydrate 当前 30 项：1,000 次列表访问约 30,000 条 item 结果，另加指针、会话、索引和评论。用户增长后先看完整每日预算，而不是只看这 30,000。

### 11.5 D1 写放大

若每分钟重写 500 条故事，一天 `500×1,440=720,000` 条主表写，未含索引，明显超过 100K。批量 SQL、UPSERT 和 transactions 不会把这些变成一行写。[S5]

必须按变化写入、把列表存成一个有序 ID 快照而不是每次改 500 个 rank、减少不必要索引，不为每次页面读写 last_seen。七个预设的每篇评分仍会增加行及索引成本，必须计入。

初始内部警戒值：全站 D1 行读 3.5M/日、行写 60K/日、Queues 7K 操作/日、库体积 350MB。它们是预警/降级起点，低于官方上限，为日志延迟、并发和账户其他用途留余量。

### 11.6 R2

假设正文平均 30KB，500×30KB×30天≈450MB，不含大文、版本、备份及排序快照。初始可在 10GB-month 免费范围内，但以实际日峰值和版本数量计费，不是简单的月末文件大小。

R2 Standard 超额才付费；Infrequent Access 不享受同样免费额度，不选它。不要默认公开 r2.dev 当生产 CDN；本站 Worker 通过绑定读取私有对象。[S8]

### 11.7 AI 与正式运行账单

公共判断示例：500×5,000×30=75M 输入 tokens；按官网当前输入单价约 $3.15/月。只代表该假设公共输入部分，专项判断、重试、问题长度、规则编译和不同提供方费用另计。[S22]

低成本完整档当前 Workers Paid 最低 $5/月，包含一定请求/CPU 和 D1 用量，但不是固定总价包无限资源。[S1] 预算决策顺序：先按免费架构减少重复，再以真实用量评估；不能为了省 $5 持续牺牲注册安全或维护复杂的额度规避系统。

## 12. 熔断与故障降级

### 12.1 分级保护

L0 正常：分钟发现、异步分析、10 分钟脏快照发布。

L1 预警：暂停历史回填与冷数据主动刷新，公共排序降到 20–30 分钟；保留最新投稿发现和访问读取。

L2 紧张：暂停新私人重建/专项判断，保留旧快照与明确状态；限制新账户高成本动作；不改变已保存规则含义。

L3 官方额度/上游故障：API 返回可理解错误、Retry-After 和状态页；服务静态故障说明与 HN 原站链接。D1 完全不可用时不承诺动态页面/登录继续可用，不从不可信缓存放行私有访问。

### 12.2 AI 预算

按 UTC 日原子预留账户和全站 token/任务额度，任务成功后结算实际 usage，失败区分未调用和已调用不确定。D1 batch 中用条件写、唯一 reservation key 和检查结果实现；只在内存里累加计数不可靠。

对已发出但失去响应的 AI 请求保留保守占用。账单告警不是平台硬停机开关；R2 与付费 Workers 仍需应用上限、供应商限额和人工监测，多层防止意外费用。

### 12.3 监测

记录 CPU p50/p95/p99、1102、D1 rows_read/written、数据库体积、Queue 操作/重试/最老任务、HN ID lag、正文成功率与 partial 比例、公共分析覆盖、预设发布时间、Jev usage 和私人规则未覆盖数。日志不保存密码、令牌、完整私人规则或全文。

低票内容最老等待时间是独立指标，避免成本控制变成只服务热门文章。

## 13. 运行配置草案

以下是部署契约示例，不是当前可直接上线的仓库代码；入口文件、资源和 Secret 尚未创建。数据库 ID 必须用实际 provision 结果替换。固定 compatibility_date，在 staging 验证后才升级。

```jsonc
// jevnews-web / wrangler.jsonc（示意）
{
  "name": "jevnews-web",
  "main": "src/index.ts",
  "compatibility_date": "2026-09-19",
  "workers_dev": true,
  "assets": { "directory": "./public", "binding": "ASSETS" },
  "d1_databases": [{
    "binding": "DB", "database_name": "jevnews-main",
    "database_id": "<真实数据库UUID>"
  }],
  "r2_buckets": [{ "binding": "CONTENT", "bucket_name": "jevnews-content" }]
}
```

```jsonc
// jevnews-sync：与上述资源绑定相同，但关闭公网 workers.dev
{
  "name": "jevnews-sync",
  "main": "src/index.ts",
  "compatibility_date": "2026-09-19",
  "workers_dev": false,
  "triggers": { "crons": ["* * * * *", "*/10 * * * *", "23 * * * *"] },
  "queues": { "producers": [{ "binding": "JOBS", "queue": "jevnews-jobs" }] }
}
```

```jsonc
// jevnews-jobs：补齐 D1/R2/AI 绑定后使用
{
  "name": "jevnews-jobs",
  "main": "src/index.ts",
  "compatibility_date": "2026-09-19",
  "workers_dev": false,
  "queues": { "consumers": [{
    "queue": "jevnews-jobs", "max_batch_size": 1,
    "max_concurrency": 2, "max_retries": 5
  }] },
  "ai": { "binding": "AI" }
}
```

Secret 至少区分 TYPESAFE_API_KEY、SESSION_PEPPER/令牌签名密钥、TURNSTILE_SECRET_KEY、运营监测凭据。站点 key 是公开配置，secret key 不公开。示例省略的共享 bindings 必须在实现时补齐，不声称以上三个片段能直接部署完整系统。

目录建议：`apps/web`、`apps/sync`、`apps/jobs`、`packages/domain`、`packages/db`、`packages/hn`、`packages/analysis`、`packages/auth`、`tests/fixtures`。不为凑微服务再拆网络 API。

## 14. 验证、发布和退出路径

### 14.1 开发与发布

本地 Wrangler/D1 模拟 + 固定 HN fixture；CI 不持续抓真实 HN，不默认调用付费 AI。Cloudflare Workers Builds 连接 GitHub，lint/typecheck/单测/HTML 对照通过后部署 staging；生产迁移先 additive，再部署兼容代码，稳定后清旧字段。

只在部署时构建静态资源，不用每分钟触发 CI 来更新榜单。生产和 preview 用不同资源；外部 PR 构建不获得真实 API key 或生产数据。

### 14.2 必须通过的实测门槛

| 测试 | 通过标准 |
| --- | --- |
| HN 还原 | 固定桌面/移动 viewport 对比列表、评论、More、登录与新控件；不虚报 99% 已测得。 |
| Free CPU | SSR、单篇抽取、规则处理、发布、密码 hash 分别在真实 Workers 测量；反复超过 10ms 的路径不能当作 Free 可用。 |
| 配额 | 记录至少覆盖峰值场景的实际 meta/队列/日志，验证未全量重复写。 |
| 新帖公平性 | 低票新帖进入处理池，积压有覆盖提示；断线后 gap 可补。 |
| 幂等 | 重投、lease 过期、R2 写成功/D1 失败、AI 响应丢失均有恢复路径。 |
| 账户隔离 | 跨用户规则、snapshot、私人评估访问被拒绝；Session/CSRF/注销回归。 |
| 内容安全 | SSRF、重定向、超大 HTML、XSS、prompt injection 测试；private 数据不进入公共 cache。 |
| 稳定分页 | 同一个 snapshot 翻页不受后台重排影响，已知删除能覆盖。 |
| 额度故障 | D1/Queues/Workers/AI 分别耗尽时不假装成功，不放松硬过滤。 |
| 恢复 | 从 D1 导出/Time Travel 和 R2 元数据恢复，明确实际 RPO/RTO 后再对外承诺。 |

### 14.3 升级顺序

先升级 Workers Paid 解决安全计算/CPU/日额度，再增加必要的任务并发；存储继续用 D1/R2。只有出现单库写入、查询复杂度、全文搜索或地域要求等真实瓶颈，才考虑独立 PostgreSQL。前端 HN 风格和业务 schema 不随套餐改变。

SQLite/D1 特有 SQL 隔离在 packages/db；业务画像和快照采用版本化 JSON，方便迁移。导出和 Secret 管理属于正常运维，不靠公开 GitHub 保存用户数据。

## 15. 本轮已验证与未验证

已核对官方产品文档和当前免费额度；参考 schema 在本地 SQLite 创建成功，进行了跨用户私人评估外键拒绝、条件租约领取和 foreign_key_check 测试。

未进行 Cloudflare 账户授权、建库、R2 订阅、域名购买、Workers 部署、生产 scrypt/抽取 CPU 测试、真实同步压测或 Jev API 调用。本文件没有宣称这些工作已完成。参考 SQL 是设计附件，不是已执行迁移；Cloudflare D1 远程兼容性仍需验证。

## 16. 官方参考

查阅日期：2026-09-19。数值来自对应官方页；方案参数、数据量及费用示例是本设计假设。

- [S1 Workers 定价](https://developers.cloudflare.com/workers/platform/pricing/)
- [S2 Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
- [S3 Workers 限制](https://developers.cloudflare.com/workers/platform/limits/)
- [S4 Static Assets 计费](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/)
- [S5 D1 定价与超额行为](https://developers.cloudflare.com/d1/platform/pricing/)
- [S6 D1 限制](https://developers.cloudflare.com/d1/platform/limits/)
- [S7 Queues 定价与免费保留时间](https://developers.cloudflare.com/queues/platform/pricing/)
- [S8 R2 定价](https://developers.cloudflare.com/r2/pricing/)
- [S9 Turnstile 计划](https://developers.cloudflare.com/turnstile/plans/)
- [S10 Workers AI 定价](https://developers.cloudflare.com/workers-ai/platform/pricing/)
- [S11 Workers Builds 额度](https://developers.cloudflare.com/workers/ci-cd/builds/limits-and-pricing/)
- [S12 workers.dev](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/)
- [S13 Cloudflare Registrar](https://developers.cloudflare.com/registrar/)
- [S14 R2 开通](https://developers.cloudflare.com/r2/get-started/)
- [S15 D1 SQL/SQLite 支持](https://developers.cloudflare.com/d1/sql-api/sql-statements/)
- [S16 Hono 官方部署指南](https://developers.cloudflare.com/workers/framework-guides/web-apps/more-web-frameworks/hono/)
- [S17 Cache API](https://developers.cloudflare.com/workers/runtime-apis/cache/)
- [S18 HN 官方 API](https://github.com/HackerNews/API)
- [S19 Durable Objects 定价与可用性](https://developers.cloudflare.com/durable-objects/platform/pricing/)
- [S20 HTMLRewriter](https://developers.cloudflare.com/workers/runtime-apis/html-rewriter/)
- [S21 Browser Run 定价](https://developers.cloudflare.com/browser-run/pricing/)
- [S22 TypeSafe 官网](https://typesafe.ai/)
- [S23 Workers AI JSON Mode](https://developers.cloudflare.com/workers-ai/features/json-mode/)
- [S24 D1 batch API](https://developers.cloudflare.com/d1/worker-api/d1-database/)
- [S25 Workers node:crypto](https://developers.cloudflare.com/workers/runtime-apis/nodejs/crypto/)
- [S26 OWASP Password Storage](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)
- [S27 Cloudflare Email Service 定价](https://developers.cloudflare.com/email-service/platform/pricing/)
