# APIMart 缺失分镜真实生成计划

日期：2026-08-19
状态：实施中

## 目标

把老板创作流水线中的“生成全部缺口”从本地演示状态升级为可审阅的真实 APIMart 视频生成链路：先展示价格估算并由用户确认，再提交异步任务、查询状态、下载临时结果到本地工作区、用 ffprobe 校验，最后把本地 Artifact 回填到对应分镜。

## 本次范围

- 在 `packages/providers` 增加 APIMart 视频 `submit` / `poll` 适配与错误归一；
- 在 Electron main process 持有密钥并通过 Chromium 网络栈访问 Provider，兼容 macOS 系统代理；
- 增加“价格估算 → 明确确认 → 提交 → 轮询 → 下载 → 校验”的最小 IPC；
- 在老板创作流水线展示模型、逐镜价格、总价、状态、失败原因和本地结果；
- 先以 mock/fixture 验证，不在自动测试中发起真实计费请求。

## 当前固定生成配置

- Provider：APIMart；
- 模型：`kling-v3`，标准模式；
- 视频：5 秒、9:16、720p 级标准模式；
- 价格估算快照：`$0.0672 / 秒`，按 5 秒计算为约 `$0.336 / 分镜`；最多一次确认 5 个缺口；
- 价格来源：APIMart 官方 2026 视频模型价格对比（2026-08-19 核对）。模型元数据接口当前没有返回可用于结算的价格，因此该数字只是界面确认前的估算快照，不是实时账单、服务端报价或硬性费用上限；实际扣费以 Provider 返回和账户账单为准。

## 官方接口合同快照（2026-08-19）

- 提交：`POST /v1/videos/generations`，固定请求摘要为 `model=kling-v3`、`mode=std`、`duration=5`、`aspect_ratio=9:16`，每个分镜只提交一次；
- 模型目录：`GET /v1/models?expand=parameters&category=video`；当前 `kling-v3` 元数据声明 `video_generation`，端点为 `/v1/videos/generations`，参数 schema 版本为 `2026-07-30`；
- 查询：`GET /v1/tasks/{task_id}`；官方状态为 `pending | processing | completed | failed | cancelled`，适配器再归一化为本地任务状态；
- 成功结果：从 `data.result.videos[0].url[0]` 读取 HTTPS 临时视频 URL，并保存 `expires_at`；URL 必须立即下载、校验并转成本地 Artifact；
- 官方来源：[Kling V3 生成](https://docs.apimart.ai/en/api-reference/videos/kling-v3/generation)、[异步任务状态](https://docs.apimart.ai/en/api-reference/tasks/status)、[模型目录](https://docs.apimart.ai/en/api-reference/texts/models/list)、[2026 视频模型价格对比](https://apimart.ai/blog/top-ai-video-models-2026-pricing-api-comparison)。

## 不动项

- 不让 renderer 读取 API key、直接访问 APIMart 或写文件；
- 不把 Provider 临时 URL 当永久素材；
- 不生成本人、客户、真实经营过程等被脚本标记为必须实拍的镜头；
- 不自动重试可能计费的提交；
- 本次不把老板资料、脚本版本和完整工作流迁移进 SQLite。

## 失败与恢复

- 提交返回不确定时标记 `submission_unknown`，不再次提交；
- 401/402/429、Provider 失败和超时使用统一错误类别；
- 已取得 task ID 后可以继续轮询，但不会再次计费提交；
- 下载仅接受 HTTPS，限制单文件 500 MiB，写入临时文件后再原子落盘；
- ffprobe 必须确认至少一个视频流；失败则删除无效文件并保留分镜缺口；
- 成功结果立即进入本地工作区并记录 hash、大小、时长和 Provider task ID。

## 验收门

1. Provider mock 覆盖成功、HTTP/业务错误、状态映射和危险 URL；
2. IPC smoke 覆盖估算快照、确认闸门、提交一次、轮询、下载和校验；
3. renderer 不含密钥，未确认价格估算不能提交；
4. `npm test`、`npm run typecheck`、`npm run build` 通过；
5. 真实联调前单独告知模型、数量、预计总价、停止条件和保存位置。

## 回滚

移除新增 IPC 和 Provider 视频方法后，老板流水线可退回原有本地演示提案；现有脚本、素材匹配、剪辑和渲染链路不受影响。已下载的本地 Artifact 不自动删除，由用户在工作区中处理。
