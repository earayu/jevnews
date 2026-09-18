# 部署与操作手册

> 2026-09-19 · 命令须由拥有目标Cloudflare账户权限的人执行。本次提交没有执行远程部署、资源购买或密钥设置。

## 1. 本地和 CI

Node24推荐，最低22.16；npm和Python3。

```sh
npm ci
npm run db:local
npm run dev
npm run typecheck
npm test
npm run test:db
npm run build
npm run test:runtime
```

本地独立配置 `wrangler.local.jsonc` 使用模拟D1/R2/Queues/DO，无远程AI binding。只在loopback允许跳过Turnstile。`npm run preview` 是只读fixture预览，不能当作真实HN数据。

CI只验证，不部署；不需要云Key，不自动启用收费功能。`worker-configuration.d.ts` 自动生成且不提交。

## 2. 创建资源（远程，有潜在费用）

确认账户/套餐与预计预算，再运行：

```sh
npx wrangler login
npx wrangler d1 create jevnews
npx wrangler r2 bucket create jevnews-content
npx wrangler queues create jevnews-tasks
npx wrangler queues create jevnews-dlq
```

把返回D1 ID填入 `wrangler.jsonc`，不能部署全零占位。Worker名字、R2桶名和Queue名按自己的账户修改。DO类由配置中 `new_sqlite_classes` migration建立；初始 tag v1不得在已有部署上随意重写。

R2必须私有，不开启r2.dev或公开域。**配置生命周期**：documents/前缀30天，snapshots/前缀3天。先在控制台验证规则生效，再开放真实用户。数据库清理不能代替R2生命周期。

绑定Workers AI后仍保持RULE_COMPILATION_ENABLED=false，直到确认模型存在和价格/用量。Workers Paid并非全部资源无限量，预留预算和厂商告警。

## 3. Secrets 与 Turnstile

创建Turnstile widget，设置允许hostname；填入公开 `TURNSTILE_SITE_KEY` 与准确 `TURNSTILE_HOSTNAME`。配置缺失生产认证会失败，这是刻意fail closed。

```sh
npx wrangler secret put TYPESAFE_API_KEY
npx wrangler secret put TURNSTILE_SECRET_KEY
npx wrangler secret put ADMIN_TOKEN
# ADMIN_TOKEN使用密码管理器生成的至少32字符随机值
```

不要把Key写进vars、GitHub源码、问题单或聊天。`.dev.vars.example`不含真实秘密，本地副本应忽略。TypeSafe初始模型jev-1.13.0，规则编译初始@cf/meta/llama-3.1-8b-instruct，部署前核验当前账户可用性。

## 4. 迁移与第一次部署

```sh
npm run db:remote
npm run deploy
```

这会真实修改远程数据库和部署Worker。首次保持SYNC_ENABLED=false、ANALYSIS_ENABLED=false、RULE_COMPILATION_ENABLED=false。REGISTRATION_OPEN可在联调时改false；公开之前先验证Turnstile、Secure cookie、Origin/CSRF与账户删除。

使用Cloudflare分配的workers.dev URL，或者自有域名。自有域名需购买/续费，迁移域名要同步cookie范围、Turnstile hostname和旧链接。

## 5. 逐步开启

先只把SYNC_ENABLED改true并部署，再向受保护入口请求：

```sh
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" https://YOUR_HOST/internal/sync
curl -H "Authorization: Bearer $ADMIN_TOKEN" https://YOUR_HOST/internal/status
```

DO安排后续Alarm，Cron看门狗每5分钟检查。默认60秒，10秒只能通过SYNC_INTERVAL_MS=10000配置；不是修改Cron到六字段。检查scan_cursor与observed_max、failed任务和最早发现时间，不能只看首页是否有文章。

确认采集后设置低DAILY_TOKEN_BUDGET再开启ANALYSIS_ENABLED，少量检查实际模型响应、usage、内容hash复用和partial标记。最后开启RULE_COMPILATION_ENABLED，检查JSON编译、unsupported说明和用户确认流程。

当前默认20Mtoken/日是启动预算起点，不是保证账单上限。WorkersAI100次编译/日不等于精确Neurons控制。供应商价格变化、重试、其他Cloudflare资源另计。

## 6. 运维与恢复

查看 `/internal/status` 的任务/预算/同步数据和Cloudflare指标。关注pending年龄、failed、feed年龄、D1/R2容量、Jev不确定预留和WorkersAI用量。不要将完整payload写日志。

失败任务最多5次后需人工检查。确定原因已消除后，可对明确任务ID执行：

```sql
UPDATE jobs SET status='pending',attempts=0,not_before=0,lease_until=0,
  dispatched_at=0,error=NULL WHERE id='REVIEWED_TASK_ID' AND status='failed';
```

不要全表重置或删除jobs来“修复”积压，会造成重复付费/丢补缺记录。不可盲目修改synccursor到最新值。

停AI：ANALYSIS_ENABLED=false / RULE_COMPILATION_ENABLED=false后部署；停发现：SYNC_ENABLED=false。已有结果可继续读，D1不可用时动态页面仍可能失败，没有实现离线全站镜像。

## 7. 备份与回滚

部署前通过Wrangler D1 export或控制台导出备份，备份包含敏感账号记录，必须加密、限制访问，严禁提交仓库。按厂商文档验证D1恢复可用范围，并在staging演练。

R2用生命周期控制成本；长期备份需求另配置，不声称当前有自动备份。变更数据库采取新增迁移，不手改已经应用的0001。旧schema文档和migrations镜像一致由test:db检查。

Worker回滚使用Cloudflare版本/部署控制台，必须同时确认迁移是否向后兼容。DO migration一旦应用，不得只回滚源码却假设持久对象schema也自动回滚。

## 8. 发布前还需要

真实HN+模型联调；持续负载与队列恢复；公开UI差异验收；安全和依赖审查；隐私/联系方式；源删除与账户删除演练；真正恢复备份。详细欠项见 [implementation-status.md](implementation-status.md)。
