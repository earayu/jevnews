# JevNews：HN 复刻复用、月度成本与 Durable Objects 评审

> 日期：2026-09-19（UTC+8）  
> 状态：源码与官方文档评审；未导入第三方源码、运行这些复刻的构建、部署服务或取得生产账单。  
> 对应：[Cloudflare 主设计](cloudflare-design.md)、[产品需求](../product-requirements.md)。  
> 本文补充技术选型与预算，不修改七套预设、私人规则需注册、暂时免费、HN 原样阅读等产品要求。价格按本次查阅的官方文档；使用量均为明确假设而非实际 HN 流量。

## 1. 结论

采用第三种路线：**独立的 Cloudflare/Hono 工程 + 按许可证选择性移植 HN 复刻的展示层 + 自建 JevNews 业务与数据层**。

不整仓 fork 一个演示项目后逐步改造成产品，也不拒绝复用而重新发明所有列表、评论和排版细节。主设计继续使用 Hono/TypeScript、服务端 HTML、普通 CSS 和少量客户端脚本。

建议初版增加一个轻量 SQLite-backed `SyncCoordinator` Durable Object，只负责同步调度与重复触发协调。默认仍可每 60 秒检查，具备切换到约 10 秒的能力；Cron 保留为看门狗和维护任务。D1、R2、Queues 的职责不由 DO 全部替代。此为本轮实现建议，不表示已经部署。

预算方面：建议公开服务直接按 Workers Paid 的每账户最低 $5/月计算，不把安全密码计算、正文处理和完整产品能力绑定到免费 HTTP 的 10ms CPU 限额。基准情景下，100 日活约 $13、1,000 日活约 $20、10,000 日活约 $90/月，均为未加波动余量的测算；推荐分别预留 $15–25、$25–45、$100–160/月。独立域名、税费、人工、付费代理和额外产品能力另计。

## 2. HN 开源复刻：检查结果

### 2.1 clintonwoo/hackernews-remix-react

检查了 `package.json`、`src/cookies.ts`、`src/routes/vote.ts`、样式检索、仓库树和 LICENSE。[R1]

- package.json 使用 Remix 1.2.0、React 17.0.2，启动脚本为 Node/Remix 服务。这里仅报告代码中的版本，不据此宣称存在某个未核实的漏洞。
- README 明确说明部分剩余功能以内存实现，并非完整的生产持久化产品。[R2]
- `src/cookies.ts` 使用固定的演示会话密钥，认证部分不能原样部署。
- `src/routes/vote.ts` 调用本地 itemService；不能把演示动作误当作已经解决 HN 官方写入授权。我们的投票、回复和提交仍应回 HN。
- `src/assets/news.css`、页面模板和阅读操作是值得参考的部分；存在页面测试目录，但没有运行这些测试，不声称已验证覆盖率或通过率。
- 仓库根许可证为 MIT。具体文件和附带图片还需审核来源，不假设根许可证自动覆盖 HN 商标和所有上游素材。

**结论：作为传统 HN 展示层的主要候选参考，不继承旧依赖、演示认证、内存业务或部署脚本。**

### 2.2 vercel/next-react-server-components

检查了根目录、`package.json` 和 `components/header.tsx`。[R3]

- 本次 package.json 为 Next 14.2.35、React 18.3.1。
- header 中多个导航项及 login 为 `<span>`，不是已实现的路由和账号行为；代码还有重复 show 标签。这是框架示例而非现成完整产品。
- 列表与评论的组件划分、局部 CSS 可作为补充参考。
- 不因为维护者是 Vercel，就假定示例已经覆盖登录、数据同步、私人规则和生产异常处理。

**结论：参考组件拆分，不作为整仓底座。** 继续使用 Hono 的理由是适配当前产品与部署，而不是断言 Next.js 不能部署到 Cloudflare。

### 2.3 nuxt/hackernews

检查了 README、`package.json` 和样式源码搜索结果。[R4]

- 本次 package.json 使用 Nuxt 4.5.2 范围及 NuxtHub，包含单元、Nuxt 与端到端测试脚本；README 说明托管于 Cloudflare Pages。
- 不能把它一概归为陈旧 demo：它是本次候选中值得认真考虑的现代 Nuxt 路线。
- 但是当前 `app/app.vue` 的顶部颜色、字号，以及 `PostItem.vue` 的 20px/30px/80px 大内边距，体现的是重新设计的阅读器，并非我们要求的 HN 原样紧凑列表。
- 换用它仍需重做 UI 贴合、接入 D1/R2/队列、账号及所有 Jev 业务；Cloudflare 适配只能解决其中一部分。

**结论：团队明确选择 Vue/Nuxt 时可作为整体起点；在当前 HN 99% 外观和轻量服务端页面目标下，不为它更换技术栈。**

### 2.4 ibodev1/hackernews

检索 Hono/Cloudflare 同栈项目时发现；检查了 README 和完整仓库树。[R5]

- 它是 Hono + Workers 的 HN API 包装器，不是包含完整 HN UI 的复刻。
- 本次树中没有看到独立 LICENSE 文件；不把公开可见自动视作可直接复制的授权。

**结论：可阅读接口组织方式，不导入为 UI 底座，也不在许可未确认时复制代码。**

### 2.5 复用边界与实施顺序

| 可移植/参考 | 需要重写或独立实现 |
| --- | --- |
| 列表和评论的 HTML 结构、作者/时间展示、页面布局 | HN 增量同步、数据版本、D1 模型和安全权限 |
| 经来源审核的 CSS、纯格式化函数 | 正文抽取、Jev 画像、七套预设、私人条件和预算 |
| 评论折叠的交互意图、导航和分页案例 | 生产认证、会话、CSRF、输入净化、恢复流程 |
| 可独立改写和维护的测试用例 | 与旧框架绑定的 loader/action/hooks、内存投票与社区写操作 |

实施时先建 Cloudflare 原生骨架；固定候选源码版本并逐文件记录来源；把可用展示结构移植为 Hono 模板/JSX，不带入 React hooks 或 Remix runtime；补写真实链接与本站状态；最后用固定 HN 测试数据进行桌面和窄屏视觉对比。

`THIRD_PARTY_NOTICES` 应记录实际复制文件、来源 commit、修改情况及对应许可；未复制的参考项目不假装已经导入。使用 JevNews 自有品牌和图标，不复制 HN 登录身份。

这是源码层面评审，不是像素一致性结论。选定页面仍须实测 HTML、评论折叠、More、返回恢复、XSS 和账号隔离。

## 3. 月费：区分免费试验与 $5 付费计划

官方当前 Workers Paid 最低为每账户 $5/月，不是每个 Worker 或每个产品都另付 $5。Workers 含每月 1,000 万请求和 3,000 万 CPU ms；超额分别为 $0.30/百万请求和 $0.02/百万 CPU ms。[C1]

在这个付费计划下，D1 含每月 250 亿行读、5,000 万行写及 5GB 存储；超出分别为 $0.001/百万行读、$1/百万行写、$0.75/GB-month。[C2]

因此不能一边采用 $5 付费方案估算账单，一边仍用 D1 免费的每日 10 万行写作为它的限额。读写优化仍然重要，但不应为免费额度设计复杂规避系统。

Queues Paid 含每月 100 万次操作；超出为 $0.40/百万操作。消息通常有写、读、删三次操作，重试增加读操作；不是每批只算一次。[C3]

R2 Standard 每月含 10GB-month、100 万 Class A 和 1,000 万 Class B；超额存储与操作按其独立价目计费。[C4]

以上包含用量大多按账户共享。预算假设这是该账户的主要工作负载，其他项目占用额度会改变结果。本文估算没有订阅网站 Pro 计划，也不把网站 Pro 与 Workers Paid 混为一谈。

## 4. 可复算的基准模型

### 4.1 输入假设

| 参数 | 假设 |
| --- | --- |
| 月长度 | 30 天 |
| 公共新正文版本 | 每天 1,000 篇，跨所有用户共享；不是对 HN 当前投稿量的实测 |
| 公共分析总输入 | 每篇 6,000 tokens，包括正文、标准及问题等实际计费输入 |
| 动态访问 | 每名日活用户每天 20 次 Worker 动态请求；静态 CSS/JS 不混入 |
| 后台调用余量 | 每月额外 100 万次 Worker 调用、1,000 万 CPU ms，用于同步、抓取、队列、认证等的初始预算假设 |
| 动态平均 CPU | 每次 15ms，尚未压测；不是对 Hono 或任何克隆的基准测试结论 |
| 每天实际使用专项判断的人数 | 日活的 10%；不是所有注册账号每天都运行任务 |
| 专项评估 | 每名专项活跃用户每天 20 个新评估组，每组总计 3,000 输入 tokens |
| 专项输入覆盖 | 3,000 tokens 可包含相关摘录与条件；需要更多正文时按实际 token 增加，不能截断后仍宣称完整判断 |
| D1 / R2 | 假设分别保持在付费包含用量与 R2 Standard 免费用量内；不是无限数据承诺 |
| Workers AI | 规则编译先受免费日额度控制；本表不含额外付费编译。高峰用尽后排队，若改为自动付费须补预算 |
| 未计项目 | 税费、独立域名、人工、付费代理、全站浏览器抓取、PDF/OCR、翻译和长摘要 |

类型安全 AI 官网当前 Jev 单价为每十亿输入 tokens $42，即每百万 $0.042。[J1] 实际计费以请求 usage 为准，不能把文章长度等同于总输入量。

### 4.2 公式

```text
public_ai = articles_per_day × tokens_per_article × 30 / 1,000,000 × 0.042
          = 1,000 × 6,000 × 30 / 1,000,000 × 0.042
          = $7.56 / month

private_ai = DAU × 10% × 20 × 3,000 × 30 / 1,000,000 × 0.042
           = DAU × $0.00756 / month

worker_requests = DAU × 20 × 30 + 1,000,000
worker_cpu_ms   = DAU × 20 × 30 × 15 + 10,000,000
workers_cost    = 5
                + max(0, worker_requests - 10,000,000) / 1,000,000 × 0.30
                + max(0, worker_cpu_ms - 30,000,000) / 1,000,000 × 0.02

queue_operations = 270,000 + DAU × 10% × 20 × 30 × 3
queue_cost       = max(0, queue_operations - 1,000,000) / 1,000,000 × 0.40
```

队列固定 270,000 操作假设公共流水线每正文版本产生三个小消息、每消息三个操作。回填和重试另算；消息超过 64KB 时计量也会变化，所以只传任务 ID。

### 4.3 情景结果：美元/月

| 成本 | 100 日活 | 1,000 日活 | 10,000 日活 |
| --- | ---: | ---: | ---: |
| Workers Paid 与超额 | 5.00 | 5.00 | 6.40 |
| 公共 Jev 分析 | 7.56 | 7.56 | 7.56 |
| 私人专项 Jev 判断 | 0.76 | 7.56 | 75.60 |
| Queues 超额 | 0.00 | 0.00 | 约 0.43 |
| D1、R2、单个同步 DO 的额外费用 | 0（在假设包含额度内） | 0（同左） | 0（同左） |
| 基准合计 | **13.32** | **20.12** | **约 89.99** |
| 推荐准备的预算 | **15–25** | **25–45** | **100–160** |

这里是推演而非报价或成本上限。D1 单库吞吐、锁竞争、请求延迟和 CPU 仍需压测，处于计费额度内不表示性能必然达标。算法全池扫描、重复解析和不受控爬虫会改变模型。

独立域名按实际年费除以 12 另加；使用 workers.dev 时没有独立域名购买费。余额告警不等于 Cloudflare 提供整个账户的自动硬停费上限。

### 4.4 敏感性

- 公共分析在每天 500–1,500 篇、每篇 4,000–8,000 总输入的组合边界下，约 $2.52–15.12/月。七套预设复用画像，不应机械再乘以七。
- 私人输入由 3,000 增到 6,000 时，其 AI 成本翻倍；三条条件是否共享正文应通过实际 usage 核验。
- 每日 100 个专项评估组是防滥用上限，不是预算中的平均使用值。
- 若每个日活用户都每天用满 100 组，每组 3,000 tokens，私人 AI 单独就是每名日活每月 $0.378；1,000 日活约 $378，10,000 日活约 $3,780，其他成本另计。
- 以基准输入补分析七天的 7,000 篇旧正文，单次 Jev 输入约 $1.76；多次重跑整个语料或更换模型版本需要另计。
- 不因用户注册过就永久为其全部私人规则后台复判；只为近期活跃且已激活的规则创建新任务，已有结果保留。

建议上线先预留 $30/月级别预算，以实际文章输入、专项用户比例和 CPU 修正。业务层对新增 Jev 任务做总量预留、并发控制和暂停；达到预算时保留已有结果和普通阅读，不默默丢掉硬条件或声称全部已评估。

## 5. Durable Objects 对本项目的价值

DO 可以理解为按 ID 定位的有状态计算单元，带私有持久存储；同一 ID 的协调逻辑在同一对象处理。它不是另一套 CDN，也不是让整张数据库自动按用户个性化的工具。[C5]

### 5.1 建议用途：一个同步协调器

对象名：`SyncCoordinator / hn-global-v1`。

| 它负责 | 它不负责 |
| --- | --- |
| 下一次检查时间、退避状态、重复触发协调 | 对所有网页请求提供中心化服务 |
| 小规模 HN 控制端点检查和增量任务创建 | 等待大量正文抓取或 Jev 推理 |
| 检查任务是否已持久记录并安排下一次 Alarm | 保存全部文章、评论、账户和跨用户关系查询 |
| 维护调度状态，在重启后继续工作 | 为每个用户或每篇文章创建永久活跃对象 |

这样可以减少围绕多个 Cron 或多个运行者争抢调度权的自制租约逻辑。但幂等、持久进度、补缺和外部调用失败仍然需要。

### 5.2 约十秒调度可以实现，但不是精确实时保证

Cron 是分钟级，而 Alarm 用未来毫秒时间戳调度；官方示例包括十秒后执行。每个 DO 同时只有一个 Alarm，可在处理后设置下一个，实现循环检查。[C6]

默认保留 60 秒；确有必要时将 `sync_interval_ms` 改为 10,000。只加快最新列表、最大 ID、更新提示等发现步骤，不能因此十秒重抓全部详情或重跑 AI。

Alarm 是至少一次执行；异常自动重试有上限，不能依赖一个抛错循环永远恢复。应用要保存失败状态、退避并重设下次执行，另外每五分钟由 Cron 检查调度是否仍存在。Cloudflare 和上游延迟可能导致实际执行晚于目标时间，不承诺精确十秒或十秒内完成全部分析。[C6]

看门狗只调用 `ensureScheduled()`，不另外执行完整同步。该方法需要考虑 Alarm 正在运行时 getAlarm 可能为空，结合持久 inflight/deadline 与代次检查，避免覆盖正常调度。

### 5.3 与 D1 / Queues 的一致性边界

D1 保留权威同步游标、gap 和任务记录；DO 保存调度时间、当前代次与退避状态。D1、DO storage 和 Queues 之间没有本文可以依赖的共同原子事务。

先用 D1 原子批处理创建确定性任务/outbox 和发现进度，再发送任务 ID；发送后故障允许重发。消费者凭幂等键取得任务，实际完成后才推进对应已处理游标。绝不能先把扫描位点跳到最新，再尝试发送可能丢失的任务。

外部 Jev 成功但回执丢失的重复费用仍可能发生；DO 不能把它变成严格 exactly-once。对象内部在 await 边界也必须考虑事件交错，不能把“单线程”误认为所有跨请求业务都是自动事务。[C7]

### 5.4 D1 / R2 / DO / Queues 分工

- D1：文章、用户、规则、版本、关系查询、权威任务账本。
- R2：正文、不可变快照和导出。
- DO：很少量、按对象 ID 组织的协调状态与 Alarm。
- Queues：并行、可重试的耗时任务分发。

不把整个应用迁入一个 DO，也不为了分片把每个用户做成一座独立数据库。未来若出现严格跨节点限流或 WebSocket 版本通知，可以评估其他 DO 类；当前用户不需要不断跳动的新闻页面，这些功能不进入必需范围。

## 6. DO 会增加多少钱

当前 DO 可用于 Workers Free 和 Paid；免费支持 SQLite-backed 对象。Paid 的 DO 计算含每月 100 万请求和 400,000 GB-s；额外请求 $0.15/百万，额外时长 $12.50/百万 GB-s。Alarm 调用计请求，setAlarm 也产生存储写入。DO 自己的 SQLite 存储读写和容量另按其价格表计算。[C8]

按 30 天、一个对象每十秒触发一次：

```text
alarm 次数 = 30 × 24 × 3,600 / 10 = 259,200 / month
若每次计费活跃 1 秒：
GB-s = 259,200 × 1 × 0.128 = 33,177.6
```

128MB 采用官方计费示例的换算。每次一秒只是计算假设，网络等待等可能增加对象活跃时长。即便这个单对象整月持续活跃，30 天约 331,776 GB-s，仍低于上述 Paid 时长包含量；但是其他对象和账户工作负载会共同占用额度。

在本项目只有一个低流量协调器、存储操作少的前提下，预期 **DO 增量账单为 $0**，不是再多一个 $5 订阅，也不是永久免费承诺。六次/分钟设 Alarm 约 8,640 次写/日，不能忘记计入存储指标。

避免用 setInterval、未结束的 fetch、普通长连接或长期事件处理来保持对象活跃；符合休眠条件的空闲对象不再产生 duration 费用，但内存状态不能作为唯一存储。[C8][C9]

成本真正可能放大的是大量长期活跃对象，而非这个单例。按同样官方口径，100 个对象整月保持活跃会产生约 3,318 万 GB-s，超过包含时长后的费用可达数百美元；因此“一个用户一个永远在线 DO”不属于本方案。

## 7. 建议落地与验收

先以 Cloudflare/Hono 骨架完成普通 HN 列表、评论和真实链接，再移植经过审核的展示代码。同步器提供统一接口，Cron-only 作为可切换回退；DO 协调模式使用同一 D1 幂等任务账本。

上线前至少验证：安全密码哈希 CPU；真实正文抽取 CPU 与成功率；Jev 平均/高分位输入；D1 rows_read/rows_written；Queues 重试；DO 活跃时长、Alarm 延误和看门狗恢复；不同预设的结果差异；私人规则跨账号隔离。

本轮不据静态依赖版本给出安全审计结论，不把 README 的性能数字当本项目 benchmark，不估计未知的实际用户增长。下一轮预算应使用真实采样数据替换本文变量。

## 8. 一手来源

### 仓库与代码

- [R1 Remix 源码与目录](https://github.com/clintonwoo/hackernews-remix-react/tree/59a5eb4a33c1d1817b1c1dcfcf003e84c0e8426b)；重点文件 package.json、src/cookies.ts、src/routes/vote.ts、src/assets/news.css、LICENSE。
- [R2 Remix README](https://github.com/clintonwoo/hackernews-remix-react)。
- [R3 Vercel 示例](https://github.com/vercel/next-react-server-components)；package.json 本次 blob e125e7be8835fe588a06018070cd93d91983b61a，components/header.tsx blob 78430896c00355a3040ccb5bf315290a54d34ed3。
- [R4 Nuxt 示例](https://github.com/nuxt/hackernews/tree/3a8f28076a50b776dd21a405049b6f64e70ba00c)；package.json、app/app.vue、app/components/PostItem.vue。
- [R5 Hono HN API 包装器](https://github.com/ibodev1/hackernews/tree/67ccdfc373b5619e301fd6b90e7423f0b3b54fa0)。

### Cloudflare 与 Jev

- [C1 Workers 价格](https://developers.cloudflare.com/workers/platform/pricing/)
- [C2 D1 价格](https://developers.cloudflare.com/d1/platform/pricing/)
- [C3 Queues 价格](https://developers.cloudflare.com/queues/platform/pricing/)
- [C4 R2 价格](https://developers.cloudflare.com/r2/pricing/)
- [C5 DO 概念](https://developers.cloudflare.com/durable-objects/concepts/what-are-durable-objects/)
- [C6 Alarm 语义](https://developers.cloudflare.com/durable-objects/api/alarms/)
- [C7 DO 使用规则](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/)
- [C8 DO 价格](https://developers.cloudflare.com/durable-objects/platform/pricing/)
- [C9 DO 生命周期](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/)
- [Workers AI 价格](https://developers.cloudflare.com/workers-ai/platform/pricing/)
- [J1 TypeSafe 官网单价](https://typesafe.ai/)
