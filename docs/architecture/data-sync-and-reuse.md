# JevNews：数据同步与展示复用

> v0.3 · 2026-09-19 · 当前实现为 Cloudflare DO + D1 outbox + Queues。旧 PostgreSQL/常驻容器方案已经替换。

## 1. 三个独立时钟

HN 元数据时钟、正文/模型分析时钟、用户阅读快照时钟分开。分数上涨不是重新付费分析的理由；新快照发布不是页面立即移动的理由。

## 2. 数据来源

官方 Firebase API 是唯一 HN 元数据来源：newstories、maxitem、updates、top/best/ask/show/jobstories、item/{id}、user/{name}。外链正文另外获取，不从接口假定它已提供完整文章。

最新列表不是完整历史。maxitem 增量区间内既有文章也有评论；逐项持久入队、按type分类。updates 仅刷新提示，不视为可靠可重放事件日志。HN原模式采用官方ID顺序，不自行算热度后冒充HN榜单。

## 3. 调度

SQLite-backed `SyncCoordinator` 是单个逻辑调度者，默认60秒Alarm，可配置10秒。每次执行有界检查，失败退避，任务经D1账本交给Queues。Cron每5分钟作看门狗及outbox补发，不存在秒级Cron表达式。

new/max/updates/top每轮；ask/show/best在5分钟时间桶，jobs在10分钟时间桶；内容刷新key以2分钟时间桶合并。公共Jev发布以10分钟时间桶合并。循环未按绝对墙钟严格对齐，上游慢/退避会延后，不能承诺10秒SLA。

每轮新增ID默认最多100，dispatch最多40；持续吞吐和历史回填速度需要根据积压调节。不能仅调短Alarm而不测任务队列，导致控制请求多了而实际内容仍迟滞。

## 4. 启动与补缺

首次保存当前最大ID，并装载当前新帖列表最多500条和其他榜单。历史回填是独立低优先级反向扫描，每5分钟最多100个ID，遇到7天外记录停止。发现进度不等于分析完成。

持续增量：先把扫描区间每个ID的幂等任务写D1，再推进scan_cursor；另记observed_max。任务失败保留错误状态，不把游标前进等同于每条已成功。最早已发现时间仅是观察值；不能在初次回填未完成时宣称最近7天都齐了。

低票不是过滤条件；FIFO积压以及分析覆盖需监控。安全candidate上限10,000可导致个性化视图的覆盖限制，界面会显示，不影响原始HN入口。

## 5. item、正文与模型版本

HN显示字段未变则不重写；删除/死帖状态清掉该条公开文本并在快照渲染时覆盖。评论只按访问及已有线程刷新，不将全站评论送AI。

正文支持普通HTML/text；最多2MB响应、5次重定向、12秒主请求超时，DNS/robots检查另计。每次重定向重新检查目标路径是否被robots允许。抽取优先article/main，否则受限正文清理；最多28,000字符，截断要标记。项目README仅在链接页面实际提供时分析，不自动下载整库。

来源失败不绕过登录墙：保留标题/文本的metadata范围。按内容hash保存R2并复用`(hash,model,rubric)`分析。URL重复不等于HN讨论重复，保留各自item和评论ID。

## 6. 阅读缓存与稳定性

来源ID列表变化或距上次发布超过12小时才发布HN模式快照；先发布快照，再更新列表checkpoint，避免中途失败后误以为已经发布。Jev公共发布一次取同批候选，再计算七预设。R2只存不可变快照；D1head指向最新。More保留snapshot，页内最多30项，私有snapshot检查账号和规则版本。

评论页每次最多补60条、深度20，缺失分支显示load reply；子节点按HN kids顺序。此范围有限而透明，不假装已经缓存全讨论。资料页按访问缓存15分钟。未支持的past等视图直接去HN。

## 7. 恢复和运维

任务采用至少一次投递、lease fencing、可重试outbox；不是分布式事务。外部AI响应丢失可能再次收费，预留日志明确标不确定。

后台受保护status接口提供进度、任务状态和预算。生产应监测lag_ids、failed jobs、pending年龄、public feed年龄、AI token和抓取成功率。当前代码提供状态数据，未自动配置云告警。

## 8. 复用结论

不整仓fork。HN复刻的结构是设计参考，当前实现的HTML/CSS为本项目新写，没有导入其完整源码或演示认证。未来复制具体文件时必须更新THIRD_PARTY_NOTICES并保留对应许可证。用户看到的相似程度通过截图/操作验收，不以换了技术栈作为放宽标准的理由。

一手接口： https://github.com/HackerNews/API · https://developers.cloudflare.com/durable-objects/api/alarms/
