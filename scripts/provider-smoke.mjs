const liveEnabled = process.env.PROVIDER_LIVE_TESTS === "1";
const billedEnabled = process.env.PROVIDER_BILLED_SMOKE === "1";
const discoveryEnabled = process.env.PROVIDER_DISCOVERY_SMOKE === "1";

if (!liveEnabled) {
  console.log("Provider smoke skipped. Set PROVIDER_LIVE_TESTS=1 to run the bounded live checks.");
  process.exit(0);
}

const requireEnvironment = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
};

const fetchJson = async (url, init = {}) => {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
  const body = await response.json();
  return { response, body };
};

const bearer = (key) => ({ Authorization: `Bearer ${key}` });

async function testTikHub() {
  const baseUrl = requireEnvironment("TIKHUB_BASE_URL");
  const key = requireEnvironment("TIKHUB_API_KEY");
  const health = await fetchJson(`${baseUrl}/api/v1/health/check`);
  console.log(JSON.stringify({ provider: "tikhub", check: "health", httpStatus: health.response.status, ok: health.body.status === "ok" }));

  const account = await fetchJson(`${baseUrl}/api/v1/tikhub/user/get_user_info`, { headers: bearer(key) });
  console.log(JSON.stringify({
    provider: "tikhub",
    check: "credential",
    httpStatus: account.response.status,
    code: account.body.code ?? null,
    hasApiKeyData: Boolean(account.body.api_key_data),
    hasUserData: Boolean(account.body.user_data),
  }));

  const endpointInfoUrl = new URL(`${baseUrl}/api/v1/tikhub/user/get_endpoint_info`);
  endpointInfoUrl.searchParams.set("endpoint", "/api/v1/douyin/billboard/fetch_hot_total_low_fan_list");
  const endpointInfo = await fetchJson(endpointInfoUrl);
  console.log(JSON.stringify({
    provider: "tikhub",
    check: "low_fan_dynamic_price",
    httpStatus: endpointInfo.response.status,
    costUsd: typeof endpointInfo.body.data?.endpoint_cost === "number" ? endpointInfo.body.data.endpoint_cost : null,
    rateLimit: endpointInfo.body.data?.rate_limit ?? null,
  }));

  if (discoveryEnabled) {
    const discovery = await fetchJson(`${baseUrl}/api/v1/douyin/billboard/fetch_hot_total_low_fan_list`, {
      method: "POST",
      headers: { ...bearer(key), "Content-Type": "application/json" },
      body: JSON.stringify({ page: 1, page_size: 2, date_window: 24, keyword: "", tags: [] }),
    });
    const items = discovery.body.data?.data?.objs;
    console.log(JSON.stringify({ provider: "tikhub", check: "low_fan_two_items", httpStatus: discovery.response.status, code: discovery.body.code ?? null, itemCount: Array.isArray(items) ? items.length : 0, requestIdPresent: Boolean(discovery.body.request_id) }));
  }

  if (!billedEnabled) return;
  const profileUrl = new URL(`${baseUrl}/api/v1/douyin/app/v3/handler_user_profile`);
  profileUrl.searchParams.set("sec_user_id", process.env.TIKHUB_SMOKE_SEC_USER_ID ?? "MS4wLjABAAAAW9FWcqS7RdQAWPd2AA5fL_ilmqsIFUCQ_Iym6Yh9_cUa6ZRqVLjVQSUjlHrfXY1Y");
  const profile = await fetchJson(profileUrl, { headers: bearer(key) });
  console.log(JSON.stringify({
    provider: "tikhub",
    check: "sample_profile",
    httpStatus: profile.response.status,
    code: profile.body.code ?? null,
    hasData: Boolean(profile.body.data),
    requestIdPresent: Boolean(profile.body.request_id),
  }));
}

async function testApiMart() {
  const baseUrl = requireEnvironment("APIMART_BASE_URL");
  const key = requireEnvironment("APIMART_API_KEY");
  const models = await fetchJson(`${baseUrl}/v1/models?expand=true`, { headers: bearer(key) });
  const items = Array.isArray(models.body.data) ? models.body.data : Array.isArray(models.body.models) ? models.body.models : [];
  console.log(JSON.stringify({
    provider: "apimart",
    check: "models_expand",
    httpStatus: models.response.status,
    modelCount: items.length,
    firstItemKeys: items[0] ? Object.keys(items[0]).sort() : [],
  }));

  if (!billedEnabled) return;
  const chat = await fetchJson(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { ...bearer(key), "Content-Type": "application/json" },
    body: JSON.stringify({
      model: process.env.APIMART_SMOKE_MODEL ?? "gpt-5-nano",
      stream: false,
      max_tokens: 128,
      reasoning_effort: "minimal",
      messages: [{ role: "user", content: "只回复 OK" }],
    }),
  });
  const payload = chat.body.data ?? chat.body;
  const text = payload.choices?.[0]?.message?.content;
  console.log(JSON.stringify({
    provider: "apimart",
    check: "minimal_chat",
    httpStatus: chat.response.status,
    code: chat.body.code ?? null,
    model: payload.model ?? null,
    textLength: typeof text === "string" ? text.length : 0,
    usagePresent: Boolean(payload.usage),
    finishReason: payload.choices?.[0]?.finish_reason ?? null,
    errorType: chat.body.error?.type ?? null,
  }));
}

try {
  if (process.env.TIKHUB_API_KEY) await testTikHub();
  else console.log(JSON.stringify({ provider: "tikhub", check: "configuration", skipped: true, reason: "TIKHUB_API_KEY 未配置" }));
  if (process.env.APIMART_API_KEY) await testApiMart();
  else console.log(JSON.stringify({ provider: "apimart", check: "configuration", skipped: true, reason: "APIMART_API_KEY 未配置" }));
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.name : "UnknownError", message: error instanceof Error ? error.message : "Provider smoke failed" }));
  process.exitCode = 1;
}
