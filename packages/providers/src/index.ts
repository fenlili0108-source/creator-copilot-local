import { createHash } from "node:crypto";
import { z } from "zod";

export * from "./ai-sdk.js";

const id = z.string().min(1);

export const ProviderErrorCategorySchema = z.enum(["invalid", "auth", "quota", "rate_limit", "timeout", "provider", "network", "capability"]);
export type ProviderErrorCategory = z.infer<typeof ProviderErrorCategorySchema>;

export const ProviderErrorSchema = z.object({
  schemaVersion: z.literal(1),
  providerKey: id,
  category: ProviderErrorCategorySchema,
  code: id,
  message: id,
  retryable: z.boolean(),
  httpStatus: z.number().int().positive().optional(),
  requestId: id.optional(),
  details: z.record(z.unknown()).optional(),
}).strict();
export type ProviderError = z.infer<typeof ProviderErrorSchema>;

export const ModelDescriptorSchema = z.object({
  schemaVersion: z.literal(1),
  providerKey: id,
  modelKey: id,
  displayName: id,
  capabilities: z.array(z.enum(["chat", "structured_output", "vision", "audio_input", "audio_output", "image_generation", "video_generation", "transcription"])),
  capabilitySource: z.enum(["declared", "inferred", "static_fallback"]),
  contextWindow: z.number().int().positive().optional(),
}).strict();
export type ModelDescriptor = z.infer<typeof ModelDescriptorSchema>;

export const ProviderCapabilityReportSchema = z.object({
  schemaVersion: z.literal(1),
  providerKey: id,
  fetchedAt: z.string().datetime({ offset: true }),
  capabilities: z.array(z.enum(["chat", "structured_output", "vision", "audio_input", "audio_output", "image_generation", "video_generation", "transcription"])),
  source: z.enum(["official", "inferred", "static_fallback"]),
}).strict();
export type ProviderCapabilityReport = z.infer<typeof ProviderCapabilityReportSchema>;

export const StructuredChatMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant"]),
  content: z.string().min(1),
}).strict();

export const StructuredChatRequestSchema = z.object({
  modelKey: id,
  messages: z.array(StructuredChatMessageSchema).min(1).max(100),
  maxTokens: z.number().int().positive().max(32_000).optional(),
  temperature: z.number().min(0).max(2).optional(),
  responseFormat: z.object({ type: z.literal("json_object") }).strict().optional(),
  timeoutMs: z.number().int().positive().max(120_000).default(60_000),
}).strict();
export type StructuredChatRequest = z.input<typeof StructuredChatRequestSchema>;

export const ProviderChatResultSchema = z.object({
  schemaVersion: z.literal(1),
  providerKey: id,
  modelKey: id,
  text: z.string(),
  finishReason: z.string().optional(),
  requestId: id.optional(),
  usage: z.object({ inputTokens: z.number().int().nonnegative().optional(), outputTokens: z.number().int().nonnegative().optional(), totalTokens: z.number().int().nonnegative().optional() }).strict().optional(),
  responseHash: id,
}).strict();
export type ProviderChatResult = z.infer<typeof ProviderChatResultSchema>;

export type ProviderFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface ProviderPort {
  readonly providerKey: string;
  listModels(): Promise<ModelDescriptor[]>;
  getCapabilities(): Promise<ProviderCapabilityReport>;
  chat(input: StructuredChatRequest): Promise<ProviderChatResult>;
}

export const ApiMartVideoGenerationRequestSchema = z.object({
  modelKey: z.literal("kling-v3").default("kling-v3"),
  prompt: z.string().trim().min(1).max(2_500),
  durationSeconds: z.literal(5).default(5),
  aspectRatio: z.literal("9:16").default("9:16"),
  quality: z.literal("standard").default("standard"),
  timeoutMs: z.number().int().positive().max(120_000).default(60_000),
}).strict();
export type ApiMartVideoGenerationRequest = z.input<typeof ApiMartVideoGenerationRequestSchema>;

export const MediaSubmissionSchema = z.object({
  schemaVersion: z.literal(1),
  providerKey: id,
  providerTaskId: id,
  state: z.literal("queued"),
  providerState: id.optional(),
  acceptedAt: z.string().datetime({ offset: true }),
  requestId: id.optional(),
  responseHash: id,
}).strict();
export type MediaSubmission = z.infer<typeof MediaSubmissionSchema>;

export const ProviderMediaOutputSchema = z.object({
  kind: z.literal("video"),
  url: z.string().url().refine((value) => new URL(value).protocol === "https:", "生成结果只允许 HTTPS"),
  expiresAt: z.string().datetime({ offset: true }).optional(),
}).strict();
export type ProviderMediaOutput = z.infer<typeof ProviderMediaOutputSchema>;

export const MediaTaskStatusSchema = z.object({
  schemaVersion: z.literal(1),
  providerKey: id,
  providerTaskId: id,
  state: z.enum(["queued", "processing", "succeeded", "failed", "cancelled"]),
  providerState: id.optional(),
  progress: z.number().int().min(0).max(100).optional(),
  outputs: z.array(ProviderMediaOutputSchema).max(20).optional(),
  error: ProviderErrorSchema.optional(),
  estimatedSeconds: z.number().int().nonnegative().optional(),
  actualSeconds: z.number().int().nonnegative().optional(),
  cost: z.number().nonnegative().optional(),
  observedAt: z.string().datetime({ offset: true }),
  requestId: id.optional(),
  responseHash: id,
}).strict();
export type MediaTaskStatus = z.infer<typeof MediaTaskStatusSchema>;

export interface AsyncMediaProvider {
  readonly providerKey: string;
  submitVideo(input: ApiMartVideoGenerationRequest): Promise<MediaSubmission>;
  pollMediaTask(providerTaskId: string): Promise<MediaTaskStatus>;
}

export type TikHubPage<T> = {
  providerKey: "tikhub";
  source: "public";
  fetchedAt: string;
  cursor: number;
  hasMore: boolean;
  items: T[];
  responseHash: string;
};

export type TikHubProfile = {
  secUserId: string;
  nickname?: string;
  signature?: string;
  followerCount?: number;
  followingCount?: number;
  awemeCount?: number;
  raw: Record<string, unknown>;
};

export type TikHubVideoMetadata = {
  awemeId: string;
  description?: string;
  createTime?: string;
  shareUrl?: string;
  durationMs?: number;
  coverUrl?: string;
  statistics?: Record<string, number>;
  raw: Record<string, unknown>;
};

export type TikHubVideoDownload = {
  awemeId: string;
  url: string;
  requestId?: string;
  responseHash: string;
};

export type TikHubVideoStatistics = {
  awemeId: string;
  statistics: Record<string, number>;
  requestId?: string;
  responseHash: string;
};

export type TikHubAccountWorkAnalysis = {
  secUserId: string;
  day: number;
  metrics: Record<string, number>;
  requestId?: string;
  responseHash: string;
};

export type TikHubEndpointInfo = {
  endpoint: string;
  costUsd: number;
  allowFreeCredit: boolean;
  allowDiscount: boolean;
  rateLimit?: string;
  endpointType?: string;
};

export type TikHubBillboardKind = "low_fan" | "high_completion";

export type TikHubBillboardPost = {
  awemeId: string;
  title?: string;
  coverUrl?: string;
  durationValue?: number;
  nickname?: string;
  followerCount?: number;
  playCount?: number;
  publishedAt?: string;
  score?: number;
  shareUrl?: string;
  likeCount?: number;
  followCount?: number;
  followRate?: number;
  likeRate?: number;
  mediaType?: number;
  imageCount?: number;
  raw: Record<string, unknown>;
};

export type TikHubBillboardPage = {
  providerKey: "tikhub";
  kind: TikHubBillboardKind;
  fetchedAt: string;
  page: number;
  pageSize: number;
  total: number;
  items: TikHubBillboardPost[];
  responseHash: string;
};

export type TikHubSearchTrend = {
  keyword: string;
  score?: number;
  trends: Array<{ date: string; value: number }>;
  raw: Record<string, unknown>;
};

export interface ResearchConnector {
  readonly providerKey: string;
  resolveSecUserId(urlOrId: string): Promise<string>;
  fetchProfile(secUserId: string): Promise<TikHubProfile>;
  fetchUserPosts(input: { secUserId: string; maxCursor?: number; count?: number; sortType?: 0 | 1 }): Promise<TikHubPage<TikHubVideoMetadata>>;
  fetchHighestQualityPlayUrl(input: { awemeId: string; shareUrl?: string; region?: string }): Promise<TikHubVideoDownload>;
  fetchVideoStatistics?(awemeIds: string[]): Promise<TikHubVideoStatistics[]>;
  fetchAccountWorkAnalysis?(input: { secUserId: string; day?: number }): Promise<TikHubAccountWorkAnalysis>;
}

function hashResponse(value: unknown) {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function responseRequestId(body: Record<string, unknown>, response: Response) {
  const value = body.request_id ?? body.requestId ?? response.headers.get("x-request-id") ?? undefined;
  return typeof value === "string" && value ? value : undefined;
}

function errorCategory(status: number, body: Record<string, unknown>): ProviderErrorCategory {
  if (status === 401 || status === 403) return "auth";
  if (status === 402) return "quota";
  if (status === 429) return "rate_limit";
  if (status >= 400 && status < 500) return "invalid";
  return "provider";
}

function throwProviderError(providerKey: string, response: Response, body: Record<string, unknown>): never {
  const category = errorCategory(response.status, body);
  const bodyError = typeof body.error === "object" && body.error ? body.error as Record<string, unknown> : undefined;
  const code = String(bodyError?.code ?? body.code ?? `HTTP_${response.status}`);
  const message = String(bodyError?.message ?? body.message ?? "Provider 请求失败").slice(0, 500);
  throw new ProviderRequestError(ProviderErrorSchema.parse({
    schemaVersion: 1,
    providerKey,
    category,
    code,
    message,
    retryable: category === "rate_limit" || category === "timeout" || category === "network" || response.status >= 500,
    httpStatus: response.status,
    requestId: responseRequestId(body, response),
  }));
}

export class ProviderRequestError extends Error {
  readonly normalized: ProviderError;

  constructor(normalized: ProviderError) {
    super(normalized.message);
    this.name = "ProviderRequestError";
    this.normalized = normalized;
  }
}

async function fetchJson(providerKey: string, baseUrl: string, path: string, init: RequestInit, timeoutMs: number, fetcher: ProviderFetch) {
  let response: Response;
  try {
    response = await fetcher(new URL(path, baseUrl), { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    const timedOut = error instanceof DOMException && error.name === "TimeoutError";
    throw new ProviderRequestError(ProviderErrorSchema.parse({ schemaVersion: 1, providerKey, category: timedOut ? "timeout" : "network", code: timedOut ? "TIMEOUT" : "NETWORK_ERROR", message: timedOut ? "Provider 请求超时" : "Provider 网络请求失败", retryable: true }));
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = {};
  }
  const objectBody = typeof body === "object" && body !== null ? body as Record<string, unknown> : {};
  if (!response.ok) throwProviderError(providerKey, response, objectBody);
  return { response, body: objectBody };
}

function bearer(apiKey: string) {
  if (!apiKey) throw new Error("Provider API key 未配置");
  return { Authorization: `Bearer ${apiKey}` };
}

function inferredMediaCapabilities(modelKey: string) {
  const capabilities: ModelDescriptor["capabilities"] = [];
  const normalized = modelKey.toLowerCase();
  const videoModel = /(?:^|[-_.])(sora|veo|kling|wan\d|seedance|hailuo|vidu|happyhorse|skyreels)(?:[-_.]|$)|(?:^|[-_.])video(?:[-_.]|$)|omni-flash-ext|ltx-[\d.]+-(?:text-|image-)?video/.test(normalized);
  const imageModel = /(?:^|[-_.])(gpt-image|imagen|image-generation)(?:[-_.]|$)|grok-imagine-image/.test(normalized);
  if (videoModel) capabilities.push("video_generation");
  if (imageModel) capabilities.push("image_generation");
  return capabilities;
}

function modelCapabilities(item: Record<string, unknown>) {
  const endpoints = Array.isArray(item.supported_endpoint_types) ? item.supported_endpoint_types.filter((value): value is string => typeof value === "string") : [];
  const modelKey = typeof item.id === "string" ? item.id : typeof item.name === "string" ? item.name : "";
  const capabilities: ModelDescriptor["capabilities"] = inferredMediaCapabilities(modelKey);
  if (endpoints.some((value) => /chat|text|completion/i.test(value))) capabilities.push("chat");
  if (endpoints.some((value) => /vision|image_input/i.test(value))) capabilities.push("vision");
  if (endpoints.some((value) => /image[-_ ]?generation/i.test(value))) capabilities.push("image_generation");
  if (endpoints.some((value) => /video[-_ ]?generation/i.test(value))) capabilities.push("video_generation");
  if (endpoints.some((value) => /audio|transcription|whisper/i.test(value))) capabilities.push("audio_input", "transcription");
  return capabilities.length > 0 ? [...new Set(capabilities)] : ["chat"];
}

function messageText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((part) => typeof part === "string" ? part : typeof part === "object" && part && "text" in part ? String((part as { text: unknown }).text) : "").join("");
  return "";
}

function apiMartErrorCategory(code: number | undefined): ProviderErrorCategory {
  if (code === 401 || code === 403) return "auth";
  if (code === 402) return "quota";
  if (code === 429) return "rate_limit";
  if (code !== undefined && code >= 400 && code < 500) return "invalid";
  return "provider";
}

function assertApiMartSuccess(result: { response: Response; body: Record<string, unknown> }) {
  const rawCode = result.body.code;
  const code = typeof rawCode === "number" ? rawCode : typeof rawCode === "string" && /^\d+$/.test(rawCode) ? Number(rawCode) : undefined;
  if ((code === undefined || code === 0 || code === 200) && result.body.success !== false) return;
  const category = apiMartErrorCategory(code);
  const bodyError = typeof result.body.error === "object" && result.body.error ? result.body.error as Record<string, unknown> : undefined;
  throw new ProviderRequestError(ProviderErrorSchema.parse({
    schemaVersion: 1,
    providerKey: "apimart",
    category,
    code: String(bodyError?.code ?? rawCode ?? "APIMART_BUSINESS_ERROR"),
    message: String(bodyError?.message ?? result.body.message ?? "APIMart 返回业务错误").slice(0, 500),
    retryable: category === "rate_limit" || category === "timeout" || category === "network" || (code !== undefined && code >= 500),
    httpStatus: result.response.status,
    requestId: responseRequestId(result.body, result.response),
  }));
}

function firstApiMartTask(body: Record<string, unknown>) {
  const value = body.data;
  if (Array.isArray(value)) return value.find((item): item is Record<string, unknown> => typeof item === "object" && item !== null);
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : body;
}

function normalizedMediaState(providerState: string): MediaTaskStatus["state"] | undefined {
  const state = providerState.toLowerCase().replace(/[ -]+/g, "_");
  if (["submitted", "pending", "queueing", "queued"].includes(state)) return "queued";
  if (["processing", "in_progress", "running"].includes(state)) return "processing";
  if (["completed", "success", "succeeded"].includes(state)) return "succeeded";
  if (["failed", "error"].includes(state)) return "failed";
  if (["cancelled", "canceled"].includes(state)) return "cancelled";
  return undefined;
}

function isoExpiry(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return new Date(value * 1_000).toISOString();
  if (typeof value !== "string" || !value) return undefined;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : undefined;
}

function httpsMediaUrl(value: unknown) {
  if (typeof value !== "string" || !value) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ProviderRequestError(ProviderErrorSchema.parse({ schemaVersion: 1, providerKey: "apimart", category: "provider", code: "MEDIA_URL_INVALID", message: "APIMart 返回的视频地址无效", retryable: false }));
  }
  if (parsed.protocol !== "https:") throw new ProviderRequestError(ProviderErrorSchema.parse({ schemaVersion: 1, providerKey: "apimart", category: "provider", code: "MEDIA_URL_UNSAFE", message: "APIMart 返回的视频地址不是 HTTPS", retryable: false }));
  return parsed.toString();
}

function mediaOutputs(task: Record<string, unknown>) {
  const result = typeof task.result === "object" && task.result ? task.result as Record<string, unknown> : {};
  const videos = Array.isArray(result.videos) ? result.videos : [];
  const outputs: ProviderMediaOutput[] = [];
  for (const item of videos) {
    if (typeof item === "string") {
      const url = httpsMediaUrl(item);
      if (url) outputs.push(ProviderMediaOutputSchema.parse({ kind: "video", url }));
      continue;
    }
    if (typeof item !== "object" || !item) continue;
    const record = item as Record<string, unknown>;
    const candidates = Array.isArray(record.url) ? record.url : [record.url ?? record.video_url];
    const expiresAt = isoExpiry(record.expires_at ?? record.expiresAt);
    for (const candidate of candidates) {
      const url = httpsMediaUrl(candidate);
      if (url) outputs.push(ProviderMediaOutputSchema.parse({ kind: "video", url, expiresAt }));
    }
  }
  return outputs;
}

export class ApiMartClient implements ProviderPort, AsyncMediaProvider {
  readonly providerKey = "apimart" as const;

  constructor(private readonly options: { apiKey: string; baseUrl?: string; fetcher?: ProviderFetch }) {}

  private get baseUrl() { return this.options.baseUrl ?? "https://api.apimart.ai"; }
  private get fetcher() { return this.options.fetcher ?? fetch; }

  async listModels() {
    const result = await fetchJson(this.providerKey, this.baseUrl, "/v1/models?expand=true", { headers: bearer(this.options.apiKey) }, 30_000, this.fetcher);
    const items = Array.isArray(result.body.data) ? result.body.data : Array.isArray(result.body.models) ? result.body.models : [];
    return items.flatMap((item) => {
      if (typeof item !== "object" || !item) return [];
      const raw = item as Record<string, unknown>;
      const modelKey = typeof raw.id === "string" ? raw.id : typeof raw.name === "string" ? raw.name : undefined;
      if (!modelKey) return [];
      return [ModelDescriptorSchema.parse({ schemaVersion: 1, providerKey: this.providerKey, modelKey, displayName: typeof raw.name === "string" ? raw.name : modelKey, capabilities: modelCapabilities(raw), capabilitySource: Array.isArray(raw.supported_endpoint_types) ? "declared" : "inferred", contextWindow: typeof raw.context_length === "number" ? raw.context_length : undefined })];
    });
  }

  async getCapabilities() {
    const models = await this.listModels();
    const capabilities: ProviderCapabilityReport["capabilities"] = [];
    for (const model of models) for (const capability of model.capabilities) if (!capabilities.includes(capability)) capabilities.push(capability);
    return ProviderCapabilityReportSchema.parse({ schemaVersion: 1, providerKey: this.providerKey, fetchedAt: new Date().toISOString(), capabilities, source: models.length > 0 ? "inferred" : "static_fallback" });
  }

  async chat(raw: StructuredChatRequest) {
    const input = StructuredChatRequestSchema.parse(raw);
    const body = {
      model: input.modelKey,
      stream: false,
      messages: input.messages,
      ...(input.maxTokens ? { max_tokens: input.maxTokens } : {}),
      ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
      ...(input.responseFormat ? { response_format: input.responseFormat } : {}),
    };
    const result = await fetchJson(this.providerKey, this.baseUrl, "/v1/chat/completions", { method: "POST", headers: { ...bearer(this.options.apiKey), "Content-Type": "application/json" }, body: JSON.stringify(body) }, input.timeoutMs, this.fetcher);
    const choice = Array.isArray(result.body.choices) ? result.body.choices[0] as Record<string, unknown> | undefined : undefined;
    const message = choice && typeof choice.message === "object" && choice.message ? choice.message as Record<string, unknown> : {};
    const payload = ProviderChatResultSchema.parse({ schemaVersion: 1, providerKey: this.providerKey, modelKey: typeof result.body.model === "string" ? result.body.model : input.modelKey, text: messageText(message.content), finishReason: typeof choice?.finish_reason === "string" ? choice.finish_reason : undefined, requestId: responseRequestId(result.body, result.response), usage: typeof result.body.usage === "object" && result.body.usage ? { inputTokens: Number((result.body.usage as Record<string, unknown>).prompt_tokens) || undefined, outputTokens: Number((result.body.usage as Record<string, unknown>).completion_tokens) || undefined, totalTokens: Number((result.body.usage as Record<string, unknown>).total_tokens) || undefined } : undefined, responseHash: hashResponse(result.body) });
    return payload;
  }

  async submitVideo(raw: ApiMartVideoGenerationRequest) {
    const input = ApiMartVideoGenerationRequestSchema.parse(raw);
    const result = await fetchJson(this.providerKey, this.baseUrl, "/v1/videos/generations", {
      method: "POST",
      headers: { ...bearer(this.options.apiKey), "Content-Type": "application/json" },
      body: JSON.stringify({
        model: input.modelKey,
        prompt: input.prompt,
        mode: input.quality === "standard" ? "std" : input.quality,
        duration: input.durationSeconds,
        aspect_ratio: input.aspectRatio,
      }),
    }, input.timeoutMs, this.fetcher);
    assertApiMartSuccess(result);
    const task = firstApiMartTask(result.body);
    const providerTaskId = typeof task?.task_id === "string" ? task.task_id : typeof task?.id === "string" ? task.id : undefined;
    if (!providerTaskId) throw new ProviderRequestError(ProviderErrorSchema.parse({ schemaVersion: 1, providerKey: this.providerKey, category: "provider", code: "TASK_ID_MISSING", message: "APIMart 没有返回视频任务 ID；为避免重复扣费，不会自动重提", retryable: false, requestId: responseRequestId(result.body, result.response) }));
    const providerState = typeof task?.status === "string" && task.status ? task.status : undefined;
    return MediaSubmissionSchema.parse({
      schemaVersion: 1,
      providerKey: this.providerKey,
      providerTaskId,
      state: "queued",
      providerState,
      acceptedAt: new Date().toISOString(),
      requestId: responseRequestId(result.body, result.response),
      responseHash: hashResponse(result.body),
    });
  }

  async pollMediaTask(rawProviderTaskId: string) {
    const providerTaskId = z.string().min(1).max(200).regex(/^[A-Za-z0-9._:-]+$/).parse(rawProviderTaskId);
    const result = await fetchJson(this.providerKey, this.baseUrl, `/v1/tasks/${encodeURIComponent(providerTaskId)}?language=zh`, { headers: bearer(this.options.apiKey) }, 30_000, this.fetcher);
    assertApiMartSuccess(result);
    const task = firstApiMartTask(result.body) ?? {};
    const providerState = typeof task.status === "string" && task.status ? task.status : undefined;
    if (!providerState) throw new ProviderRequestError(ProviderErrorSchema.parse({ schemaVersion: 1, providerKey: this.providerKey, category: "provider", code: "MEDIA_STATUS_MISSING", message: "APIMart 任务响应缺少状态；任务 ID 已保留，不会自动重提", retryable: false, requestId: responseRequestId(result.body, result.response) }));
    const state = normalizedMediaState(providerState);
    if (!state) throw new ProviderRequestError(ProviderErrorSchema.parse({ schemaVersion: 1, providerKey: this.providerKey, category: "provider", code: "MEDIA_STATUS_UNKNOWN", message: `APIMart 返回了未识别的任务状态：${providerState.slice(0, 100)}`, retryable: false, requestId: responseRequestId(result.body, result.response) }));
    const outputs = mediaOutputs(task);
    if (state === "succeeded" && outputs.length === 0) throw new ProviderRequestError(ProviderErrorSchema.parse({ schemaVersion: 1, providerKey: this.providerKey, category: "provider", code: "MEDIA_OUTPUT_MISSING", message: "APIMart 显示任务完成，但没有返回可下载的视频地址", retryable: false, requestId: responseRequestId(result.body, result.response) }));
    const message = typeof task.message === "string" ? task.message : typeof task.error === "string" ? task.error : typeof task.error === "object" && task.error && typeof (task.error as Record<string, unknown>).message === "string" ? (task.error as Record<string, unknown>).message as string : undefined;
    const error = state === "failed" ? ProviderErrorSchema.parse({
      schemaVersion: 1,
      providerKey: this.providerKey,
      category: "provider",
      code: "MEDIA_GENERATION_FAILED",
      message: (message ?? "APIMart 视频生成失败").slice(0, 500),
      retryable: false,
      requestId: responseRequestId(result.body, result.response),
    }) : undefined;
    return MediaTaskStatusSchema.parse({
      schemaVersion: 1,
      providerKey: this.providerKey,
      providerTaskId,
      state,
      providerState,
      progress: typeof task.progress === "number" ? Math.max(0, Math.min(100, Math.round(task.progress))) : undefined,
      outputs: outputs.length > 0 ? outputs : undefined,
      error,
      estimatedSeconds: typeof task.estimated_time === "number" ? Math.max(0, Math.round(task.estimated_time)) : undefined,
      actualSeconds: typeof task.actual_time === "number" ? Math.max(0, Math.round(task.actual_time)) : undefined,
      cost: typeof task.cost === "number" && task.cost >= 0 ? task.cost : undefined,
      observedAt: new Date().toISOString(),
      requestId: responseRequestId(result.body, result.response),
      responseHash: hashResponse(result.body),
    });
  }
}

function dataPayload(body: Record<string, unknown>) {
  return typeof body.data === "object" && body.data !== null ? body.data as Record<string, unknown> : body;
}

function assertTikHubSuccess(result: { response: Response; body: Record<string, unknown> }) {
  const candidates = [result.body, dataPayload(result.body)];
  for (const body of candidates) {
    const code = typeof body.code === "number" ? body.code : undefined;
    if (code === undefined || code === 0 || code === 200) continue;
    const category: ProviderErrorCategory = code === 401 || code === 403 ? "auth" : code === 402 ? "quota" : code === 429 ? "rate_limit" : "provider";
    throw new ProviderRequestError(ProviderErrorSchema.parse({
      schemaVersion: 1,
      providerKey: "tikhub",
      category,
      code: String(code),
      message: typeof body.message === "string" ? body.message.slice(0, 500) : "TikHub 返回业务错误",
      retryable: category === "rate_limit" || code >= 500,
      httpStatus: result.response.status,
      requestId: responseRequestId(result.body, result.response),
    }));
  }
}

function firstString(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) if (typeof record[key] === "string" && record[key]) return record[key] as string;
  return undefined;
}

export class TikHubDouyinConnector implements ResearchConnector {
  readonly providerKey = "tikhub" as const;

  constructor(private readonly options: { apiKey: string; baseUrl?: string; fetcher?: ProviderFetch }) {}

  private get baseUrl() { return this.options.baseUrl ?? "https://api.tikhub.dev"; }
  private get fetcher() { return this.options.fetcher ?? fetch; }
  private async get(path: string, params: Record<string, string | number>) {
    const url = new URL(path, this.baseUrl);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
    const result = await fetchJson(this.providerKey, this.baseUrl, `${url.pathname}${url.search}`, { headers: bearer(this.options.apiKey) }, 30_000, this.fetcher);
    assertTikHubSuccess(result);
    return result;
  }
  private async post(path: string, body: Record<string, unknown>) {
    const result = await fetchJson(this.providerKey, this.baseUrl, path, { method: "POST", headers: { ...bearer(this.options.apiKey), "Content-Type": "application/json" }, body: JSON.stringify(body) }, 30_000, this.fetcher);
    assertTikHubSuccess(result);
    return result;
  }

  async getEndpointInfo(endpoint: string): Promise<TikHubEndpointInfo> {
    const normalizedEndpoint = z.string().min(1).max(500).regex(/^\/api\//).parse(endpoint);
    const url = new URL("/api/v1/tikhub/user/get_endpoint_info", this.baseUrl);
    url.searchParams.set("endpoint", normalizedEndpoint);
    const result = await fetchJson(this.providerKey, this.baseUrl, `${url.pathname}${url.search}`, {}, 30_000, this.fetcher);
    assertTikHubSuccess(result);
    const data = dataPayload(result.body);
    return {
      endpoint: firstString(data, ["endpoint_uri", "endpoint"]) ?? normalizedEndpoint,
      costUsd: typeof data.endpoint_cost === "number" ? data.endpoint_cost : 0,
      allowFreeCredit: data.allow_free_credit === true,
      allowDiscount: data.allow_discount === true,
      rateLimit: firstString(data, ["rate_limit"]),
      endpointType: firstString(data, ["endpoint_type"]),
    };
  }

  async fetchBillboardPosts(input: { kind: TikHubBillboardKind; page?: number; pageSize?: number; dateWindow?: 1 | 24 | 72 | 168; keyword?: string; tags?: Array<{ value: number; children?: Array<{ value: number }> }> }): Promise<TikHubBillboardPage> {
    const parsed = z.object({
      kind: z.enum(["low_fan", "high_completion"]),
      page: z.number().int().positive().max(100).default(1),
      pageSize: z.number().int().positive().max(20).default(10),
      dateWindow: z.union([z.literal(1), z.literal(24), z.literal(72), z.literal(168)]).default(24),
      keyword: z.string().max(100).default(""),
      tags: z.array(z.object({ value: z.number().int().nonnegative(), children: z.array(z.object({ value: z.number().int().nonnegative() }).strict()).max(30).optional() }).strict()).max(10).default([]),
    }).strict().parse(input);
    const path = parsed.kind === "low_fan" ? "/api/v1/douyin/billboard/fetch_hot_total_low_fan_list" : "/api/v1/douyin/billboard/fetch_hot_total_high_play_list";
    const result = await this.post(path, { page: parsed.page, page_size: parsed.pageSize, date_window: parsed.dateWindow, keyword: parsed.keyword, tags: parsed.tags });
    const outer = dataPayload(result.body);
    const data = dataPayload(outer);
    const page = typeof data.page === "object" && data.page ? data.page as Record<string, unknown> : {};
    const rawItems = Array.isArray(data.objs) ? data.objs : [];
    const items = rawItems.flatMap((item): TikHubBillboardPost[] => {
      if (!item || typeof item !== "object") return [];
      const raw = item as Record<string, unknown>;
      const awemeId = firstString(raw, ["item_id", "aweme_id", "id"]);
      if (!awemeId) return [];
      return [{
        awemeId,
        title: firstString(raw, ["item_title", "title", "desc"]),
        coverUrl: firstString(raw, ["item_cover_url", "cover_url"]),
        durationValue: typeof raw.item_duration === "number" ? raw.item_duration : undefined,
        nickname: firstString(raw, ["nick_name", "nickname"]),
        followerCount: typeof raw.fans_cnt === "number" ? raw.fans_cnt : undefined,
        playCount: typeof raw.play_cnt === "number" ? raw.play_cnt : undefined,
        publishedAt: typeof raw.publish_time === "number" ? new Date(raw.publish_time * 1000).toISOString() : undefined,
        score: typeof raw.score === "number" ? raw.score : undefined,
        shareUrl: firstString(raw, ["item_url", "share_url"]),
        likeCount: typeof raw.like_cnt === "number" ? raw.like_cnt : undefined,
        followCount: typeof raw.follow_cnt === "number" ? raw.follow_cnt : undefined,
        followRate: typeof raw.follow_rate === "number" ? raw.follow_rate : undefined,
        likeRate: typeof raw.like_rate === "number" ? raw.like_rate : undefined,
        mediaType: typeof raw.media_type === "number" ? raw.media_type : undefined,
        imageCount: typeof raw.image_cnt === "number" ? raw.image_cnt : undefined,
        raw,
      }];
    });
    return {
      providerKey: this.providerKey,
      kind: parsed.kind,
      fetchedAt: new Date().toISOString(),
      page: typeof page.page === "number" ? page.page : parsed.page,
      pageSize: typeof page.page_size === "number" ? page.page_size : parsed.pageSize,
      total: typeof page.total === "number" ? page.total : items.length,
      items,
      responseHash: hashResponse(result.body),
    };
  }

  async fetchSearchHotList(input: { page?: number; pageSize?: number; dateWindow?: 1 | 24 | 72 | 168; keyword?: string }) {
    const parsed = z.object({ page: z.number().int().positive().max(100).default(1), pageSize: z.number().int().positive().max(20).default(10), dateWindow: z.union([z.literal(1), z.literal(24), z.literal(72), z.literal(168)]).default(24), keyword: z.string().max(100).default("") }).strict().parse(input);
    const result = await this.post("/api/v1/douyin/billboard/fetch_hot_total_search_list", { page_num: parsed.page, page_size: parsed.pageSize, date_window: parsed.dateWindow, keyword: parsed.keyword });
    const outer = dataPayload(result.body);
    const data = dataPayload(outer);
    const rawItems = Array.isArray(data.search_list) ? data.search_list : [];
    const items = rawItems.flatMap((item): TikHubSearchTrend[] => {
      if (!item || typeof item !== "object") return [];
      const raw = item as Record<string, unknown>;
      const keyword = firstString(raw, ["key_word", "keyword"]);
      if (!keyword) return [];
      const rawTrends = Array.isArray(raw.trends) ? raw.trends : [];
      const trends = rawTrends.flatMap((trend) => {
        if (!trend || typeof trend !== "object") return [];
        const value = trend as Record<string, unknown>;
        return typeof value.date === "string" && typeof value.value === "number" ? [{ date: value.date, value: value.value }] : [];
      });
      return [{ keyword, score: typeof raw.search_score === "number" ? raw.search_score : undefined, trends, raw }];
    });
    return { providerKey: this.providerKey, fetchedAt: new Date().toISOString(), page: typeof data.page_num === "number" ? data.page_num : parsed.page, pageSize: typeof data.page_size === "number" ? data.page_size : parsed.pageSize, total: typeof data.total_count === "number" ? data.total_count : items.length, items, responseHash: hashResponse(result.body) };
  }

  async resolveSecUserId(urlOrId: string) {
    const value = urlOrId.trim();
    if (!value) throw new Error("抖音账号链接不能为空");
    if (/^MS4wLjAB/.test(value)) return value;
    const result = await this.get("/api/v1/douyin/web/get_sec_user_id", { url: value });
    const data = dataPayload(result.body);
    const secUserId = firstString(data, ["sec_user_id", "secUserId"]);
    if (!secUserId) throw new ProviderRequestError(ProviderErrorSchema.parse({ schemaVersion: 1, providerKey: this.providerKey, category: "invalid", code: "SEC_USER_ID_NOT_FOUND", message: "没有从链接解析出抖音账号 ID", retryable: false, requestId: responseRequestId(result.body, result.response) }));
    return secUserId;
  }

  async fetchProfile(secUserId: string) {
    const normalizedId = id.parse(secUserId);
    const result = await this.get("/api/v1/douyin/app/v3/handler_user_profile", { sec_user_id: normalizedId });
    const data = dataPayload(result.body);
    // App V3 currently nests the public user object under data.user. Keep the
    // direct-data fallback for older responses and fixtures.
    const user = typeof data.user === "object" && data.user !== null ? data.user as Record<string, unknown> : data;
    return {
      secUserId: normalizedId,
      nickname: firstString(user, ["nickname", "nickname_full"]),
      signature: firstString(user, ["signature", "desc"]),
      followerCount: typeof user.follower_count === "number" ? user.follower_count : undefined,
      followingCount: typeof user.following_count === "number" ? user.following_count : undefined,
      awemeCount: typeof user.aweme_count === "number" ? user.aweme_count : undefined,
      raw: data,
    } satisfies TikHubProfile;
  }

  async fetchUserPosts(input: { secUserId: string; maxCursor?: number; count?: number; sortType?: 0 | 1 }) {
    const count = input.count ?? 20;
    if (!Number.isInteger(count) || count < 1 || count > 20) throw new Error("TikHub 作品分页 count 必须在 1–20 之间");
    const cursor = input.maxCursor ?? 0;
    if (!Number.isInteger(cursor) || cursor < 0) throw new Error("TikHub maxCursor 必须是非负整数");
    const result = await this.get("/api/v1/douyin/app/v3/fetch_user_post_videos", { sec_user_id: id.parse(input.secUserId), max_cursor: cursor, count, sort_type: input.sortType ?? 0 });
    const data = dataPayload(result.body);
    const rawItems = Array.isArray(data.aweme_list) ? data.aweme_list : Array.isArray(data.items) ? data.items : Array.isArray(result.body.data) ? result.body.data : [];
    const items = rawItems.flatMap((item) => {
      if (typeof item !== "object" || !item) return [];
      const raw = item as Record<string, unknown>;
      const awemeId = firstString(raw, ["aweme_id", "awemeId", "id"]);
      if (!awemeId) return [];
      const video = typeof raw.video === "object" && raw.video ? raw.video as Record<string, unknown> : {};
      const statistics = typeof raw.statistics === "object" && raw.statistics ? raw.statistics as Record<string, unknown> : {};
      const durationMs = typeof video.duration === "number" ? Math.round(video.duration) : typeof raw.duration === "number" ? Math.round(raw.duration > 100 ? raw.duration : raw.duration * 1000) : undefined;
      return [{ awemeId, description: firstString(raw, ["desc", "description"]), createTime: typeof raw.create_time === "number" ? new Date(raw.create_time * 1000).toISOString() : firstString(raw, ["create_time", "createTime"]), shareUrl: firstString(raw, ["share_url", "shareUrl"]), durationMs, coverUrl: firstString(video, ["cover", "cover_url", "coverUrl"]), statistics: Object.fromEntries(Object.entries(statistics).filter((entry): entry is [string, number] => typeof entry[1] === "number")), raw }];
    });
    return { providerKey: this.providerKey, source: "public" as const, fetchedAt: new Date().toISOString(), cursor, hasMore: Boolean(data.has_more ?? data.hasMore), items, responseHash: hashResponse(result.body) } satisfies TikHubPage<TikHubVideoMetadata>;
  }

  async fetchHighestQualityPlayUrl(input: { awemeId: string; shareUrl?: string; region?: string }) {
    const awemeId = id.parse(input.awemeId);
    const result = await this.get("/api/v1/douyin/app/v3/fetch_video_high_quality_play_url", {
      ...(awemeId ? { aweme_id: awemeId } : {}),
      ...(input.shareUrl ? { share_url: input.shareUrl } : {}),
      ...(input.region ? { region: input.region } : {}),
    });
    const data = dataPayload(result.body);
    const url = firstString(data, ["original_video_url", "video_url", "play_url", "url"]);
    if (!url) throw new ProviderRequestError(ProviderErrorSchema.parse({ schemaVersion: 1, providerKey: this.providerKey, category: "provider", code: "VIDEO_URL_NOT_FOUND", message: "TikHub 未返回可下载的视频地址", retryable: false, requestId: responseRequestId(result.body, result.response) }));
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new ProviderRequestError(ProviderErrorSchema.parse({ schemaVersion: 1, providerKey: this.providerKey, category: "provider", code: "VIDEO_URL_INVALID", message: "TikHub 返回的视频地址无效", retryable: false, requestId: responseRequestId(result.body, result.response) }));
    }
    if (parsed.protocol !== "https:") throw new ProviderRequestError(ProviderErrorSchema.parse({ schemaVersion: 1, providerKey: this.providerKey, category: "provider", code: "VIDEO_URL_UNSAFE", message: "TikHub 返回的视频地址不是 HTTPS", retryable: false, requestId: responseRequestId(result.body, result.response) }));
    return { awemeId, url: parsed.toString(), requestId: responseRequestId(result.body, result.response), responseHash: hashResponse(result.body) } satisfies TikHubVideoDownload;
  }

  async fetchVideoStatistics(awemeIds: string[]) {
    const ids = z.array(id).min(1).max(50).parse(awemeIds);
    const result = await this.get("/api/v1/douyin/app/v3/fetch_multi_video_statistics", { aweme_ids: ids.join(",") });
    const data = dataPayload(result.body);
    const candidates: Array<{ awemeId?: string; statistics?: Record<string, unknown> }> = [];
    const addCandidate = (awemeId: unknown, value: unknown) => {
      if (typeof value !== "object" || !value) return;
      const raw = value as Record<string, unknown>;
      const statistics = typeof raw.statistics === "object" && raw.statistics ? raw.statistics as Record<string, unknown> : raw;
      const normalizedId = typeof awemeId === "string" ? awemeId : firstString(raw, ["aweme_id", "awemeId", "item_id", "id"]);
      if (normalizedId) candidates.push({ awemeId: normalizedId, statistics });
    };
    const list = Array.isArray(data) ? data : Array.isArray(data.items) ? data.items : Array.isArray(data.statistics) ? data.statistics : undefined;
    if (list) for (const item of list) addCandidate(undefined, item);
    else if (typeof data === "object" && data) for (const [key, value] of Object.entries(data)) addCandidate(key, value);
    const allowedKeys = new Set(["digg_count", "download_count", "play_count", "share_count"]);
    const output: TikHubVideoStatistics[] = [];
    for (const candidate of candidates) {
      if (!candidate.awemeId || !ids.includes(candidate.awemeId) || !candidate.statistics) continue;
      const statistics: Record<string, number> = {};
      for (const [key, value] of Object.entries(candidate.statistics)) if (allowedKeys.has(key) && typeof value === "number" && Number.isFinite(value) && value >= 0) statistics[key] = value;
      if (Object.keys(statistics).length > 0) output.push({ awemeId: candidate.awemeId, statistics, requestId: responseRequestId(result.body, result.response), responseHash: hashResponse(result.body) });
    }
    return output;
  }

  async fetchAccountWorkAnalysis(input: { secUserId: string; day?: number }) {
    const secUid = id.parse(input.secUserId);
    const day = z.number().int().positive().max(30).default(7).parse(input.day);
    const result = await this.get("/api/v1/douyin/billboard/fetch_hot_account_item_analysis_list", { sec_uid: secUid, day });
    const outer = dataPayload(result.body);
    const data = dataPayload(outer);
    const metrics: Record<string, number> = {};
    for (const [key, value] of Object.entries(data)) {
      if (!/^(avg|percentile)_/.test(key) || typeof value !== "number" || !Number.isFinite(value)) continue;
      metrics[key] = value;
    }
    return { secUserId: secUid, day, metrics, requestId: responseRequestId(result.body, result.response), responseHash: hashResponse(result.body) } satisfies TikHubAccountWorkAnalysis;
  }
}
