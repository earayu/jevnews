# JevNews：复用、费用与 DO 最终决策

> v0.2 · 2026-09-19 · 费用为假设测算，尚无本服务真实供应商账单；实际交付状态见 [交付状态](../implementation-status.md)。

## 1. 代码路线已经落地

独立Cloudflare/Hono工程，复刻项目仅作为展示结构参考，不整仓fork，不接入演示账号/模拟投票/内存业务。当前HTML/CSS原创，尚未逐文件移植第三方代码，因此不声称已完成“基于某clone改造”。后续有实质复制必须保留通知。

此前源码评审发现：Remix版依赖Remix1.2/React17并有演示sessionsecret；Vercel版存在span占位导航；Nuxt版可运行Cloudflare但UI不是HN原样；ibodev1项目是APIwrapper而不是整站。这些是评审时的具体版本观察，不是它们当前维护状态或安全性的永久判断。

评审来源：https://github.com/clintonwoo/hackernews-remix-react · https://github.com/vercel/next-react-server-components · https://github.com/nuxt/hackernews · https://github.com/ibodev1/hackernews

## 2. DO 已进入代码

一个SQLite-backed `SyncCoordinator`，固定ID协调下一次执行、失败退避及重复触发。D1仍是可查询业务、任务和同步进度存储；R2放正文/快照；Queues处理耗时任务。

默认60秒，可改约10秒。DO Alarm可秒级安排，但至少一次且可能延迟，不保证精确时钟。Cron保留5分钟看门狗。不会每个用户创建常驻对象，不让所有网页请求通过一个全局DO。

DO跨await/外部服务不是全局事务；lease、幂等和恢复仍需要。10秒一次30天约259,200次Alarm；假设每次1秒、0.128GB，约33,178GB-s。按当前Paid包含的1M请求、400,000GB-s，这个单协调器可处于包含额度；若长期活动、网络变慢或账户别处大量使用，不保证零增量账单。

## 3. 预算基准

公开完整运行建议Workers Paid当前最低$5/账户/月。不是每个Worker或DO各付$5。免费档可验证，但不得降低密码安全来凑10msCPU。

假设每天1000个公共正文版本、每篇6000输入tokens；10%的DAU每天做20篇私人专项复判、每篇总输入3000tokens；每DAU每天20动态请求、平均15msCPU。30天，Jev输入价按$0.042/百万tokens。D1/R2/DO处于相应包含额度，规则编译先限制在可接受的Workers AI用量。

| 情景 | 100 DAU | 1000 DAU | 10000 DAU |
| --- | ---: | ---: | ---: |
| Workers基础及计算示例 | $5.00 | $5.00 | $6.40 |
| 公共分析 | $7.56 | $7.56 | $7.56 |
| 私人分析 | $0.76 | $7.56 | $75.60 |
| Queues超额示例 | $0 | $0 | $0.43 |
| 合计示例 | $13.32 | $20.12 | $89.99 |
| 建议预留 | $15–25 | $25–45 | $100–160 |

这不是容量测试或固定套餐；不同账户其他服务会共享用量。独立域名、税费、付费代理、浏览器解析、翻译、人工与新增功能另计。workers.dev可免费起步，独立域名注册和续费不免费。

基准测算未把现有100篇/用户/日上限当成平均值。每个用户每天用满、每篇3000tokens，则每用户约$0.378/月；1000人约$378仅私人AI费。不能承诺人数随便涨都只花$30。

## 4. 代码中的控制

当前DAILY_TOKEN_BUDGET=20,000,000，按日预留/实际结算，仅按上述输入单价换算一个持续满载月约$25.2，再加Workers$5约$30.2；这不是硬账单保证：预留估计误差、重试不确定性、模型单价变化、WorkersAI/存储/CPU超额不包含在内。

WorkersAI编译最多100调用/日，不是自动精确控制10,000 Neurons。默认关闭编译和分析，运营者联调后打开，并依据真实用量降低上限。现有结果读取不创建全量逐用户正文分析。

Paid D1包含月读写额度比Free宽松。仍使用索引、同文复用、字段未变不重写、快照共享、到期清理。当前公共排序每10分钟重算候选，是已知可优化处，不谎称全增量算法已完成。

## 5. 复核来源（2026-09-19评审）

https://developers.cloudflare.com/workers/platform/pricing/
https://developers.cloudflare.com/d1/platform/pricing/
https://developers.cloudflare.com/durable-objects/platform/pricing/
https://developers.cloudflare.com/queues/platform/pricing/
https://developers.cloudflare.com/r2/pricing/
https://developers.cloudflare.com/workers-ai/platform/pricing/
https://typesafe.ai/

配置或发布前核对实际控制台报价；不把此前示例变成保证。未进行域名购买、付费套餐开通或远程部署。
