# Provider 官方接入调研与小额联调记录 v0.1

日期：2026-08-14；APIMart 视频接口补充核对：2026-08-19
状态：已完成官方文档核对；已完成无生成任务的真实 smoke；账号研究、AI 粗剪和脚本提案均通过显式 main-process IPC 接入；APIMart 缺失分镜生成已进入“估算确认 + 异步任务 + 本地化”的受控实现，自动化测试仍不发起真实计费生成。
范围：TikHub（抖音研究）与 APIMart（文本/视觉/音频/视频模型网关）。

## 1. 结论先行

### 1.1 2026-08-14 官方页面复核补充

- TikHub 官方抖音产品页继续建议优先使用 Douyin App V3；标准作品接口不保证播放量，播放量需单独调用统计端点。专门 Search API 是独立产品线，官方页面标注 `$0.01/请求`，不能误用 Web/App V3 的搜索路径。
- TikHub 官方文档说明中国大陆可使用 `https://api.tikhub.dev`，其他地区使用 `https://api.tikhub.io`，路径和参数保持一致；认证仍是 `Authorization: Bearer <token>`。正式调用前仍必须读取动态端点报价。
- APIMart 官方 Quick Start 说明统一根地址为 `https://api.apimart.ai/v1`，Chat Completions 使用 OpenAI-compatible body；图片/视频生成返回异步 `task_id`，通过 `GET /v1/tasks/{task_id}` 轮询。Whisper-1 转写文档标注最大文件 25MB，并支持 json/text/srt/vtt 等输出。

来源：[TikHub 官方文档索引](https://docs.tikhub.io/)、[TikHub Douyin API](https://tikhub.io/douyin-api)、[APIMart Quick Start](https://docs.apimart.ai/en/quickstart)、[APIMart Whisper-1](https://docs.apimart.ai/en/api-reference/audios/whisper-1)。文档会变动；以上事实不能替代真实调用前的报价、能力和余额检查。

我们不是把两个供应商直接散落到页面里，而是做一个统一的 `ProviderPort`：

```text
main process credential store
        ↓
ProviderPort
  ├─ listModels / capability
  ├─ submit / chat
  ├─ poll / download / validate
  └─ normalized error / usage / cost
        ↓
Job + CommandReceipt + ArtifactManifest
```

产品第一阶段的杀手级研究闭环是：

```text
抖音主页链接
→ 解析 sec_user_id
→ App V3 读取账号资料
→ App V3 按游标读取最新作品（先 20 条）
→ 读取作品事实/统计（播放数单独接口）
→ 仅在用户确认后下载少量公开素材到本地
→ 本地 ffprobe + ASR/OCR/镜头分析
→ 证据抽屉 + 内容模式 + 选题机会
```

TikHub 的 Search API、批量高清下载、星图画像和视频生成都不能偷偷放进“默认分析”：它们有额外成本、权限、合规或资源风险，必须做成明确的可计费动作并显示预计成本。

## 2. 官方资料与事实（核对日期：2026-08-14）

### 2.1 TikHub

官方入口：

- [TikHub API 文档](https://docs.tikhub.io/)
- [TikHub 官方 LLM 接口目录](https://docs.tikhub.io/llms.txt)
- [TikHub Douyin API 产品页](https://tikhub.io/douyin-api)
- [用户信息接口](https://docs.tikhub.io/186826050e0)
- [每日用量接口](https://docs.tikhub.io/186826051e0)
- [价格计算接口](https://docs.tikhub.io/186826052e0)
- [健康检查](https://docs.tikhub.io/237673542e0)
- [账号资料](https://docs.tikhub.io/186826222e0)
- [用户作品分页](https://docs.tikhub.io/186826223e0)
- [单作品 App V3](https://docs.tikhub.io/186826219e0)
- [单作品无版权限制 V3](https://docs.tikhub.io/406098636e0)
- [播放统计](https://docs.tikhub.io/186826221e0)
- [批量作品统计](https://docs.tikhub.io/256258480e0)
- [账号作品分析（上周）](https://docs.tikhub.io/252393848e0)
- [最高画质播放链接](https://docs.tikhub.io/312096107e0)
- [低粉爆款榜](https://docs.tikhub.io/252393854e0)
- [高完播率榜](https://docs.tikhub.io/252393855e0)
- [搜索热榜](https://docs.tikhub.io/252393860e0)
- [热门内容词](https://docs.tikhub.io/252393862e0)
- [账号近 7 日作品分析](https://docs.tikhub.io/252393848e0)
- [评论词云权重](https://docs.tikhub.io/252393843e0)
- [多关键词热度趋势](https://docs.tikhub.io/443673033e0)
- [星图内容趋势指南](https://docs.tikhub.io/417585632e0)

事实（本次通过官方页面再次核对）：

| 能力 | 官方合同/限制 | 对本产品的用途 |
| --- | --- | --- |
| 认证 | `Authorization: Bearer <key>` | 只在 Electron main 持有；renderer 只拿 `configured` |
| 域名 | 中国大陆可用 `api.tikhub.dev`；其他地区 `api.tikhub.io`，路径/参数相同 | Base URL 可配置，默认大陆 `.dev` |
| App V3 账号 | `GET /api/v1/douyin/app/v3/handler_user_profile?sec_user_id=...` | 账号快照、昵称、粉丝和基础信息 |
| App V3 作品 | `GET /api/v1/douyin/app/v3/fetch_user_post_videos`，`max_cursor` 翻页，第一页为 0，`count` 不超过 20，`sort_type=0` 最新/`1` 最热；官方响应说明本次请求会计费 | 首次研究固定 20 条，之后按用户动作扩展；UI 必须显示范围和预算 |
| App V3 单视频 | `GET /api/v1/douyin/app/v3/fetch_one_video?aweme_id=...` | 文案、作者、视频/图文元数据 |
| V3 受限内容 | `fetch_one_video_v3` 可处理更多受限内容，但仍要遵守平台权利和用户授权 | 只作为显式 fallback，不自动下载 |
| 播放量 | 标准作品接口可能不带播放数；单作品 `fetch_video_statistics` 一次最多 2 个 ID；批量 `fetch_multi_video_statistics` 一次最多 50 个 `aweme_ids`，官方页面当前标注 `$0.025/次` | 研究报告把“播放统计来源”单独标证据；产品只在报价确认后调用批量接口 |
| 账号作品表现 | `GET /api/v1/douyin/billboard/fetch_hot_account_item_analysis_list`，参数 `sec_uid`、`day`（默认 7）；官方响应提示会计费，当前动态价格为 `$0.001` | 账号页的近 7 日聚合基准；只保存归一化数字和响应 hash，不把 `UserID/BaseResp` 等供应商内部字段暴露给 UI |
| 高画质 | 单条高画质接口价格文档标为 `$0.005/次`；链接有时效性 | 用户点“下载到本地”后立即导入，绝不保存临时 URL 当资产路径 |
| URL 解析 | Web `get_sec_user_id`、`get_aweme_id` | 粘贴主页/作品链接时先转稳定 ID |
| 榜单 | 官方目录提供低粉爆款、高完播、高点赞、高涨粉等 Billboard 接口，并有关键词/垂类过滤能力 | 选题雷达的第二入口，必须有成本预估和缓存；不加入默认账号分析 |
| 其他研究接口 | 官方目录还列出热搜、话题、音乐、评论、粉丝、合集和星图等接口 | 作为后续可插拔连接器；每个接口单独记录价格、权限、来源与合规限制，不直接暴露给 Agent |
| 搜索 | 官方产品页标为 `$0.01/请求`、无量价折扣、每次约 6–10 条；Web/App 搜索不作为入口 | 禁止默认后台搜索；用户点击后才执行 |
| 星图 | 观众画像等企业数据可到 `$0.02/次` 或更高 | 后置为付费研究模块，不阻塞首条账号分析 |
| 价格/用量 | 有 `get_user_info`、`get_user_daily_usage`、`calculate_price`、endpoint info | 设置页显示调用预算、今日用量和本次预计成本 |
| 限制/合规 | 官方说明只返回公开数据；私密内容不可用；评论建议每次不超过 30；默认 RPS 10；下载链接临时 | 记录来源、时间、权限、过期时间和失败原因；不把抓取结果自动晋升为记忆 |

事实与工程推断要分开：TikHub 返回“结构化数据”不等于已经完成脚本/分镜分析。我们仍必须把下载到本地的视频送进自己的 ffprobe、ASR、OCR、镜头和视觉事实管线；AI 结论必须关联作品 ID、时间区间和原始证据。

#### 2.1.1 适合本产品的发现接口优先级

动态价格通过零成本的 `GET /api/v1/tikhub/user/get_endpoint_info` 于 2026-08-14 实测；该元数据端点自身动态价格为 `$0`、限流为 `1/second`。价格会变化，下面只能作为本次快照，正式调用仍要实时读取。

| 产品问题 | TikHub 端点 | 本次动态价格 | 首版用途与边界 |
| --- | --- | ---: | --- |
| 小账号靠什么内容突破 | `POST /api/v1/douyin/billboard/fetch_hot_total_low_fan_list` | `$0.001` | 选题雷达的“低粉爆款”证据；支持 `1/24/72/168h`、关键词和垂类标签；默认只取 10 条 |
| 哪类表达更容易被完整看完 | `POST /api/v1/douyin/billboard/fetch_hot_total_high_play_list` | `$0.001` | 高完播样本池；不能把完播率榜单直接当脚本模板，仍要本地拆镜头/ASR/OCR |
| 用户正在主动搜什么 | `POST /api/v1/douyin/billboard/fetch_hot_total_search_list` | `$0.001` | 搜索热榜与趋势曲线；支持 `1/24/72/168h` 和关键词过滤 |
| 某赛道近期高频内容词 | `POST /api/v1/douyin/billboard/fetch_hot_total_hot_word_list` | `$0.001` | 内容词地图；时间窗口为 `24/72/168h`，用于拓展选题而不是自动生成结论 |
| 对标账号上一周的作品表现 | `GET /api/v1/douyin/billboard/fetch_hot_account_item_analysis_list` | `$0.001` | 账号报告的外部证据补充；参数为 `sec_uid`，文档标题虽写“上周”，描述中出现 `day`，但 OpenAPI 参数表只列 `sec_uid`，适配器不能擅自发送未声明参数 |
| 评论区在讨论什么 | `GET /api/v1/douyin/billboard/fetch_hot_comment_word_list` | `$0.001` | 单作品评论词云，用来找用户问题/误解；不可替代评论原文抽样和人工语义判断 |
| 多个选题词的长期趋势 | `POST /api/v1/douyin/index/fetch_multi_keyword_hot_trend` | `$0.003` | 关键词比较，参数为逗号分隔关键词、`YYYYMMDD` 起止日期、平台与地区；成本更高，用户明确点击后执行 |
| 星图趋势指南 | `GET /api/v1/douyin/xingtu_v2/get_content_trend_guide` | 动态 `$0.001` | 静态页面写 `$0.002/次`，与动态端点信息冲突；证明价格不能写死，星图能力后置 |

批量统计的实现端点为 `GET /api/v1/douyin/app/v3/fetch_multi_video_statistics?aweme_ids=id1,id2,...`。官方单作品页面还特别提醒标准作品数据可能缺少 `play_count`，因此“作品列表拿到但播放量未知”是正常情况；批量接口是有边界的补齐动作，不应放进账号首轮默认请求。动态 `get_endpoint_info` 仍是本地报价的最终来源，官方页面价格变动时 UI 不写死历史值。

账号聚合分析的实现端点为 `GET /api/v1/douyin/billboard/fetch_hot_account_item_analysis_list?sec_uid=...&day=7`。官方文档只保证“账号作品分析”语义，示例响应的 `data` 可能为空，因此 adapter 只接受有限的 `avg_*` / `percentile_*` 数字键；没有数字时报告保持原样，不凭空生成基准。脚本支持显式的 `ACCOUNT_ANALYSIS_BILLED_SMOKE=1`，默认不会调用该付费接口。

低粉榜/高完播榜真实响应不是直接的 `data[]`，而是 `response.data.data.objs[]`；作品字段包含 `item_id/item_title/fans_cnt/play_cnt/score/like_rate/follow_rate` 等。搜索热榜位于 `response.data.data.search_list[]`，包含 `key_word/search_score/trends[]`。适配器已经用归一化对象屏蔽这层供应商嵌套，原始对象只作为受控证据。

### 2.2 APIMart

官方入口：

- [官方文档索引](https://docs.apimart.ai/llms.txt)
- [快速开始](https://docs.apimart.ai/en/quickstart)
- [通用 Chat Completions](https://docs.apimart.ai/en/api-reference/texts/general/chat-completions)
- [模型元数据接口说明](https://docs.apimart.ai/en/api-reference/texts/models/list.md)
- [统一异步任务查询](https://docs.apimart.ai/en/api-reference/tasks/status)
- [Whisper-1 转写](https://docs.apimart.ai/en/api-reference/audios/whisper-1)
- [TTS](https://docs.apimart.ai/en/api-reference/audios/tts)
- [图片上传](https://docs.apimart.ai/en/api-reference/uploads/images)
- [Kling V3 视频生成](https://docs.apimart.ai/en/api-reference/videos/kling-v3/generation)
- [2026 视频模型价格对比](https://apimart.ai/blog/top-ai-video-models-2026-pricing-api-comparison)
- [Token 余额](https://docs.apimart.ai/en/api-reference/account/token-balance)

事实：

| 能力 | 官方合同/限制 | 对本产品的用途 |
| --- | --- | --- |
| Base URL/认证 | `https://api.apimart.ai`；请求使用 Bearer key | 只在 main/provider adapter；不进 Vite 环境变量 |
| 文本 | `POST /v1/chat/completions`，OpenAI-compatible；支持 `stream`、tool/function calling、结构化响应策略由适配器控制 | 脚本、分镜和 AI 剪辑提案 |
| 模型目录 | `GET /v1/models`；文档声明可用 `expand` 获取类别、能力标签和参数 schema；真实 smoke 返回 285 条且当前响应字段主要是 `supported_endpoint_types`，因此不能假设扩展字段一定存在 | 动态模型选择；表单必须从 capability 缺失安全降级 |
| 异步任务 | 图片/视频提交返回 `task_id`，`GET /v1/tasks/{task_id}` 查状态、进度和临时结果 URL | 统一映射 `submitted/polling/completed/failed` 到 Job |
| 图片上传 | `POST /v1/uploads/images`；不再建议把 base64 直接塞进生成接口；URL 有效期文档标为 72 小时 | 生成示意图前先上传；完成后立即本地化 |
| 视频 | 多模型统一 `POST /v1/videos/generations`；当前缺失分镜固定用 `kling-v3` 标准模式、5 秒、9:16；返回异步 `task_id` | 只作为 AI 剪辑提案中的缺口补画面，不替代本人、客户或真实经营过程素材 |
| ASR | Whisper-1 `POST /v1/audio/transcriptions`；99 语言、mp3/mp4/m4a/wav/webm、最大 25MB；支持 json/text/srt/vtt/verbose_json | 云端 fallback；首个本地基线仍优先 whisper.cpp |
| TTS | `POST /v1/audio/speech`；输入最多 4096 字符；输出 wav/opus/aac/flac/pcm 等 | 口播提示音/示意音频；音色克隆另做 provider capability，不把通用 voice 当克隆 |
| 余额 | `GET /v1/balance` 查看当前 key；`GET /v1/user/balance` 查看账户 | 设置页成本保护、低余额预警 |
| 过期 URL | 图片/视频结果 URL 通常 24–72 小时；必须下载到本地并记录 `sourceUrlExpiresAt` | ArtifactManifest 只保存相对路径、hash 和来源摘要 |
| 错误 | 文档列 400/401/402/403/429/500 等 | 归一化为 invalid/auth/quota/rate_limit/provider/retryable，不把原始响应直接交给 UI |

APIMart 的“OpenAI-compatible”只代表协议接近，不代表模型质量、上下文、工具行为和计费完全等价。Provider adapter 必须保存 `providerKey/modelKey/capabilitySnapshot/requestSummary/usage/cost`，不能在 Domain 中写死某家模型名。

#### 2.2.1 Kling V3 缺失分镜合同快照（2026-08-19）

这部分只记录当前受控实现使用的官方合同，不把其他视频模型的参数类推到 `kling-v3`：

| 阶段 | 当前官方合同 | 本地约束 |
| --- | --- | --- |
| 模型发现 | `GET /v1/models?expand=parameters&category=video`；`kling-v3` 当前元数据声明 operation 为 `video_generation`、endpoint 为 `/v1/videos/generations`、参数 schema 版本为 `2026-07-30` | 元数据中的 pricing 当前为空，不能把模型目录当实时账单接口 |
| 提交 | `POST /v1/videos/generations`；本产品固定发送 `model=kling-v3`、`mode=std`、`duration=5`、`aspect_ratio=9:16` 和单条 prompt | 计费提交 `maxRetries=0`；提交不确定时进入 `submission_unknown`，禁止盲目重发 |
| 轮询 | `GET /v1/tasks/{task_id}`；官方状态为 `pending`、`processing`、`completed`、`failed`、`cancelled` | 保存 task ID 后才轮询；状态映射到统一 Job，不再发生成请求 |
| 结果 | 成功视频位于 `data.result.videos[0].url[0]`，同项可带 `expires_at`；任务还可能返回 `progress`、`cost` | 只接受 HTTPS；临时 URL 立即下载、ffprobe 校验、hash 后写入本地 Artifact |

价格必须和接口事实分开：APIMart 官方 2026 视频模型价格对比在 2026-08-19 列出 Kling V3 / Omni 720p 参考价 `$0.0672/秒`，所以本产品的 5 秒分镜显示约 `$0.336`。这是按公开页面计算的**估算快照**，不是模型元数据返回的价格、实时服务端报价或费用上限；确认界面必须显示核对日期，完成后以 Provider 返回的 `cost` 和账户账单为准。若官方文档、模型参数或价格页面变化，先更新快照和合同测试，再允许新的计费提交。

### 2.3 Vercel AI SDK 7

官方入口：

- [AI SDK 结构化输出](https://ai-sdk.dev/docs/ai-sdk-core/generating-structured-data)
- [AI SDK `generateText` 参考](https://ai-sdk.dev/docs/reference/ai-sdk-core/generate-text)
- [OpenAI Compatible Provider](https://ai-sdk.dev/providers/openai-compatible-providers)
- [npm `ai`](https://www.npmjs.com/package/ai)
- [npm `@ai-sdk/openai-compatible`](https://www.npmjs.com/package/@ai-sdk/openai-compatible)

2026-08-14 核对的当前版本为 `ai@7.0.65`、`@ai-sdk/openai-compatible@3.0.30`，Node 要求为 22+，许可证均为 Apache-2.0。AI SDK 7 的推荐结构化输出接口是：

```ts
const result = await generateText({
  model: provider(modelKey),
  output: Output.object({ schema: EditProposalDraftSchema }),
  maxRetries: 0,
});
```

关键实现结论：

1. 使用 `Output.object` 在 Provider 边界校验 Zod Schema，领域层仍要二次检查素材白名单、时间码和分镜归属；
2. `createOpenAICompatible` 的 `supportsStructuredOutputs: true` 会发送 `response_format.type=json_schema`；模型/网关不支持时必须显式降级，不能吞掉 Schema 错误；
3. APIMart 在请求体省略 `stream` 时实测返回 `text/event-stream`，而 AI SDK 的 `generateText` 非流式路径期待一个 JSON 响应；适配器必须通过官方 `transformRequestBody` 补 `stream:false`；
4. 付费模型请求设置 `maxRetries: 0`，避免 SDK 在未知提交状态下重复计费；重试由本地 Job/审批合同拥有；
5. APIMart Base URL 在 AI SDK 中必须包含 `/v1`，而现有 HTTP adapter 保存根地址并自己拼接 `/v1/chat/completions`，两者不能混用。

## 3. 统一 Provider 合同（实施建议）

```ts
interface ProviderPort {
  getCapabilities(): Promise<CapabilityReport>;
  listModels(input?: { refresh?: boolean }): Promise<ModelDescriptor[]>;
  chat(input: StructuredChatRequest): Promise<ProviderChatResult>;
  submit(input: MediaTaskRequest): Promise<SubmittedTask>;
  poll(input: PollTaskRequest): Promise<ProviderTaskStatus>;
  download(input: DownloadRequest): Promise<DownloadedArtifact>;
  validate(input: ValidateProviderOutputRequest): Promise<ValidationResult>;
}
```

TikHub 作为 `ResearchConnector`，与生成模型的 `ProviderPort` 分开，但共用：

```text
ProviderRequestReceipt → Job → Evidence/Artifact → CostReport
```

每个适配器都要：

1. 输入 Zod/JSON Schema 校验，拒绝未知字段和越界数量；
2. 统一超时、重试、429、401、402、提交未知状态；
3. 只记录脱敏的请求摘要和响应 hash，原始响应限体积保存到受控 evidence；
4. 临时 URL 立刻下载、ffprobe/文件 hash、原子落盘；
5. 断网/重启后通过 `externalJobId` 或本地证据恢复，不自动重复付费；
6. mock fixture 先覆盖成功、schema fail、空结果、限流、授权、超时、部分结果和重复提交。

## 4. 本次真实 smoke（小额、可复现）

真实联调的密钥边界、默认请求/费用上限、停止条件和证据留存规则见 [`Provider-Live-Test-Policy-v0.1.md`](./Provider-Live-Test-Policy-v0.1.md)。该政策是以后执行真实测试的门，不把用户在聊天中提供的 key 写入本文件。

运行入口：

```bash
PROVIDER_LIVE_TESTS=1 npm run test:providers:live

# 额外执行 1 次低粉榜、最多 2 条（先由默认 smoke 打印动态价格）
PROVIDER_LIVE_TESTS=1 PROVIDER_DISCOVERY_SMOKE=1 npm run test:providers:live

# 额外执行账号样例 + APIMart 最小文本请求
PROVIDER_LIVE_TESTS=1 PROVIDER_BILLED_SMOKE=1 npm run test:providers:live

# 只执行 1 次 AI SDK 结构化剪辑提案
AGENT_PROVIDER_LIVE=1 AI_EDIT_ADAPTER=ai-sdk npm run test:agent:live

# 只执行 1 次脚本 AI 提案结构化请求；默认跳过，不会后台调用
AGENT_SCRIPT_LIVE=1 npm run test:script:live

# 选题雷达默认只读动态价格，不计费；如需一次受控榜单请求，显式打开且最多 1 条
npm run test:topic-radar:live
TOPIC_RADAR_BILLED_SMOKE=1 TOPIC_RADAR_SOURCE=low_fan npm run test:topic-radar:live
```

脚本：[scripts/provider-smoke.mjs](../scripts/provider-smoke.mjs)。默认只运行无生成任务的健康/凭证/动态价格/模型目录检查；只有显式设置 `PROVIDER_DISCOVERY_SMOKE=1` 才运行一条低粉榜请求，只有显式设置 `PROVIDER_BILLED_SMOKE=1` 才运行一条账号资料和一条最小文本请求。AI SDK 提案使用独立的 [scripts/agent-proposal-smoke.mjs](../scripts/agent-proposal-smoke.mjs)，避免普通 Provider 检查误触模型计费。

本次实际运行：

- TikHub health：HTTP 200，`status=ok`；
- TikHub credential：HTTP 200，返回账户数据（没有打印余额、邮箱、key 名或原始响应）；
- APIMart model list：HTTP 200，返回 285 个模型；扩展字段没有出现在首层，适配器必须做 capability fallback；
- TikHub 动态端点价格：读取了账号作品、榜单、搜索、指数和星图候选端点；价格元数据端点为 `$0`，没有打印账户余额或原始响应；
- TikHub 低粉爆款、高完播、搜索热榜各做小样本，因诊断嵌套字段又补了低粉榜/搜索榜各 1 次，共 5 个 `$0.001` 榜单请求，预计 `$0.005`；每次最多 2 条，只输出字段结构和数量；
- APIMart AI SDK 首次请求因网关默认 SSE 失败；随后做 1 条直接 `json_schema` 诊断、1 条原 HTTP adapter 对照、1 条修复后的 AI SDK 提案，共 4 个小文本请求；最终 AI SDK 返回 1 个合法操作、0 个素材缺口，且只使用确认素材；
- 未运行 TikHub 批量下载、星图画像、评论抓取，未运行 APIMart 图片/视频/语音生成；
- 所有 SDK mock 都设置 `maxRetries: 0`；真实响应正文、密钥、余额和用户账户字段均未写入仓库或日志。
- 脚本提案真实联调使用独立的 `scripts/script-proposal-smoke.mjs`，一次只发一条结构化文本请求；默认跳过，输出只包含 provider/model、响应 hash 是否存在、段落数量和视觉建议数量，不输出脚本文本或来源内容。
- 2026-08-14 脚本结构化 smoke 使用 `gpt-4.1-mini` 成功返回 1–2 个段落；同日用 `gpt-5-nano` 请求该较深的嵌套脚本 schema 时出现 `No output generated`，因此脚本默认模型定为 `gpt-4.1-mini`。模型目录里的 `supported_endpoint_types=openai` 不能单独证明某模型支持 JSON Schema，切换模型前必须先做一次受控 structured-output smoke。
- 脚本使用独立的 `AI_SCRIPT_MODEL`，不自动继承 `AI_EDIT_MODEL`；剪辑提案和脚本提案的结构化 schema/兼容性分别验收，避免一个模型配置变化同时破坏两条用户旅途。

本地 `.env` 仅用于当前机器联调，已被 `.gitignore` 忽略；仓库只提交 `.env.example` 和本文件，不提交任何 key。

2026-08-14 最新默认 live smoke（使用本地 `.env`，未触发计费业务请求）：TikHub health/credential 均 HTTP 200，低粉榜动态报价为 `$0.001` 且限流 `10/second`；APIMart `GET /v1/models?expand=true` HTTP 200，返回 285 个模型。后续真实测试继续从 `npm run test:providers:live` 开始，只有显式设置政策中的开关才允许计费请求。

选题雷达 smoke 的默认边界是单来源、`pageSize=1`、24 小时窗口；`TOPIC_RADAR_BILLED_SMOKE=1` 才会发出一条真实榜单/搜索请求，执行前脚本会先读取动态端点价格。脚本只打印来源、数量、hash 和价格摘要，不打印原始响应、临时 URL、余额或凭证。

## 5. 第一阶段产品功能映射

### A. 对标账号“证据包”

用户粘贴主页链接后，先展示预计请求数和费用，再执行：

1. URL → `sec_user_id`；
2. profile snapshot；
3. 最新 20 条作品 metadata；
4. 只对用户选中的 3–5 条下载/分析；
5. 每条作品生成：文案、时间线、镜头、OCR、ASR、画面标签、互动数据和证据引用；
6. 账号级汇总：高频开头、观点结构、镜头节奏、画面补充方式、评论问题、可借鉴但不复制的选题机会。

“分析几十条”是用户目标，不应变成首次点击就花费几十次下载和视觉调用。默认先 metadata 20 条，再按价值排序增量分析；每一步允许取消、重试和成本上限。

### B. AI 剪辑提案

模型只输出 `EditProposal`：

```text
scriptBlockId / shotId
→ candidate asset IDs
→ in/out timecode
→ reason + evidence IDs
→ confidence + missing material
→ suggested subtitle/style parameters
```

用户批准后冻结为 `FrozenEditSpec`，正式渲染不再问模型。这样 AI 负责“理解、匹配、建议”，媒体执行器负责“可重现、可撤销、可导出”。

### C. 拍摄包补缺口

当素材检索没有命中时，系统不生成虚假的“已找到素材”，而是把缺口转成拍摄任务：拍什么、拍几秒、设备/景别、动作、画面目的、备选拍法。用户用手机或相机拍摄后导入多个 Take，再人工选择。

## 6. 不纳入首个 Provider 版本的事项

- 抖音后台批量搜索或定时爬取；
- 一键下载对标账号几十条高清视频；
- 星图画像/服务报价等较贵企业数据；
- APIMart 图片/视频生成默认自动调用；
- 云端 ASR 取代本地 ASR；
- 自动发布、点赞、评论、关注等交互动作；
- 把临时 URL、原始供应商 JSON 或未确认 AI 结论写成领域事实。

## 7. 风险与决策

| 风险 | 决策 |
| --- | --- |
| API 版本/字段变化 | 保存 `providerVersion`、能力快照和归一化对象；适配器契约测试先于真实联调 |
| TikHub 合规/版权/跨境 | 只分析公开内容，记录来源与用户动作；下载和再利用由用户明确确认，遵守平台条款和适用法律 |
| 大量视频分析成本 | metadata-first、选中后分析、每步预算和取消 |
| APIMart 模型目录字段不稳定 | `supported_endpoint_types` 作为最低能力；缺失时用静态能力映射并标记 `inferred` |
| Provider 任务提交未知 | 本地 Job 进入 `submission_unknown`，查询外部任务或人工确认，禁止盲重试 |
| 临时 URL 过期 | 立即本地化 + hash + ffprobe；失败保留 metadata-only evidence |
| AI 生成“很顺但不像本人” | 保留用户原稿、差异和表达偏好；AI 只给 proposal，不覆盖原文 |

## 8. 下一步实现顺序

1. 已完成：`ProviderPort`、账号 `ResearchConnector`、动态价格读取、榜单/搜索 discovery adapter、AI SDK 结构化 `EditProposalDraft`、mock fixtures，以及“报价后确认”的选题雷达本地证据报告；
2. 下一步：设置页增加凭证状态、动态价格和今日预算（只返回非敏感字段）；
3. 已完成首版：低粉爆款/高完播/搜索热榜作为独立“选题雷达”，每次调用前展示动态范围和价格，不混入默认账号分析；后续再加设置页预算、更多端点和可选的本地深度拆解；
4. 账号研究 UI 补“预算/范围/证据/取消”四个显式状态，并让用户从 20 条 metadata 中选 3–5 条做本地深度拆解；
5. ASR/OCR/视觉模型继续以本地 baseline 为主，APIMart Whisper 仅作用户选择的 fallback；
6. 任何付费图片/视频任务都必须另开审批和成本门，不能从普通“生成拍摄示意图”按钮静默触发。
