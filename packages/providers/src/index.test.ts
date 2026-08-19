import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AiSdkStructuredGenerator, ApiMartClient, ProviderRequestError, TikHubDouyinConnector } from "./index";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "x-request-id": "request-test" } });
}

describe("provider adapters", () => {
  it("normalizes APIMart model catalog and chat without leaking credentials", async () => {
    const calls: Array<{ url: string; body?: string }> = [];
    const client = new ApiMartClient({ apiKey: "secret-test-key", baseUrl: "https://api.example.test", fetcher: async (input, init) => {
      calls.push({ url: String(input), body: typeof init?.body === "string" ? init.body : undefined });
      if (String(input).includes("/v1/models")) return jsonResponse({ data: [{ id: "model-a", supported_endpoint_types: ["chat", "vision"] }] });
      return jsonResponse({ model: "model-a", choices: [{ message: { content: "{\"ok\":true}" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } });
    } });
    await expect(client.listModels()).resolves.toEqual([expect.objectContaining({ modelKey: "model-a", capabilities: ["chat", "vision"], capabilitySource: "declared" })]);
    const result = await client.chat({ modelKey: "model-a", messages: [{ role: "user", content: "只回复 JSON" }], responseFormat: { type: "json_object" }, maxTokens: 32 });
    expect(result).toMatchObject({ providerKey: "apimart", text: "{\"ok\":true}", usage: { totalTokens: 7 } });
    expect(JSON.stringify(calls)).not.toContain("secret-test-key");
    expect(calls[1].body).toContain("response_format");
  });

  it("turns APIMart auth/rate errors into the shared error contract", async () => {
    const client = new ApiMartClient({ apiKey: "secret-test-key", baseUrl: "https://api.example.test", fetcher: async () => jsonResponse({ error: { code: "invalid_api_key", message: "invalid key" } }, 401) });
    await expect(client.chat({ modelKey: "model-a", messages: [{ role: "user", content: "hello" }] })).rejects.toSatisfy((error: unknown) => error instanceof ProviderRequestError && error.normalized.category === "auth" && error.normalized.retryable === false);
  });

  it("submits and polls one bounded APIMart video task without exposing the key", async () => {
    const calls: Array<{ url: string; method?: string; body?: string }> = [];
    const client = new ApiMartClient({ apiKey: "secret-test-key", baseUrl: "https://api.example.test", fetcher: async (input, init) => {
      calls.push({ url: String(input), method: init?.method, body: typeof init?.body === "string" ? init.body : undefined });
      if (String(input).includes("/v1/videos/generations")) return jsonResponse({ code: 200, data: [{ status: "submitted", task_id: "task_video_1" }] });
      return jsonResponse({ code: 200, data: { id: "task_video_1", status: "completed", progress: 100, cost: 0.336, result: { videos: [{ url: ["https://cdn.example/generated.mp4"], expires_at: 1_800_000_000 }] }, actual_time: 42 } });
    } });
    const submission = await client.submitVideo({ prompt: "清晨门店外景，镜头缓慢推进" });
    expect(submission).toMatchObject({ providerKey: "apimart", providerTaskId: "task_video_1", state: "queued", providerState: "submitted" });
    await expect(client.pollMediaTask("task_video_1")).resolves.toMatchObject({ state: "succeeded", progress: 100, cost: 0.336, outputs: [{ kind: "video", url: "https://cdn.example/generated.mp4", expiresAt: "2027-01-15T08:00:00.000Z" }] });
    expect(JSON.parse(calls[0].body ?? "{}")).toEqual({ model: "kling-v3", prompt: "清晨门店外景，镜头缓慢推进", mode: "std", duration: 5, aspect_ratio: "9:16" });
    expect(calls[1].url).toBe("https://api.example.test/v1/tasks/task_video_1?language=zh");
    expect(calls.filter((call) => call.method === "POST" && call.url === "https://api.example.test/v1/videos/generations")).toHaveLength(1);
    expect(calls).toHaveLength(2);
    expect(JSON.stringify({ calls, submission })).not.toContain("secret-test-key");
  });

  it("normalizes APIMart media states and does not retry failed tasks", async () => {
    const states = new Map([
      ["submitted", "queued"],
      ["queueing", "queued"],
      ["in_progress", "processing"],
      ["success", "succeeded"],
      ["failed", "failed"],
      ["cancelled", "cancelled"],
    ] as const);
    let calls = 0;
    for (const [providerState, expected] of states) {
      const client = new ApiMartClient({ apiKey: "secret-test-key", baseUrl: "https://api.example.test", fetcher: async () => {
        calls += 1;
        return jsonResponse({ code: 200, data: {
          id: `task_${providerState}`,
          status: providerState,
          message: providerState === "failed" ? "provider rejected" : undefined,
          ...(providerState === "success" ? { result: { videos: [{ url: ["https://cdn.example/success.mp4"] }] } } : {}),
        } });
      } });
      await expect(client.pollMediaTask(`task_${providerState}`)).resolves.toMatchObject({ state: expected, ...(expected === "failed" ? { error: { code: "MEDIA_GENERATION_FAILED", retryable: false } } : {}) });
    }
    expect(calls).toBe(states.size);
  });

  it("rejects APIMart HTTP-200 business errors and unsafe media URLs", async () => {
    const businessError = new ApiMartClient({ apiKey: "secret-test-key", baseUrl: "https://api.example.test", fetcher: async () => jsonResponse({ code: 402, message: "insufficient balance" }) });
    await expect(businessError.submitVideo({ prompt: "fixture" })).rejects.toSatisfy((error: unknown) => error instanceof ProviderRequestError && error.normalized.category === "quota" && error.normalized.retryable === false);
    const unsafe = new ApiMartClient({ apiKey: "secret-test-key", baseUrl: "https://api.example.test", fetcher: async () => jsonResponse({ code: 200, data: { id: "task_unsafe", status: "completed", result: { videos: [{ url: "http://cdn.example/generated.mp4" }] } } }) });
    await expect(unsafe.pollMediaTask("task_unsafe")).rejects.toSatisfy((error: unknown) => error instanceof ProviderRequestError && error.normalized.code === "MEDIA_URL_UNSAFE");
  });

  it("infers video capability for APIMart catalog entries whose endpoint is only labeled openai", async () => {
    const client = new ApiMartClient({ apiKey: "secret-test-key", baseUrl: "https://api.example.test", fetcher: async () => jsonResponse({ data: [{ id: "kling-v3", supported_endpoint_types: ["openai"] }, { id: "gpt-5-nano", supported_endpoint_types: ["openai"] }] }) });
    await expect(client.listModels()).resolves.toEqual([
      expect.objectContaining({ modelKey: "kling-v3", capabilities: ["video_generation"] }),
      expect.objectContaining({ modelKey: "gpt-5-nano", capabilities: ["chat"] }),
    ]);
  });

  it("uses AI SDK structured output with one non-retried OpenAI-compatible request", async () => {
    const calls: Array<{ url: string; body?: string }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), body: typeof init?.body === "string" ? init.body : undefined });
      return jsonResponse({
        id: "response-ai-sdk",
        model: "model-structured",
        choices: [{ index: 0, message: { role: "assistant", content: "{\"answer\":\"ok\",\"score\":1}" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 8, completion_tokens: 5, total_tokens: 13 },
      });
    };
    const generator = new AiSdkStructuredGenerator({ apiKey: "secret-test-key", baseUrl: "https://api.example.test/v1", fetcher });
    const result = await generator.generate({
      modelKey: "model-structured",
      system: "只输出结构化结果。",
      prompt: "返回 ok。",
      schema: z.object({ answer: z.literal("ok"), score: z.number().int() }).strict(),
      name: "FixtureAnswer",
      maxOutputTokens: 64,
    });
    expect(result).toMatchObject({ output: { answer: "ok", score: 1 }, responseModelId: "model-structured", usage: { totalTokens: 13 } });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.example.test/v1/chat/completions");
    expect(calls[0].body).toContain("json_schema");
    expect(JSON.parse(calls[0].body ?? "{}")).toMatchObject({ stream: false });
    expect(JSON.stringify(result)).not.toContain("secret-test-key");
  });

  it("rejects invalid AI SDK structured output without retrying a billed request", async () => {
    let calls = 0;
    const fetcher: typeof fetch = async () => {
      calls += 1;
      return jsonResponse({ id: "response-invalid", model: "model-structured", choices: [{ index: 0, message: { role: "assistant", content: "{\"answer\":42}" }, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 } });
    };
    const generator = new AiSdkStructuredGenerator({ apiKey: "secret-test-key", baseUrl: "https://api.example.test/v1", fetcher });
    await expect(generator.generate({ modelKey: "model-structured", system: "fixture", prompt: "fixture", schema: z.object({ answer: z.string() }).strict(), name: "InvalidFixture" })).rejects.toThrow();
    expect(calls).toBe(1);
  });

  it("normalizes TikHub public profile and bounded post pagination", async () => {
    const urls: string[] = [];
    const connector = new TikHubDouyinConnector({ apiKey: "secret-test-key", baseUrl: "https://api.example.test", fetcher: async (input) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("get_sec_user_id")) return jsonResponse({ data: { sec_user_id: "MS4wLjABAAAAexample" } });
      if (url.includes("handler_user_profile")) return jsonResponse({ data: { nickname: "测试账号", follower_count: 1234 } });
      return jsonResponse({ data: { aweme_list: [{ aweme_id: "aweme-1", desc: "一个观点", create_time: 1_700_000_000, video: { duration: 2_500, cover: "https://cdn.example/cover.jpg" } }], has_more: true } });
    } });
    await expect(connector.resolveSecUserId("https://www.douyin.com/user/example")).resolves.toBe("MS4wLjABAAAAexample");
    await expect(connector.fetchProfile("MS4wLjABAAAAexample")).resolves.toMatchObject({ nickname: "测试账号", followerCount: 1234 });
    await expect(connector.fetchUserPosts({ secUserId: "MS4wLjABAAAAexample", count: 20 })).resolves.toMatchObject({ hasMore: true, items: [{ awemeId: "aweme-1", durationMs: 2500 }] });
    expect(urls.some((url) => url.includes("count=20"))).toBe(true);
    await expect(connector.fetchUserPosts({ secUserId: "MS4wLjABAAAAexample", count: 21 })).rejects.toThrow("1–20");
  });

  it("normalizes the current nested App V3 profile response", async () => {
    const connector = new TikHubDouyinConnector({ apiKey: "secret-test-key", baseUrl: "https://api.example.test", fetcher: async () => jsonResponse({ data: { user: { nickname: "嵌套账号", signature: "一个签名", follower_count: 456, following_count: 12, aweme_count: 8 } } }) });
    await expect(connector.fetchProfile("MS4wLjABAAAAnested")).resolves.toMatchObject({ nickname: "嵌套账号", signature: "一个签名", followerCount: 456, followingCount: 12, awemeCount: 8 });
  });

  it("reads dynamic TikHub endpoint pricing before a discovery request", async () => {
    const connector = new TikHubDouyinConnector({ apiKey: "secret-test-key", baseUrl: "https://api.example.test", fetcher: async (input) => {
      expect(String(input)).toContain("get_endpoint_info");
      return jsonResponse({ data: { endpoint_uri: "/api/v1/douyin/billboard/fetch_hot_total_low_fan_list", endpoint_cost: 0.001, allow_free_credit: true, allow_discount: true, rate_limit: "10/second", endpoint_type: "self-operated" } });
    } });
    await expect(connector.getEndpointInfo("/api/v1/douyin/billboard/fetch_hot_total_low_fan_list")).resolves.toEqual({ endpoint: "/api/v1/douyin/billboard/fetch_hot_total_low_fan_list", costUsd: 0.001, allowFreeCredit: true, allowDiscount: true, rateLimit: "10/second", endpointType: "self-operated" });
    await expect(connector.getEndpointInfo("https://unsafe.example/path")).rejects.toThrow();
  });

  it("normalizes bounded low-fan and search-hot discovery evidence", async () => {
    const bodies: string[] = [];
    const connector = new TikHubDouyinConnector({ apiKey: "secret-test-key", baseUrl: "https://api.example.test", fetcher: async (input, init) => {
      bodies.push(typeof init?.body === "string" ? init.body : "");
      if (String(input).includes("low_fan")) return jsonResponse({ data: { code: 200, data: { page: { page: 1, page_size: 2, total: 9 }, objs: [{ item_id: "aweme-1", item_title: "一个反常识观点", fans_cnt: 800, play_cnt: 120_000, publish_time: 1_700_000_000, score: 98, like_rate: 0.12 }] }, extra: { now: 1 }, message: "ok" } });
      return jsonResponse({ data: { code: 200, data: { page_num: 1, page_size: 2, total_count: 8, search_list: [{ key_word: "深度口播", search_score: 88, trends: [{ date: "20260814", value: 42 }] }] }, extra: { now: 1 }, message: "ok" } });
    } });
    await expect(connector.fetchBillboardPosts({ kind: "low_fan", pageSize: 2, dateWindow: 24 })).resolves.toMatchObject({ kind: "low_fan", total: 9, items: [{ awemeId: "aweme-1", followerCount: 800, playCount: 120_000, likeRate: 0.12 }] });
    await expect(connector.fetchSearchHotList({ pageSize: 2, dateWindow: 24 })).resolves.toMatchObject({ total: 8, items: [{ keyword: "深度口播", score: 88, trends: [{ date: "20260814", value: 42 }] }] });
    expect(bodies.every((body) => JSON.parse(body).page_size === 2)).toBe(true);
    await expect(connector.fetchBillboardPosts({ kind: "low_fan", pageSize: 21 })).rejects.toThrow();
  });

  it("rejects TikHub business errors even when HTTP status is 200", async () => {
    const connector = new TikHubDouyinConnector({ apiKey: "secret-test-key", baseUrl: "https://api.example.test", fetcher: async () => jsonResponse({ code: 429, message: "too many requests" }) });
    await expect(connector.fetchSearchHotList({ pageSize: 2 })).rejects.toSatisfy((error: unknown) => error instanceof ProviderRequestError && error.normalized.category === "rate_limit" && error.normalized.retryable === true);
  });

  it("only accepts HTTPS high-quality media URLs", async () => {
    const connector = new TikHubDouyinConnector({ apiKey: "secret-test-key", baseUrl: "https://api.example.test", fetcher: async () => jsonResponse({ data: { original_video_url: "https://cdn.example/video.mp4" } }) });
    await expect(connector.fetchHighestQualityPlayUrl({ awemeId: "aweme-1", region: "CN" })).resolves.toMatchObject({ awemeId: "aweme-1", url: "https://cdn.example/video.mp4" });
    const unsafe = new TikHubDouyinConnector({ apiKey: "secret-test-key", baseUrl: "https://api.example.test", fetcher: async () => jsonResponse({ data: { original_video_url: "http://cdn.example/video.mp4" } }) });
    await expect(unsafe.fetchHighestQualityPlayUrl({ awemeId: "aweme-1" })).rejects.toSatisfy((error: unknown) => error instanceof ProviderRequestError && error.normalized.code === "VIDEO_URL_UNSAFE");
  });

  it("normalizes the bounded batch video statistics endpoint", async () => {
    const urls: string[] = [];
    const connector = new TikHubDouyinConnector({ apiKey: "secret-test-key", baseUrl: "https://api.example.test", fetcher: async (input) => {
      urls.push(String(input));
      return jsonResponse({ data: { items: [
        { aweme_id: "aweme-1", statistics: { digg_count: 12, play_count: 345, download_count: 4, share_count: 5, ignored: "x" } },
        { aweme_id: "aweme-2", digg_count: 6, play_count: 78 },
      ] } });
    } });
    await expect(connector.fetchVideoStatistics?.(["aweme-1", "aweme-2"])).resolves.toMatchObject([
      { awemeId: "aweme-1", statistics: { digg_count: 12, play_count: 345, download_count: 4, share_count: 5 } },
      { awemeId: "aweme-2", statistics: { digg_count: 6, play_count: 78 } },
    ]);
    expect(urls[0]).toContain("fetch_multi_video_statistics");
    expect(urls[0]).toContain("aweme_ids=aweme-1%2Caweme-2");
    await expect(connector.fetchVideoStatistics?.([])).rejects.toThrow();
    await expect(connector.fetchVideoStatistics?.(Array.from({ length: 51 }, (_, index) => `aweme-${index}`))).rejects.toThrow();
  });

  it("normalizes the bounded account work analysis endpoint", async () => {
    const urls: string[] = [];
    const connector = new TikHubDouyinConnector({ apiKey: "secret-test-key", baseUrl: "https://api.example.test", fetcher: async (input) => {
      urls.push(String(input));
      return jsonResponse({ code: 200, data: { code: 200, data: { UserID: "MS4wLjABAAAAfixture", avg_like_count: 12.5, avg_comment_count: 3, percentile_like_count: 0.8, BaseResp: { status_code: 0 } } } });
    } });
    await expect(connector.fetchAccountWorkAnalysis?.({ secUserId: "MS4wLjABAAAAfixture" })).resolves.toMatchObject({ secUserId: "MS4wLjABAAAAfixture", day: 7, metrics: { avg_like_count: 12.5, avg_comment_count: 3, percentile_like_count: 0.8 } });
    expect(urls[0]).toContain("fetch_hot_account_item_analysis_list");
    expect(urls[0]).toContain("sec_uid=MS4wLjABAAAAfixture");
    expect(urls[0]).toContain("day=7");
    await expect(connector.fetchAccountWorkAnalysis?.({ secUserId: "MS4wLjABAAAAfixture", day: 31 })).rejects.toThrow();
  });
});
