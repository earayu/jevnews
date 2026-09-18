# JevNews：Cloudflare 实现设计

> v1.1 · 2026-09-19 · 与首版代码对应。价格评审见 [预算与 DO](reuse-cost-and-durable-objects.md)，部署见 [操作手册](../deployment.md)。

## 1. 最终架构

```text
Browser → Static Assets (CSS/JS) + Hono SSR
                         ├─ D1: accounts, HN items, rules, analyses, jobs, budgets
                         └─ private R2: extracted text + immutable feed snapshots
Cron (5 min watchdog) → SyncCoordinator DO → bounded HN discovery
                                               ↓ persistent D1 outbox
Queues → task handlers → source fetch / Jev / Workers AI / snapshot publishing
```

初始为一个 `src/index.ts` Worker，导出 fetch、scheduled、queue 和 `SyncCoordinator`。同一个 Worker 生产/消费队列，已在本地 workerd 测试。逻辑模块可将来拆分，不先维护三个部署和跨 Worker binding。

Hono + TypeScript + 服务端字符串模板/严格 escaping + 普通 CSS + 少量原生 JS。动态页面不是无限免费静态资源。public 目录只放源码静态文件；demo 数据仅本地预览脚本使用。

## 2. 模块与责任

| 模块 | 责任 |
| --- | --- |
| core.ts | 七预设、受限 DSL 校验、三值匹配、排序、精选、重复和主题分散 |
| security.ts | scrypt、随机会话、HTML/URL 处理、Origin、本地模式判断 |
| sources.ts | HN 固定源、体积/超时上限、DNS 检查、robots、重定向和正文抽取 |
| db.ts | D1 小查询、预算原子增量、R2 快照、owner/expiry 检查 |
| tasks.ts | 幂等任务、持久 outbox、租约、退避、重试和错误脱敏 |
| providers.ts | TypeSafe typed API、token 预留/结算、Workers AI 编译与验证 |
| pipeline.ts | HN 同步、抽取/分析、公共发布、私人评估和清理 |
| web.ts / views.ts | 真实 HTML 路由、认证、CSRF、私人规则、阅读状态、受控后台入口 |
| index.ts | Worker 入口、DO Alarm、Cron 看门狗和 Queue consumer |

## 3. 数据模型

唯一权威 DDL 是 `migrations/0001_initial.sql`。`docs/architecture/cloudflare-schema.sql` 是其等字节镜像，测试检查一致。当前 15 张表，不再保留旧设计中未使用的 21 表模型。

- `users/sessions`：本站身份、密码/恢复码 hash、会话 hash、CSRF 和过期时间。
- `hn_items/documents/analyses`：HN 原始展示字段、正文指针、内容哈希和模型/rubric 版本。
- `private_rules/evaluations/user_item_state`：owner 绑定的规则、复判和阅读状态；评估使用复合外键阻止错配 owner。
- `checkpoints/jobs/budgets/ai_calls`：游标、outbox、原子额度与每次 AI 请求预留/实际/不确定状态。
- `feeds/feed_heads/request_limits`：快照元数据和当前指针、短周期限流。

D1 使用 SQLite 语义，没有 PostgreSQL 连接池或 SKIP LOCKED。条件 UPDATE RETURNING 领取租约，batch 用于数据库内原子写入。R2、D1、Queue、外部 HTTP 之间没有统一事务，不能宣称严格 exactly-once。

`storeItem` 仅在 HN 展示字段变化时更新，避免只改 last_seen 产生写放大。候选读取按最近 7 天有索引查询，默认最大 10,000，并显示截断。正文存在私有 R2，数据库不保存大型 HTML。

## 4. 快照与排序

公共画像按 `(content_hash, model, rubric)` 复用，不因 HN points 或评论数变化重新调用 Jev。七预设每次共享一批候选查询；当前仍在内存中分别计算排序，尚非全增量排名索引。

排序包含主题、类型、深度/证据、一手经验、新鲜度、小幅封顶的 HN 分数信号；同文去重，连续同主题过多时穿插其他候选。硬条件先执行，未知不匹配，探索和例外均不能越过硬排除。

发布先写不可变 R2 JSON，再原子写入 D1 feed/head。R2 成功而 D1 失败可能留下孤儿对象，依赖生命周期清理；不会在对象未写好前发布 head。私有快照读取验证 owner、view、version 和 expiry。

每页 30 ID；More 固定 snapshot，读取 ID 对应的最新展示字段过滤已知删除状态。不会因为后台刷新而在当前页自动跳位。公共快照 48h、私人快照 24h；旧快照自然过期，接口明确报错。HN 来源列表变化或距上次发布超过 12h 时重新发布，避免长期不变的榜单指向过期快照。

当前 all 列表的标签较简单，picks 采用初始阈值；尚未完成真实读者标注校准。代码的模型确定性不作为文章正确率。

## 5. 任务与同步

详见 [同步协议](data-sync-and-reuse.md)。DO 固定 ID `hn-global-v1`；只通过 binding 被 Cron/后台管理入口调用，不接受公共 URL 任意控制。默认每 60s 设置 Alarm，配置范围 10s–300s；异常指数退避至 5min。

Cron 每 5min 检查是否有 Alarm 并发送积压 outbox；每天 UTC 03:17 清理。不是每 5min 再启动一套完整同步。

任务 ID 是 kind + 业务版本键的哈希，D1 先持久化再派发。Queue 内容只有 job ID。领取租约 5min，完成写带 lease token；重复消息无法同时领取同一个有效任务。每次最多 dispatch 40 条、Queue batch 5、并发 2，运营者按真实积压调整。

暂时失败退避，最多 5 次实际尝试后进入 failed；额度/未配置用 Deferred 延迟且不扣失败次数。Queue ack 只意味着 D1 已记完处理或失败状态，重试由 outbox 负责。Queue 自身还有投递重试与 DLQ。

零响应/未知 ID 的失败任务保留用于运维，不假装补全。失败任务需由运营者审查原因后重置；没有自动无限重试或自动吞掉历史缺口。

## 6. Jev 与规则编译

调用 `POST https://api.typesafe.ai/v1/systemone`，body 为 model、state、questions；questions 是 noul/score/choice。读答案分别使用 noul/score/choice 字段，验证类型、范围、枚举及 usage，不使用臆造的 value 字段。

多问题共享同一正文请求；state 的内容标记为不可信数据。调用前按 payload UTF-8 字节数加余量预留 token；返回实际 input_tokens 后结算。预留是保守估算而非供应商保证的上界。网络不确定保留 reservation，重试另记请求；不隐藏重试计费风险。

三开关 `SYNC_ENABLED`、`ANALYSIS_ENABLED`、`RULE_COMPILATION_ENABLED` 默认 false。无 Key 或关闭时，任务明确待处理，不生成假分析。

Workers AI 仅返回受限 JSON DSL，所有字段经 validateRule，用户审核后保存。不能产生 SQL、可执行代码、任意抓取指令。最多 3 专项条件，对具备 substantive 正文分析的相关候选有限复判；未知/未评估不满足 must 条件。

Workers AI 默认每日 100 调用上限、用户20次编辑，Jev 默认每日20M预留/已结算 token 预算。调用数不等于 Neurons，token 上限不等于硬美元账单上限。必须监测真实供应商用量。

## 7. 安全与认证

密码 scrypt N32768/r8/p3，随机盐32字节，派生key32字节，maxmem64MiB；最少12字符、最多128字符/512字节。已在本地真实 workerd 注册测试，不以免费CPU限制为理由降低密码参数。

会话仅保存随机 token 的 SHA-256，cookie HttpOnly、SameSite=Lax、Secure、__Host- 前缀；本地 loopback 环境使用开发cookie。所有写表单要求 Origin 与当前源相同以及 CSRF token。logout/账号删除为 POST，敏感删除再验证密码。恢复码只显示一次，使用后轮换并注销旧会话。

生产注册/登录验证 Turnstile success、hostname、action，配置缺失 fail closed。开发旁路要求 APP_ENV=development 且请求 hostname 是 loopback，不能仅切字符串就在公网旁路。

第三方 HTML 不直接插入：重建少量标签、只保留校验链接、不保留来源事件属性。源请求限制 scheme/credentials/port/DNS/redirect/size/time，并保守遵守 robots。DNS检查与最终连接之间未实现地址固定，不能将其宣称为经过安全审计的完整 SSRF 防护；部署不得给通用正文fetch挂入私网能力。

私人页面和所有当前动态响应 no-store，公共缓存不携带账号数据。后台端点需要至少32字符随机 Bearer secret。生产日志不得记录请求正文、规则全文、密码、Key、会话或恢复码。

## 8. 保留、删除、故障

R2 必须配置 `documents/` 30天、`snapshots/` 3天生命周期；这不是应用提交后自动配置的云设置。D1 删除过期会话、完成任务(3天)、限流桶(2天)、用量记录(90天)，分批清理过期快照。普通元数据和分析过90天清理，保存过的 item 保留；故障或大规模积压可能延长清理，需监测。

账号删除先移除可索引的私人 R2 快照，再删除owner数据及任务；并发失败留下的不可访问孤儿对象最终由 R2 TTL清理。源删除仅影响该 HN item，不误删相同外链其他有效投稿。

HN停机保留已发布快照；Jev/AI停机不影响已有结果；D1停机时动态站点不能保证继续服务。当前不包含离线全站缓存、HA承诺或自动备份恢复流程；操作手册提供手动导出和演练步骤。

## 9. 验证边界

本地：严格类型、Node测试、SQLite约束、Wrangler dry-run、本地workerd/D1/R2/Queue/DO联通。供应商外部响应在自动化测试中使用fixture。

未验证：远程D1/DO部署、多地域负载、实时HN完整性、真实Jev/Workers AI质量/账单、安全审计、99%像素一致。交付状态中的未完成项仍然有效。

## 10. 一手接口资料

本设计依据当前已核对的接口，落地前需再次确认控制台与套餐。资料不是本项目已通过云验收的证明：

- https://developers.cloudflare.com/workers/platform/pricing/
- https://developers.cloudflare.com/d1/platform/pricing/
- https://developers.cloudflare.com/durable-objects/api/alarms/
- https://developers.cloudflare.com/queues/configuration/javascript-apis/
- https://developers.cloudflare.com/r2/buckets/object-lifecycles/
- https://github.com/HackerNews/API
- https://github.com/typesafe-ai/typesafe-sdk-js/blob/main/src/types.ts
