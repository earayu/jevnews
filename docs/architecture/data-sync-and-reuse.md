# JevNews：数据同步与开源复用方案

> 版本：v0.2  
> 日期：2026-09-19（UTC+8）  
> 对应产品：[产品需求 v0.3](../product-requirements.md)  
> 详细技术设计：[Cloudflare 优先方案](cloudflare-design.md)  
> 数据模型：[D1 参考 schema](cloudflare-schema.sql)

## 1. 当前方案与历史方案

用户已要求尽量使用 Cloudflare 和免费资源。当前采用：

**HN 官方 API → Cloudflare Cron/Workers 增量同步 → D1 + R2 → Queues 异步分析 → HN 风格网页。**

此前 v0.1 中的自建 PostgreSQL、三个常驻容器、部分端点每 10 秒轮询，以及 Next.js 优先的技术起点，已由 Cloudflare 详细设计取代。它们不是当前部署要求。

历史方案保留在 Git 提交 [5d0a93b](https://github.com/earayu/jevnews/blob/5d0a93b801cde825c1abfc3bbe274c03be2dfbe1/docs/architecture/data-sync-and-reuse.md)。以下同步原则继续有效；具体免费额度、CPU、预算、安全、表结构和部署配置以新设计为准。

## 2. 数据来源

使用 [HN 官方 API](https://github.com/HackerNews/API)。

| 接口 | 用途与边界 |
| --- | --- |
| newstories | 快速发现最新投稿，列表有限，不能作为完整历史。 |
| maxitem | 持久位点补缺；item 包含评论等，并非全部是文章。 |
| topstories / beststories | 原始列表顺序与补充候选，不是唯一分析入口。 |
| askstories / showstories / jobstories | 保持相应页面的数据入口。 |
| updates | 刷新提示，不当作带消费位点、完整重放保证的日志。 |
| item/{id} | 元数据、投稿/评论 HTML、父子关系、分数及状态；不含任意外链全文。 |
| user/{id} | HN 公共资料，不是本站账号或 HN 登录接口。 |

真实 HN 登录、投票、投稿、回复等不通过不存在的官方写接口模拟；回原站完成。原始列表保留官方接口顺序，不以自造热度公式冒充 HN 排名。

## 3. 分钟级增量，而非全量轮询

当前默认一分钟发现新内容，每 5–10 分钟检查部分次要列表；评论按需读取。公开 Jev 快照按新分析和规则变化合并发布，起点约 10 分钟，压力下可明确降频。

Cloudflare Cron 是分钟级，不能直接配置每十秒；此前十秒参数已废止。[Cron 官方文档](https://developers.cloudflare.com/workers/configuration/cron-triggers/)

每次 tick 的网络、SQL、CPU 工作量有上限；多次执行通过 D1 游标接续。低票文章不会因不在热门榜被排除，积压通过覆盖起点、最老任务与 lag 显示，不能伪装为已经同步全部。

newstories 快速路径与 maxitem 补缺并行；持久化观察到的最大 ID、扫描位点和失败 gap。暂时 null/失败有退避，不永久阻塞后续，也不静默抹掉缺口。updates 与活跃内容回读结合，不依赖提示绝不丢事件。

## 4. 三种时钟

**来源时钟**：HN 投稿、分数、评论和榜单更新。

**分析时钟**：正文抽取、公共画像、专项判断与排序生成。

**阅读时钟**：用户当前打开的稳定快照、页码、评论分支和滚动位置。

来源变化不自动触发正文重分析；模型判断更新不使页面跳位；源数据新不意味着 AI 已读全文。

快照携带规则版本、生成时间、覆盖范围和翻页定位。More 继续同一快照；明确刷新才进入新顺序。已知 deleted/dead 优先覆盖快照，不复活已知删除内容。

## 5. 存储与任务

D1 保存 HN 小型缓存、公共画像、规则、账户、快照指针、持久任务账本和预算；R2 保存内部正文、排序 ID 列表与导出。无需 PostgreSQL 服务器、Redis、向量库或图数据库。

Queues 不是任务的唯一存储：D1 先记录 jobs，消息只带 ID，consumer 用原子条件租约领取。重复投递、队列过期和跨服务写入部分成功都需补偿，不声称 exactly-once。

公开分析按实际输入、模型、抽取与 rubric 版本去重；HN 票数/评论变化不重复调用 Jev。私人规则与状态隔离，公开预设跨用户共享。

外链正文不作为公共全文镜像发布。清理按明确保留策略和外键引用进行，删除账号和来源清理优先于普通 TTL。成本、读写放大、重试和 CPU 验证详见新设计。

## 6. 开源 HN 复刻如何复用

前一版考察的候选仍可作为 UI/行为参考：

| 仓库 | 复用定位 |
| --- | --- |
| [vercel/next-react-server-components](https://github.com/vercel/next-react-server-components) | HN 样式、组件结构、SSR 示例；不把示例导航/登录当作完整产品。 |
| [clintonwoo/hackernews-remix-react](https://github.com/clintonwoo/hackernews-remix-react) | 链接、表单、路由与 HN 交互参考；替换内存/演示数据。 |
| [nuxt/hackernews](https://github.com/nuxt/hackernews) | Vue/Nuxt 的 HN 示例参考，不是当前框架锁定。 |

当前技术栈选 Hono/TypeScript/服务端 HTML/少量原生 JS，以减少免费层运行开销；并非声称 Next.js、Remix 或 Nuxt 不能部署 Cloudflare。

复用前检查当时许可证和具体文件，保留归属和许可证声明。HN 官方站点的视觉参考不意味着其所有资源可无条件复制；使用自有标识，明确非官方服务。库名包含 Hacker News clone 不保证真实写接口、账号、所有子页面或最新依赖已经实现。

## 7. 当前完成范围

本次更新的是设计文档与参考 schema；未导入复刻源码、部署 Worker、创建云数据库、购买域名或启动生产同步。参考 SQL 只完成本地 SQLite 验证，远程 D1 与 Workers CPU、认证和正文抽取仍须实测。