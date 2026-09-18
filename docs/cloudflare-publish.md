# 首次发布到 Cloudflare（GitHub Actions）

> 2026-09-19。已添加自动发布流程；文档和测试通过不代表已经部署。是否发布成功，以 Actions 中 `Provision, migrate, publish, and verify` 步骤及实际公网检查为准。

## 1. 一次性授权

在目标 Cloudflare 账户内建立**账户范围的 API Token**，不要使用 Global API Key。以 Edit Cloudflare Workers 模板为起点，确保权限涵盖 Workers 的创建/部署、D1 的创建/查询/迁移、R2 的创建/读取设置/生命周期设置、Queues 的创建和绑定。新版权限界面中，首次创建资源需要对应产品的 Admin 权限；后续维护可缩小权限。仅限目标账户，不需要 Zone、DNS、Registrar 或账单管理权限。本流程不启用 Workers AI，所以不需要 AI 调用权限。

首次使用该账户时，需要先在 Cloudflare 控制台设置 `workers.dev` 子域。R2 需要账户已完成开通；可能要求账单资料并存在超额费用，脚本不会自动订阅或升级。请先确认 Cloudflare 账户的套餐、额度和告警。

在仓库 **Settings → Secrets and variables → Actions → New repository secret** 保存：

| 名称 | 值 |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | 上述账户范围 API Token。 |
| `CLOUDFLARE_ACCOUNT_ID` | 目标 Cloudflare 账户的 32 字符 Account ID，不是 Zone ID。也可用同名 Actions variable。 |

**不要将 Token 放入聊天、Issue、源码、截图或普通仓库文件。** GitHub 和 Cloudflare 是不同的授权，连接 GitHub 不等于已授权 Cloudflare。

## 2. 执行

打开仓库 **Actions → Deploy Cloudflare → Run workflow**，选择 `main`。`enable_sync` 默认开启，只同步 HN 数据，不调用模型。

新发布流程文件或发布脚本推送到 main 也会触发此流程；普通应用代码推送目前只触发 CI，更新上线需要手动 Run workflow，避免意外发布未完成的代码。缺少 Secrets 的首次触发会明确失败且不创建资源，添加后重新运行即可。

流程在设置 Cloudflare 凭据之前完成依赖安装和代码验证；凭据只提供给授权检查及真正发布步骤。发布步骤会：

1. 检查账户的 workers.dev 子域，查找同名 D1、R2 和 Queues；不存在则创建，存在则复用。不得把这些名字指向其他项目的数据。
2. 确认 R2 桶无公开域名，合并 `documents/` 30 天、`snapshots/` 3 天的生命周期规则。保留其他规则；同名规则冲突时停止，不覆盖。生命周期会使相应前缀内到期对象被清理。
3. 将实际 D1 ID 写入被 git 忽略的 `wrangler.deploy.json`，不把 Token 写入文件。保留原始 `wrangler.jsonc`。
4. 执行远程 D1 迁移，部署 Worker、Static Assets、SQLite-backed DO 和队列消费者。不会买域名、改变账户子域、增加付费订阅或操作 DNS。
5. 请求实际 URL 的 `/healthz` 和 `/news?view=hn`，成功后才在 Actions Summary 写出“publication verified”和可打开链接。

数据库和 R2 等资源创建失败可能留下已创建的前置资源。脚本不会在失败后删除数据库或桶；修复原因后重新运行。远程资源 API 契约已对照官方文档，单元测试使用模拟 API；没有授权时不能宣称已验证真实云端调用。

## 3. 首次发布范围

首次发布使用实际应用，不是 fixture 演示。默认开启 HN 元数据同步，Cron 将启动 DO 协调器。首次打开可能暂时没有数据；检查源列表和同步状态后再认定采集正常。公网健康检查不等于完整同步或 AI 效果验收。

以下功能**保持关闭**：

- `ANALYSIS_ENABLED=false`：没有自动使用 Jev，也不读取 TypeSafe 密钥。
- `RULE_COMPILATION_ENABLED=false`：去掉本次部署的 Workers AI binding，不产生规则编译用量。
- `REGISTRATION_OPEN=false`：Turnstile 和账户安全尚未实测前，不公开注册；不是删掉产品中的注册功能。

首次部署脚本每次都会应用上述保守开关，所以**开启 AI/注册以后不要再用此脚本当作普通全功能发布流程**，否则会重新关闭这些开关。届时参考 [完整部署手册](deployment.md)，配置生产 Turnstile、模型密钥、预算，使用已经生成并审核的正式配置发布；或另建保留生产开关的常规发布流程。

为兼容免费账户，生成配置省略自定义 CPU 限制；这不提高免费限额。持续同步、页面和密码计算是否适合免费额度，仍须实测；程序不会自动升级套餐来解决限制。R2 等超额费用仍由账户负责。

## 4. 排错

| 现象 | 检查 |
| --- | --- |
| Check Cloudflare authorization 失败 | 配置两项仓库 Actions Secrets，检查名字是否完全一致，然后 Re-run jobs。 |
| Cloudflare HTTP 401/403 | Token 账户范围、产品权限、账户是否填错、R2 是否开通。错误只报告状态/代码，不输出 API 响应中的秘密。 |
| 无 workers.dev 子域 | 在 Cloudflare Workers 控制台完成一次子域设置。脚本不替你随意选择账户级名字。 |
| R2 public domain / lifecycle conflict | 在控制台核对该桶是否仅供 JevNews 使用，再关闭公开访问或人工处理保留规则。 |
| 上传成功但公网验证失败 | 检查 Worker 日志、D1 迁移、账户额度及域名生效状态；不能仅凭上传成功认定发布完成。 |
| 网站可打开但没有新闻 | HN 同步与网页发布分开验收，检查 Cron、DO、队列及 `SYNC_ENABLED`。AI 关闭时不宣称已有真实 Jev 排序。 |

## 官方参考

- [Cloudflare GitHub Actions 授权与部署](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/)
- [Workers 权限与首次创建权限](https://developers.cloudflare.com/workers/authorization/workers/)
- [D1 创建 API](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/create/)
- [R2 生命周期 API](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/subresources/lifecycle/methods/update/)
- [Queues API](https://developers.cloudflare.com/api/resources/queues/)
