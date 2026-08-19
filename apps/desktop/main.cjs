const { app, BrowserWindow, dialog, ipcMain, net, shell, utilityProcess } = require("electron");
const { createHash, randomUUID } = require("node:crypto");
const { existsSync, mkdirSync, mkdtempSync, realpathSync } = require("node:fs");
const { mkdir: makeDirectory, readFile, rename, rm: removeFile, stat: statFile, writeFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { createShotGenerationService } = require("./shot-generation-service.cjs");

const isDevelopment = !app.isPackaged && !process.argv.includes("--load-dist");
let selectedWorkspacePath = null;
let desktopRuntimePromise = null;
let catalog = null;
let workspaceId = null;
const pendingTopicRadarQuotes = new Map();
const pendingAccountMetricsQuotes = new Map();
const pendingAccountAnalysisQuotes = new Map();
const activeAnalysisWorkers = new Map();
const shotGenerationService = createShotGenerationService({
  getRuntime: getDesktopRuntime,
  requireWorkspace,
  getApiKey: () => process.env.APIMART_API_KEY,
  getProviderKey: () => process.env.MEDIA_GENERATION_PROVIDER ?? "apimart",
  getBaseUrl: () => process.env.APIMART_BASE_URL ?? "https://api.apimart.ai",
  fetcher: (input, init) => net.fetch(String(input), init),
});

function localAnalysisSettingsPath() {
  return path.join(app.getPath("userData"), "local-analysis-settings.json");
}

function desktopSidecarPath(fileName) {
  const candidates = [
    path.join(process.resourcesPath, "app.asar.unpacked", "apps", "desktop", "sidecars", fileName),
    path.join(__dirname, "sidecars", fileName),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

function portableAbsolutePath(value) {
  return typeof value === "string" && (value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\")) ? value : undefined;
}

function boundedAnalysisInterval(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 250 && parsed <= 30_000 ? parsed : 1_000;
}

function defaultEnvironmentAnalysisSettings(runtime) {
  const whisperModelPath = portableAbsolutePath(process.env.WHISPER_MODEL_PATH);
  const fasterWhisperModelPath = portableAbsolutePath(process.env.FASTER_WHISPER_MODEL);
  const fasterWhisperPythonPath = portableAbsolutePath(process.env.FASTER_WHISPER_PYTHON);
  const fasterWhisperScriptPath = portableAbsolutePath(process.env.FASTER_WHISPER_SCRIPT) ?? desktopSidecarPath("faster-whisper-sidecar.py");
  const visionScriptPath = process.env.APPLE_VISION_OCR_SCRIPT === "" ? undefined : portableAbsolutePath(process.env.APPLE_VISION_OCR_SCRIPT) ?? desktopSidecarPath("apple-vision-ocr.swift");
  const asr = whisperModelPath
    ? { engine: "whisper.cpp", modelPath: whisperModelPath, binaryPath: portableAbsolutePath(process.env.WHISPER_BINARY_PATH), language: process.env.ASR_LANGUAGE ?? "zh", device: "cpu", computeType: "int8" }
    : fasterWhisperModelPath && fasterWhisperPythonPath
      ? { engine: "faster-whisper", modelPath: fasterWhisperModelPath, pythonPath: fasterWhisperPythonPath, scriptPath: fasterWhisperScriptPath, language: process.env.ASR_LANGUAGE ?? "zh", device: process.env.FASTER_WHISPER_DEVICE ?? "cpu", computeType: process.env.FASTER_WHISPER_COMPUTE_TYPE ?? "int8" }
      : { engine: "disabled", language: process.env.ASR_LANGUAGE ?? "zh", device: "cpu", computeType: "int8" };
  const ocr = process.platform === "darwin" && visionScriptPath
    ? { engine: "apple-vision", scriptPath: visionScriptPath, binaryPath: portableAbsolutePath(process.env.APPLE_VISION_OCR_BINARY), sampleIntervalMs: boundedAnalysisInterval(process.env.APPLE_VISION_OCR_INTERVAL_MS ?? 1_000) }
    : { engine: "disabled", sampleIntervalMs: 1_000 };
  return runtime.analysis.LocalAnalysisSettingsSchema.parse({ schemaVersion: 1, asr, ocr, updatedAt: new Date().toISOString() });
}

function validateLocalAnalysisPaths(settings) {
  const paths = [
    ["ASR 模型", settings.asr.modelPath],
    ["ASR 二进制", settings.asr.binaryPath],
    ["ASR Python", settings.asr.pythonPath],
    ["ASR sidecar", settings.asr.scriptPath],
    ["OCR sidecar", settings.ocr.scriptPath],
    ["OCR 二进制", settings.ocr.binaryPath],
  ];
  for (const [label, value] of paths) {
    if (value === undefined) continue;
    if (!path.isAbsolute(value) || value.includes("\0")) throw new Error(`${label}必须是绝对路径`);
  }
}

async function readLocalAnalysisSettings(runtime) {
  const filePath = localAnalysisSettingsPath();
  if (!existsSync(filePath)) return { settings: defaultEnvironmentAnalysisSettings(runtime), source: "environment" };
  try {
    const parsed = runtime.analysis.parseLocalAnalysisSettings(JSON.parse(await readFile(filePath, "utf8")));
    validateLocalAnalysisPaths(parsed);
    return { settings: parsed, source: "saved" };
  } catch (error) {
    return { settings: defaultEnvironmentAnalysisSettings(runtime), source: "environment", warning: error instanceof Error ? `已忽略损坏的本地分析设置：${error.message}` : "已忽略损坏的本地分析设置" };
  }
}

async function saveLocalAnalysisSettings(runtime, input) {
  const settings = runtime.analysis.parseLocalAnalysisSettings(input);
  validateLocalAnalysisPaths(settings);
  const filePath = localAnalysisSettingsPath();
  const directory = path.dirname(filePath);
  await makeDirectory(directory, { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, filePath);
  } finally {
    await removeFile(temporaryPath, { force: true }).catch(() => undefined);
  }
  return settings;
}

function pathState(label, value, options = {}) {
  const errors = [];
  if (!value) errors.push(`${label}未配置`);
  else if (!existsSync(value)) errors.push(`${label}不存在`);
  else {
    try {
      const info = require("node:fs").statSync(value);
      if (options.directory && !info.isDirectory()) errors.push(`${label}不是目录`);
      if (!options.directory && !info.isFile()) errors.push(`${label}不是文件`);
    } catch (error) {
      errors.push(`${label}不可读取`);
    }
  }
  return errors;
}

function localAnalysisCapabilities(runtime, settings) {
  const asrErrors = settings.asr.engine === "disabled" ? [] : settings.asr.engine === "whisper.cpp"
    ? [...pathState("ASR 模型", settings.asr.modelPath), ...(settings.asr.binaryPath ? pathState("ASR 二进制", settings.asr.binaryPath) : [])]
    : [...pathState("ASR 模型目录", settings.asr.modelPath, { directory: true }), ...pathState("Python", settings.asr.pythonPath), ...pathState("ASR sidecar", settings.asr.scriptPath)];
  const ocrErrors = settings.ocr.engine === "disabled" ? [] : process.platform !== "darwin"
    ? ["Apple Vision OCR 仅支持 macOS"]
    : [...pathState("OCR sidecar", settings.ocr.scriptPath), ...(settings.ocr.binaryPath ? pathState("OCR 二进制", settings.ocr.binaryPath) : [])];
  return {
    asr: { engine: settings.asr.engine, configured: settings.asr.engine !== "disabled", ready: settings.asr.engine !== "disabled" && asrErrors.length === 0, label: settings.asr.engine === "disabled" ? "未启用" : settings.asr.engine === "whisper.cpp" ? "whisper.cpp" : "faster-whisper", pathLabel: settings.asr.modelPath ? path.basename(settings.asr.modelPath) : undefined, errors: asrErrors },
    ocr: { engine: settings.ocr.engine, configured: settings.ocr.engine !== "disabled", ready: settings.ocr.engine !== "disabled" && ocrErrors.length === 0, label: settings.ocr.engine === "disabled" ? "未启用" : "Apple Vision", pathLabel: settings.ocr.scriptPath ? path.basename(settings.ocr.scriptPath) : undefined, errors: ocrErrors },
    sceneDetection: { ready: true, label: "FFmpeg 镜头检测" },
  };
}

async function activeAnalysisWorkerSettings(runtime) {
  const loaded = await readLocalAnalysisSettings(runtime);
  return { ...runtime.analysis.workerAnalysisSettings(loaded.settings), source: loaded.source, warning: loaded.warning };
}

function analysisConfigFingerprint(config) {
  const { source: _source, warning: _warning, ...workerConfig } = config;
  const runtimeSnapshot = Object.fromEntries(Object.entries(workerConfig).map(([key, value]) => {
    if (typeof value !== "string" || !/(Path|Script|Binary|Model|Python)/i.test(key)) return [key, value];
    try {
      const stat = require("node:fs").statSync(value);
      return [key, { value, size: stat.size, mtimeMs: stat.mtimeMs, isDirectory: stat.isDirectory() }];
    } catch {
      return [key, { value, missing: true }];
    }
  }));
  return createHash("sha256").update(JSON.stringify({ pipeline: "analysis-v2", runtimeSnapshot })).digest("hex").slice(0, 16);
}

function latestAnalysisRunId(workspace, artifactId) {
  const job = workspace.catalog.listJobsForWorkspace(workspace.workspaceId, "media.analysis")
    .filter((job) => job.state === "succeeded" && job.artifactIds.includes(artifactId))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id))[0];
  if (!job) return undefined;
  return job.checkpoint && typeof job.checkpoint === "object" && typeof job.checkpoint.analysisRunId === "string" ? job.checkpoint.analysisRunId : job.id;
}

function searchCurrentAnalysisFacts(workspace, input) {
  const runId = input.artifactId ? latestAnalysisRunId(workspace, input.artifactId) : undefined;
  if (runId) {
    const current = workspace.catalog.searchAnalysisFacts({ ...input, analysisRunId: runId });
    if (current.length > 0) return current;
    const hasCurrentFacts = workspace.catalog.searchAnalysisFacts({ workspaceId: workspace.workspaceId, artifactId: input.artifactId, analysisRunId: runId, limit: 1 }).length > 0;
    if (hasCurrentFacts) return [];
  }
  return workspace.catalog.searchAnalysisFacts(input);
}

async function getDesktopRuntime() {
  if (!desktopRuntimePromise) {
    const runtimeRoot = path.join(__dirname, "..", "..", "dist-electron", "packages");
    desktopRuntimePromise = Promise.all([
      import(pathToFileURL(path.join(runtimeRoot, "media", "src", "index.js")).href),
      import(pathToFileURL(path.join(runtimeRoot, "analysis", "src", "index.js")).href),
      import(pathToFileURL(path.join(runtimeRoot, "creation", "src", "index.js")).href),
      import(pathToFileURL(path.join(runtimeRoot, "exchange", "src", "index.js")).href),
      import(pathToFileURL(path.join(runtimeRoot, "storage", "src", "catalog.js")).href),
      import(pathToFileURL(path.join(runtimeRoot, "providers", "src", "index.js")).href),
      import(pathToFileURL(path.join(runtimeRoot, "agent-runtime", "src", "index.js")).href),
      import(pathToFileURL(path.join(runtimeRoot, "research", "src", "index.js")).href),
      import(pathToFileURL(path.join(runtimeRoot, "publishing", "src", "index.js")).href),
      import(pathToFileURL(path.join(runtimeRoot, "domain", "src", "index.js")).href),
    ]).then(([media, analysis, creation, exchange, storage, providers, agentRuntime, research, publishing, domain]) => ({ media, analysis, creation, exchange, storage, providers, agentRuntime, research, publishing, domain, mediaImporter: new media.LocalMediaImporter() }));
  }
  return desktopRuntimePromise;
}

function workspaceIdForPath(workspacePath) {
  return `workspace-${createHash("sha256").update(workspacePath).digest("hex").slice(0, 20)}`;
}

async function initializeWorkspace(workspacePath) {
  const runtime = await getDesktopRuntime();
  const canonicalWorkspacePath = realpathSync(workspacePath);
  const metadataDirectory = path.join(canonicalWorkspacePath, ".creator-copilot");
  mkdirSync(metadataDirectory, { recursive: true });
  const nextCatalog = new runtime.storage.SqliteCatalog(path.join(metadataDirectory, "catalog.sqlite"));
  const nextWorkspaceId = workspaceIdForPath(canonicalWorkspacePath);
  try {
    // A previous Electron process may have died while a local media/render job
    // or outbox message held a lease. Recover only expired leases; an active
    // lease remains fenced until its owner times out.
    nextCatalog.recoverExpiredLeases(new Date());
    nextCatalog.recoverExpiredOutboxClaims(new Date());
    if (!nextCatalog.getWorkspace(nextWorkspaceId)) {
      const now = new Date().toISOString();
      nextCatalog.createWorkspace({ id: nextWorkspaceId, name: path.basename(canonicalWorkspacePath), rootPath: canonicalWorkspacePath, schemaVersion: 1, defaultLocale: "zh-CN", createdAt: now, updatedAt: now });
    }
  } catch (error) {
    nextCatalog.close();
    throw error;
  }
  if (catalog) catalog.close();
  catalog = nextCatalog;
  workspaceId = nextWorkspaceId;
  selectedWorkspacePath = canonicalWorkspacePath;
  pendingTopicRadarQuotes.clear();
  pendingAccountMetricsQuotes.clear();
  pendingAccountAnalysisQuotes.clear();
  shotGenerationService.clearQuotes();
  return canonicalWorkspacePath;
}

function requireWorkspace() {
  if (!selectedWorkspacePath || !catalog || !workspaceId) throw new Error("请先选择工作区");
  return { workspacePath: selectedWorkspacePath, catalog, workspaceId };
}

function buildAssetCandidateSuggestions({ workspace, runtime, script, storyboard, tasks }) {
  const taskByShot = new Map(tasks.map((task) => [task.shotId, task]));
  const durationByAssetId = new Map();
  for (const task of tasks) {
    for (const take of workspace.catalog.listTakes(task.id)) {
      if (typeof take.durationMs === "number" && take.durationMs > 0) durationByAssetId.set(take.assetId, take.durationMs);
    }
  }
  const sourceAssets = workspace.catalog.listArtifacts(workspace.workspaceId)
    .filter((artifact) => artifact.kind === "source" && artifact.mimeType.startsWith("video/"))
    .map((artifact) => ({
      assetId: artifact.artifactId,
      relativePath: artifact.relativePath,
      contentHash: artifact.contentHash,
      durationMs: durationByAssetId.get(artifact.artifactId),
      facts: searchCurrentAnalysisFacts(workspace, { workspaceId: workspace.workspaceId, artifactId: artifact.artifactId, limit: 100 }).map((fact) => ({ id: fact.id, kind: fact.kind, startMs: fact.startMs, endMs: fact.endMs, text: fact.text, labels: fact.labels })),
    }));
  const queries = storyboard.shots.map((shot) => {
    const task = taskByShot.get(shot.id);
    const scriptText = script.blocks.filter((block) => shot.scriptBlockIds.includes(block.id)).sort((left, right) => left.order - right.order).map((block) => block.text).join(" ");
    return { shotId: shot.id, instruction: task?.instruction ?? shot.actionDescription, scriptText, mode: shot.mode, framing: shot.framing, targetMs: shot.targetMs };
  });
  return runtime.analysis.rankAssetCandidates({ queries, assets: sourceAssets, limitPerShot: 5 });
}

function topicIdForOpportunity(source, reportId, opportunityId) {
  return `topic-${createHash("sha256").update(`${source}:${reportId}:${opportunityId}`).digest("hex").slice(0, 24)}`;
}

function buildTopicFromOpportunity({ workspace, runtime, source, reportId, opportunityId }) {
  const now = new Date().toISOString();
  const id = topicIdForOpportunity(source, reportId, opportunityId);
  if (source === "account_research") {
    const report = workspace.catalog.getResearchReport(reportId);
    if (!report || report.workspaceId !== workspace.workspaceId) throw new Error("账号研究报告不存在或不属于当前工作区");
    const opportunity = report.opportunities.find((candidate) => candidate.id === opportunityId);
    if (!opportunity) throw new Error("账号研究机会不存在");
    const evidenceIds = opportunity.evidenceIds.filter((evidenceId) => report.evidence.some((evidence) => evidence.id === evidenceId));
    if (evidenceIds.length !== opportunity.evidenceIds.length) throw new Error("账号研究机会引用了不存在的证据");
    return runtime.domain.createTopic({
      id,
      workspaceId: workspace.workspaceId,
      title: opportunity.title,
      audienceProblem: "对标样本暴露了一个值得验证的观众问题；需要结合你的受众重新确认。",
      thesis: opportunity.angle,
      angle: opportunity.angle,
      evidenceIds,
      benchmarkVideoIds: opportunity.sourceVideoIds,
      visualOpportunities: ["参考已拆解作品的镜头事实，再用自己的素材证明观点。"],
      riskNotes: [opportunity.whyNow],
      source: { kind: source, reportId, opportunityId },
      createdAt: now,
      updatedAt: now,
    });
  }
  const report = workspace.catalog.getTopicRadarReport(reportId);
  if (!report || report.workspaceId !== workspace.workspaceId) throw new Error("选题雷达报告不存在或不属于当前工作区");
  const opportunity = report.opportunities.find((candidate) => candidate.id === opportunityId);
  if (!opportunity) throw new Error("选题雷达机会不存在");
  const signalIds = new Set(report.signals.map((signal) => signal.id));
  const evidenceIds = opportunity.evidenceIds.filter((evidenceId) => signalIds.has(evidenceId));
  if (evidenceIds.length !== opportunity.evidenceIds.length) throw new Error("选题雷达机会引用了不存在的信号");
  return runtime.domain.createTopic({
    id,
    workspaceId: workspace.workspaceId,
    title: opportunity.title,
    audienceProblem: `平台信号显示用户正在关注“${opportunity.title.replace(/^搜索机会：/, "")}”，但是否适合你的账号仍需验证。`,
    thesis: opportunity.angle,
    angle: opportunity.angle,
    evidenceIds,
    benchmarkVideoIds: [],
    visualOpportunities: ["先把热词转成你有真实经验的具体场景，再决定是否需要补拍。"],
    riskNotes: [opportunity.whyNow],
    source: { kind: source, reportId, opportunityId },
    createdAt: now,
    updatedAt: now,
  });
}

function buildTopicScriptContext({ workspace, topic }) {
  const report = topic.source.kind === "account_research"
    ? workspace.catalog.getResearchReport(topic.source.reportId)
    : workspace.catalog.getTopicRadarReport(topic.source.reportId);
  if (!report || report.workspaceId !== workspace.workspaceId) throw new Error("选题来源报告不存在或不属于当前工作区");
  const evidenceById = new Map(topic.source.kind === "account_research"
    ? report.evidence.map((evidence) => [evidence.id, { id: evidence.id, text: [evidence.label, typeof evidence.payload.description === "string" ? evidence.payload.description : typeof evidence.payload.summary === "string" ? evidence.payload.summary : ""].filter(Boolean).join("："), source: `${evidence.type}:${evidence.sourceId}` }])
    : report.signals.map((signal) => [signal.id, { id: signal.id, text: `${signal.label}：${signal.detail}`, source: `tikhub:${signal.source}` }]));
  const sourceEvidence = topic.evidenceIds.flatMap((evidenceId) => {
    const evidence = evidenceById.get(evidenceId);
    return evidence && evidence.text ? [evidence] : [];
  });
  if (sourceEvidence.length !== topic.evidenceIds.length) throw new Error("选题引用的证据在来源报告中不存在");
  return {
    topicContext: {
      topicId: topic.id,
      topicRevision: topic.revision,
      title: topic.title,
      audienceProblem: topic.audienceProblem,
      thesis: topic.thesis,
      angle: topic.angle,
      evidenceIds: topic.evidenceIds,
      benchmarkVideoIds: topic.benchmarkVideoIds,
      visualOpportunities: topic.visualOpportunities,
      riskNotes: topic.riskNotes,
      source: topic.source,
    },
    sourceEvidence,
  };
}

function getEditAgent(runtime) {
  const providerKey = process.env.AI_EDIT_PROVIDER ?? "local-fallback";
  if (providerKey === "apimart" && process.env.APIMART_API_KEY) {
    const modelKey = process.env.AI_EDIT_MODEL ?? "gpt-5-nano";
    const adapter = process.env.AI_EDIT_ADAPTER ?? "ai-sdk";
    if (adapter === "ai-sdk" || adapter === "mastra") {
      const configuredBaseUrl = process.env.APIMART_BASE_URL ?? "https://api.apimart.ai";
      const baseUrl = configuredBaseUrl.replace(/\/+$/, "").endsWith("/v1") ? configuredBaseUrl : `${configuredBaseUrl.replace(/\/+$/, "")}/v1`;
      if (adapter === "mastra") {
        const model = runtime.providers.createAiSdkCompatibleLanguageModel({ apiKey: process.env.APIMART_API_KEY, baseUrl, providerKey: "apimart", modelKey });
        return runtime.agentRuntime.createMastraEditAgentRuntime({ model, providerKey: "apimart", modelKey });
      }
      const generator = new runtime.providers.AiSdkStructuredGenerator({ apiKey: process.env.APIMART_API_KEY, baseUrl });
      return new runtime.agentRuntime.AiSdkEditAgentRuntime(generator, modelKey);
    }
    const provider = new runtime.providers.ApiMartClient({ apiKey: process.env.APIMART_API_KEY, baseUrl: process.env.APIMART_BASE_URL ?? "https://api.apimart.ai" });
    return new runtime.agentRuntime.ProviderEditAgentRuntime(provider, modelKey);
  }
  return new runtime.agentRuntime.LocalEditAgentRuntime();
}

function getScriptAgent(runtime) {
  const providerKey = process.env.AI_EDIT_PROVIDER ?? "local-fallback";
  if (providerKey === "apimart" && process.env.APIMART_API_KEY) {
    const modelKey = process.env.AI_SCRIPT_MODEL ?? "gpt-4.1-mini";
    const configuredBaseUrl = process.env.APIMART_BASE_URL ?? "https://api.apimart.ai";
    const baseUrl = configuredBaseUrl.replace(/\/+$/, "").endsWith("/v1") ? configuredBaseUrl : `${configuredBaseUrl.replace(/\/+$/, "")}/v1`;
    const generator = new runtime.providers.AiSdkStructuredGenerator({ apiKey: process.env.APIMART_API_KEY, baseUrl });
    return new runtime.agentRuntime.AiSdkScriptAgentRuntime(generator, modelKey);
  }
  return new runtime.agentRuntime.LocalScriptAgentRuntime();
}

function getTikHubConnector(runtime) {
  if (!process.env.TIKHUB_API_KEY) throw new Error("TikHub API key 未配置");
  return new runtime.providers.TikHubDouyinConnector({ apiKey: process.env.TIKHUB_API_KEY, baseUrl: process.env.TIKHUB_BASE_URL ?? "https://api.tikhub.dev" });
}

function topicRadarEndpointFor(runtime, source) {
  const endpoint = runtime.research.TOPIC_RADAR_ENDPOINTS?.[source];
  if (!endpoint) throw new Error(`不支持的选题雷达来源：${source}`);
  return endpoint;
}

function topicRadarJobError(error) {
  const normalized = error && typeof error === "object" && "normalized" in error ? error.normalized : undefined;
  const category = normalized && typeof normalized === "object" && "category" in normalized ? normalized.category : undefined;
  const code = normalized && typeof normalized === "object" && "code" in normalized ? String(normalized.code) : "TOPIC_RADAR_FAILED";
  const message = normalized && typeof normalized === "object" && "message" in normalized ? String(normalized.message) : error instanceof Error ? error.message : "选题雷达请求失败";
  const retryable = normalized && typeof normalized === "object" && "retryable" in normalized ? Boolean(normalized.retryable) : true;
  return { code, message: message.slice(0, 500), retryable, submissionUnknown: category === "network" || category === "timeout" };
}

function configuredEditProvider() {
  return process.env.AI_EDIT_PROVIDER === "apimart" && process.env.APIMART_API_KEY ? "apimart" : "local-fallback";
}

function configuredEditModel() {
  return configuredEditProvider() === "apimart" ? process.env.AI_EDIT_MODEL ?? "gpt-5-nano" : undefined;
}

function proposalFailure(error, providerKey) {
  const message = error instanceof Error ? error.message.slice(0, 500) : "AI 剪辑提案请求失败";
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "PROPOSAL_FAILED";
  const submissionUnknown = providerKey !== "local-fallback" && /timeout|timed out|aborted|network|fetch|socket|econn|5\d\d/i.test(message);
  return { code, message, submissionUnknown, retryable: submissionUnknown || providerKey !== "local-fallback" };
}

function proposalIdFromReceipt(receipt) {
  const value = receipt?.errorDetails && typeof receipt.errorDetails === "object" ? receipt.errorDetails.proposalId : undefined;
  return typeof value === "string" ? value : undefined;
}

function analysisWorkerScriptPath() {
  const unpackedCandidates = [
    path.join(process.resourcesPath, "app.asar.unpacked", "apps", "desktop", "analysis-worker.cjs"),
    path.join(process.resourcesPath, "app.asar.unpacked", "electron", "analysis-worker.cjs"),
  ];
  if (app.isPackaged) {
    const unpacked = unpackedCandidates.find((candidate) => existsSync(candidate));
    if (unpacked) return unpacked;
  }
  const localCandidates = [path.join(__dirname, "analysis-worker.cjs"), path.join(__dirname, "..", "..", "electron", "analysis-worker.cjs")];
  return localCandidates.find((candidate) => existsSync(candidate)) ?? localCandidates[0];
}

function runAnalysisWorker(payload) {
  if (!utilityProcess || typeof utilityProcess.fork !== "function") throw new Error("当前 Electron 不支持 utility process");
  const workerPath = analysisWorkerScriptPath();
  const workerEnv = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH)/i.test(key))), HF_HUB_OFFLINE: "1" };
  return new Promise((resolve, reject) => {
    const requestId = randomUUID();
    const workerKey = typeof payload?.jobId === "string" && payload.jobId ? payload.jobId : requestId;
    const worker = utilityProcess.fork(workerPath, [], { env: workerEnv, serviceName: "creator-copilot-analysis" });
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      activeAnalysisWorkers.delete(workerKey);
      worker.kill();
      reject(new Error("媒体分析 worker 超时"));
    }, 10 * 60 * 1000);
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      activeAnalysisWorkers.delete(workerKey);
      callback();
      worker.kill();
    };
    const cancel = () => {
      if (settled) return false;
      const error = Object.assign(new Error("媒体分析已取消"), { code: "MEDIA_ANALYSIS_CANCELLED" });
      finish(() => reject(error));
      return true;
    };
    activeAnalysisWorkers.set(workerKey, cancel);
    worker.on("message", (message) => {
      if (!message || message.requestId !== requestId) return;
      finish(() => {
        if (message.ok) resolve(message.result);
        else reject(new Error(typeof message.error === "string" ? message.error : "媒体分析 worker 失败"));
      });
    });
    worker.on("exit", (code) => {
      if (settled) return;
      finish(() => reject(new Error(`媒体分析 worker 异常退出（${code ?? "unknown"}）`)));
    });
    worker.postMessage({ requestId, payload });
  });
}

function cancelAnalysisWorker(jobId) {
  const cancel = activeAnalysisWorkers.get(jobId);
  return typeof cancel === "function" ? cancel() : false;
}

async function analyzeLocalArtifact({ workspace, runtime, artifact }) {
  const analysisConfig = await activeAnalysisWorkerSettings(runtime);
  const settingsFingerprint = analysisConfigFingerprint(analysisConfig);
  const inputHash = `sha256:${createHash("sha256").update(JSON.stringify({ artifactId: artifact.artifactId, contentHash: artifact.contentHash, pipeline: "analysis-v2", settingsFingerprint })).digest("hex")}`;
  const jobId = `analysis-${artifact.artifactId}-${settingsFingerprint}`;
  const now = new Date();
  workspace.catalog.recoverExpiredLeases(now);
  let job = workspace.catalog.getJob(jobId);
  if (!job) {
    const timestamp = now.toISOString();
    workspace.catalog.insertJob({ schemaVersion: 1, id: jobId, kind: "media.analysis", inputHash, state: "queued", attempt: 0, idempotencyKey: `analysis-${artifact.artifactId}-${artifact.contentHash}-${settingsFingerprint}`, idempotencyScope: workspace.workspaceId, providerKey: "local", artifactIds: [artifact.artifactId], correlationId: `analysis-run-${randomUUID()}`, createdAt: timestamp, updatedAt: timestamp });
    job = workspace.catalog.getJob(jobId);
  } else if (job.state === "succeeded") {
    return { ok: true, status: "succeeded", reused: true, job, facts: searchCurrentAnalysisFacts(workspace, { workspaceId: workspace.workspaceId, artifactId: artifact.artifactId, analysisRunId: job.id, limit: 100 }) };
  } else if (["claimed", "running"].includes(job.state)) {
    return { ok: false, status: "running", job, message: "这段素材正在分析，请等待当前任务完成。" };
  } else if (["failed", "timed_out"].includes(job.state)) {
    workspace.catalog.transitionJob(job.id, job.state, "retry_wait", undefined, { retryAfter: now.toISOString(), lastError: undefined });
    job = workspace.catalog.getJob(jobId);
  } else if (job.state === "needs_attention") {
    workspace.catalog.transitionJob(job.id, job.state, "queued", undefined, { lastError: undefined });
    job = workspace.catalog.getJob(jobId);
  } else if (job.state === "cancelled") {
    return { ok: false, status: "cancelled", job, message: "这段素材的分析任务已取消，请重新导入素材后再试。" };
  }
  if (!job) throw new Error(`分析任务创建失败：${artifact.artifactId}`);
  const leaseToken = workspace.catalog.claimJob(job.id, "analysis-main", now, 120_000);
  if (!leaseToken) return { ok: false, status: "running", job: workspace.catalog.getJob(job.id), message: "分析任务正在运行或暂时无法取得租约。" };
  if (!workspace.catalog.heartbeatJob(job.id, "analysis-main", leaseToken, new Date(), 120_000)) return { ok: false, status: "needs_attention", job: workspace.catalog.getJob(job.id), message: "分析任务租约已失效，请稍后重试。" };
  try {
    const claimedJob = workspace.catalog.getJob(job.id) ?? job;
    const analysisRunId = `${job.id}-attempt-${claimedJob.attempt}`;
    const absolutePath = path.resolve(workspace.workspacePath, artifact.relativePath);
    const root = realpathSync(workspace.workspacePath);
    if (!existsSync(absolutePath)) throw new Error("本地素材文件不存在");
    const canonicalPath = realpathSync(absolutePath);
    if (canonicalPath !== root && !canonicalPath.startsWith(`${root}${path.sep}`)) throw new Error("分析素材路径越过工作区");
    const probe = await new runtime.media.FfmpegToolchain().probe(canonicalPath);
    const durationMs = probe.durationMs;
    if (!durationMs || durationMs <= 0) throw new Error("素材没有可用时长");
    const createdAt = new Date().toISOString();
    const workerResult = await runAnalysisWorker({ jobId: job.id, analysisRunId, sourcePath: canonicalPath, durationMs, workspaceId: workspace.workspaceId, artifactId: artifact.artifactId, contentHash: artifact.contentHash, createdAt, ...analysisConfig });
    workspace.catalog.saveAnalysisFacts(workerResult.facts);
    if (!workspace.catalog.transitionJob(job.id, "running", "succeeded", leaseToken, { artifactIds: [artifact.artifactId], checkpoint: { analysisRunId, settingsFingerprint, shotCount: workerResult.shotCount, factIds: workerResult.facts.map((fact) => fact.id), asrStatus: workerResult.asrStatus, ocrStatus: workerResult.ocrStatus } })) throw new Error("分析任务完成状态未能持久化");
    return { ok: true, status: "succeeded", reused: false, job: workspace.catalog.getJob(job.id), facts: workerResult.facts, summary: workerResult.summary, asrStatus: workerResult.asrStatus, ocrStatus: workerResult.ocrStatus };
  } catch (error) {
    const message = error instanceof Error ? error.message : "本地媒体分析失败";
    const cancelled = error && typeof error === "object" && error.code === "MEDIA_ANALYSIS_CANCELLED";
    const nextState = cancelled ? "cancelled" : "failed";
    const transitioned = workspace.catalog.transitionJob(job.id, "running", nextState, leaseToken, { lastError: { code: cancelled ? "MEDIA_ANALYSIS_CANCELLED" : "MEDIA_ANALYSIS_FAILED", message, retryable: !cancelled } });
    return { ok: false, status: cancelled ? "cancelled" : transitioned ? "failed" : "needs_attention", job: workspace.catalog.getJob(job.id), message };
  }
}

async function importLocalMediaJob({ workspace, runtime, sourcePath, workerId = "media-import-main", maxBytes }) {
  if (!runtime.media.mimeTypeForPath(sourcePath).startsWith("video/")) return { ok: false, status: "failed", errorCode: "MEDIA_IMPORT_UNSUPPORTED_TYPE", message: "当前本地导入只支持视频文件。" };
  const sourceHash = await runtime.media.sha256File(sourcePath);
  const hashSuffix = sourceHash.slice("sha256:".length, "sha256:".length + 24);
  const jobId = `media-import-${hashSuffix}`;
  const now = new Date();
  workspace.catalog.recoverExpiredLeases(now);
  let job = workspace.catalog.getJob(jobId);
  if (!job) {
    const timestamp = now.toISOString();
    workspace.catalog.insertJob({
      schemaVersion: 1,
      id: jobId,
      kind: "media.import",
      inputHash: sourceHash,
      state: "queued",
      attempt: 0,
      idempotencyKey: `media-import-${sourceHash}`,
      idempotencyScope: workspace.workspaceId,
      providerKey: "local",
      correlationId: `media-import-run-${randomUUID()}`,
      artifactIds: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    job = workspace.catalog.getJob(jobId);
  } else if (job.inputHash !== sourceHash) {
    return { ok: false, status: "conflict", errorCode: "MEDIA_IMPORT_INPUT_CHANGED", message: "同一个导入任务的文件内容已经变化，请重新选择文件。", job };
  } else if (job.state === "succeeded") {
    const artifacts = job.artifactIds.map((artifactId) => workspace.catalog.getArtifact(artifactId)).filter(Boolean);
    const checkpoint = job.checkpoint && typeof job.checkpoint.mediaImport === "object" ? job.checkpoint.mediaImport : undefined;
    if (artifacts.length === job.artifactIds.length && artifacts.length > 0) {
      return {
        ok: true,
        status: "succeeded",
        reused: true,
        sourceName: checkpoint && typeof checkpoint.sourceName === "string" ? checkpoint.sourceName : path.basename(sourcePath),
        probe: checkpoint && checkpoint.probe,
        artifacts,
        job,
      };
    }
    return { ok: false, status: "needs_attention", errorCode: "MEDIA_IMPORT_ARTIFACT_MISSING", message: "导入任务已完成，但本地产物不完整；请重新选择该文件。", job };
  } else if (["claimed", "running"].includes(job.state)) {
    return { ok: false, status: "running", message: "这段素材正在导入，请等待当前任务完成。", job };
  } else if (["failed", "timed_out"].includes(job.state)) {
    workspace.catalog.transitionJob(job.id, job.state, "retry_wait", undefined, { retryAfter: now.toISOString(), lastError: undefined });
    job = workspace.catalog.getJob(job.id);
  } else if (job.state === "submission_unknown") {
    workspace.catalog.transitionJob(job.id, job.state, "needs_attention", undefined, { lastError: undefined });
    job = workspace.catalog.getJob(job.id);
    if (job?.state === "needs_attention") {
      workspace.catalog.transitionJob(job.id, job.state, "queued", undefined, { lastError: undefined });
      job = workspace.catalog.getJob(job.id);
    }
  } else if (job.state === "needs_attention") {
    workspace.catalog.transitionJob(job.id, job.state, "queued", undefined, { lastError: undefined });
    job = workspace.catalog.getJob(job.id);
  } else if (job.state === "cancelled") {
    return { ok: false, status: "cancelled", message: "这段素材的导入任务已取消，请重新选择文件。", job };
  }
  if (!job) throw new Error("媒体导入任务创建失败");
  const leaseToken = workspace.catalog.claimJob(job.id, workerId, now, 10 * 60 * 1000);
  if (!leaseToken) return { ok: false, status: "running", message: "导入任务正在运行或暂时无法取得租约。", job: workspace.catalog.getJob(job.id) };
  if (!workspace.catalog.heartbeatJob(job.id, workerId, leaseToken, new Date(), 10 * 60 * 1000)) return { ok: false, status: "needs_attention", message: "导入任务租约已失效，请稍后重试。", job: workspace.catalog.getJob(job.id) };
  try {
    const imported = await runtime.mediaImporter.import({ workspaceRoot: workspace.workspacePath, sourcePath, ...(maxBytes ? { maxBytes } : {}) });
    if (imported.source.contentHash !== sourceHash) throw new Error("导入过程中文件内容发生变化");
    const artifacts = [imported.source, imported.proxy, imported.thumbnail].map((artifact) => ({ ...artifact, workspaceId: workspace.workspaceId }));
    workspace.catalog.insertArtifacts(artifacts);
    const sourceName = path.basename(sourcePath);
    const checkpoint = { mediaImport: { sourceName, sourceHash, probe: imported.probe, artifactIds: artifacts.map((artifact) => artifact.artifactId), completedAt: new Date().toISOString() } };
    if (!workspace.catalog.transitionJob(job.id, "running", "succeeded", leaseToken, { artifactIds: artifacts.map((artifact) => artifact.artifactId), checkpoint })) throw new Error("媒体导入任务完成状态未能持久化");
    return { ok: true, status: "succeeded", reused: false, sourceName, probe: imported.probe, artifacts, job: workspace.catalog.getJob(job.id) };
  } catch (error) {
    const message = error instanceof Error ? error.message : "本地媒体导入失败";
    const transitioned = workspace.catalog.transitionJob(job.id, "running", "failed", leaseToken, { lastError: { code: "MEDIA_IMPORT_FAILED", message, retryable: true } });
    return { ok: false, status: transitioned ? "failed" : "needs_attention", errorCode: "media_import_failed", message, job: workspace.catalog.getJob(job.id) };
  }
}

async function resolveFrozenRenderAssets({ workspace, runtime, frozen }) {
  const assets = {};
  const workspaceRoot = realpathSync(workspace.workspacePath);
  for (const lock of frozen.assetLocks) {
    const artifact = workspace.catalog.getArtifact(lock.assetId);
    if (!artifact || artifact.workspaceId !== workspace.workspaceId) throw new Error(`冻结规格引用的素材不存在：${lock.assetId}`);
    if (artifact.contentHash !== lock.contentHash) throw new Error(`素材 hash 已变化：${lock.assetId}`);
    const absolutePath = path.resolve(workspace.workspacePath, artifact.relativePath);
    if (!existsSync(absolutePath)) throw new Error(`素材文件不存在：${lock.assetId}`);
    const canonicalPath = realpathSync(absolutePath);
    if (canonicalPath !== workspaceRoot && !canonicalPath.startsWith(`${workspaceRoot}${path.sep}`)) throw new Error(`素材路径越过工作区：${lock.assetId}`);
    const probe = await new runtime.media.FfmpegToolchain().probe(canonicalPath);
    if (!probe.durationMs || probe.durationMs <= 0) throw new Error(`素材没有有效时长：${lock.assetId}`);
    assets[lock.assetId] = { assetId: lock.assetId, relativePath: artifact.relativePath, absolutePath: canonicalPath, contentHash: artifact.contentHash, durationMs: probe.durationMs, hasVideo: probe.streams.some((stream) => stream.kind === "video"), hasAudio: probe.streams.some((stream) => stream.kind === "audio") };
  }
  return assets;
}

function renderOutputArtifacts({ workspace, renderId, result, parentArtifactIds }) {
  const outputArtifacts = result.manifest.outputs.map((output) => ({
    schemaVersion: 1,
    artifactId: `artifact-${renderId}-${output.kind}`,
    workspaceId: workspace.workspaceId,
    kind: `render-${output.kind}`,
    relativePath: output.relativePath,
    mimeType: output.mimeType,
    contentHash: output.contentHash,
    byteSize: output.byteSize,
    parentArtifactIds,
    validationStatus: "valid",
  }));
  outputArtifacts.push({
    schemaVersion: 1,
    artifactId: `artifact-${renderId}-manifest`,
    workspaceId: workspace.workspaceId,
    kind: "render-manifest",
    relativePath: path.relative(workspace.workspacePath, result.manifestPath).split(path.sep).join("/"),
    mimeType: "application/json",
    contentHash: result.manifestHash,
    byteSize: result.manifestByteSize,
    parentArtifactIds,
    validationStatus: "valid",
  });
  return outputArtifacts;
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1120,
    minHeight: 720,
    backgroundColor: "#f4f0e8",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });

  if (isDevelopment) {
    void window.loadURL("http://127.0.0.1:4316");
  } else {
    void window.loadFile(path.join(__dirname, "..", "..", "dist", "index.html"));
  }
  return window;
}

ipcMain.handle("desktop:get-info", () => ({
  appVersion: app.getVersion(),
  platform: process.platform,
  arch: process.arch,
  workspacePath: selectedWorkspacePath,
  mediaGeneration: shotGenerationService.configuration(),
}));

ipcMain.handle("desktop:quote-generated-shots", (_event, raw) => shotGenerationService.quoteGeneratedShots(raw));

ipcMain.handle("desktop:run-generated-shots", (_event, quoteId) => shotGenerationService.runGeneratedShots(quoteId));

ipcMain.handle("desktop:get-local-analysis-settings", async () => {
  try {
    const runtime = await getDesktopRuntime();
    const loaded = await readLocalAnalysisSettings(runtime);
    return { ok: true, source: loaded.source, settings: loaded.settings, capabilities: localAnalysisCapabilities(runtime, loaded.settings), message: loaded.warning };
  } catch (error) {
    return { ok: false, errorCode: "local_analysis_settings_read_failed", message: error instanceof Error ? error.message : "无法读取本地分析设置" };
  }
});

ipcMain.handle("desktop:save-local-analysis-settings", async (_event, raw) => {
  try {
    const runtime = await getDesktopRuntime();
    const settings = await saveLocalAnalysisSettings(runtime, raw);
    return { ok: true, source: "saved", settings, capabilities: localAnalysisCapabilities(runtime, settings) };
  } catch (error) {
    return { ok: false, errorCode: "local_analysis_settings_save_failed", message: error instanceof Error ? error.message : "无法保存本地分析设置" };
  }
});

ipcMain.handle("desktop:choose-analysis-path", async (_event, raw) => {
  try {
    const kind = typeof raw?.kind === "string" ? raw.kind : "";
    const engine = typeof raw?.engine === "string" ? raw.engine : undefined;
    const supportedKinds = new Set(["asr-model", "asr-binary", "asr-python", "asr-script", "ocr-script", "ocr-binary"]);
    if (!supportedKinds.has(kind)) throw new Error("本地分析路径类型无效");
    const directoryKinds = new Set(["asr-model"]);
    const properties = directoryKinds.has(kind) && engine === "faster-whisper" ? ["openDirectory"] : ["openFile"];
    const filters = kind.includes("model") ? [{ name: "模型文件", extensions: ["bin", "gguf", "ggml", "safetensors"] }] : undefined;
    const result = await dialog.showOpenDialog({ properties, filters, title: "选择本地分析文件或目录" });
    if (result.canceled || result.filePaths.length === 0) return { ok: true, canceled: true };
    const selected = result.filePaths[0];
    validateLocalAnalysisPaths({ asr: { modelPath: kind.startsWith("asr-") ? selected : undefined, binaryPath: undefined, pythonPath: undefined, scriptPath: undefined }, ocr: { scriptPath: kind.startsWith("ocr-") ? selected : undefined, binaryPath: undefined } });
    return { ok: true, canceled: false, path: selected };
  } catch (error) {
    return { ok: false, errorCode: "local_analysis_path_choose_failed", message: error instanceof Error ? error.message : "无法选择本地分析路径" };
  }
});

ipcMain.handle("desktop:choose-workspace", async () => {
  const result = await dialog.showOpenDialog({
    properties: ["openDirectory", "createDirectory"],
    title: "选择本地创作工作区",
  });
  if (result.canceled || result.filePaths.length === 0) {
    return { canceled: true, path: null };
  }
  const workspacePath = await initializeWorkspace(result.filePaths[0]);
  return { canceled: false, path: workspacePath };
});

ipcMain.handle("desktop:list-projects", async () => {
  try {
    const workspace = requireWorkspace();
    return {
      ok: true,
      projects: workspace.catalog.listProjectsForWorkspace(workspace.workspaceId).map(({ payload: _payload, ...project }) => project),
    };
  } catch (error) {
    return { ok: false, errorCode: "project_list_failed", message: error instanceof Error ? error.message : "无法读取本地项目" };
  }
});

ipcMain.handle("desktop:load-project", async (_event, raw) => {
  try {
    const workspace = requireWorkspace();
    if (!raw || typeof raw.projectId !== "string" || !raw.projectId.trim()) throw new Error("项目 ID 无效");
    const project = workspace.catalog.getProject(raw.projectId.trim());
    if (!project || project.workspaceId !== workspace.workspaceId) throw new Error("项目不存在或不属于当前工作区");
    const payload = project.payload;
    const script = typeof payload.scriptId === "string" ? workspace.catalog.getScript(payload.scriptId) : undefined;
    const storyboard = typeof payload.storyboardId === "string" ? workspace.catalog.getStoryboard(payload.storyboardId) : undefined;
    const capturePackage = typeof payload.capturePackageId === "string" ? workspace.catalog.getCapturePackage(payload.capturePackageId) : undefined;
    const taskIds = Array.isArray(payload.taskIds) ? payload.taskIds.filter((taskId) => typeof taskId === "string") : [];
    const tasks = taskIds.map((taskId) => workspace.catalog.getShootTask(taskId)).filter(Boolean);
    if (!script) throw new Error("项目已保存，但脚本引用缺失");
    if (typeof payload.storyboardId === "string" && !storyboard) throw new Error("项目已保存，但分镜引用缺失");
    if (typeof payload.capturePackageId === "string" && !capturePackage) throw new Error("项目已保存，但拍摄包引用缺失");
    if (tasks.length !== taskIds.length) throw new Error("项目已保存，但部分拍摄任务引用缺失");
    const takesByTask = Object.fromEntries(tasks.map((task) => [task.id, workspace.catalog.listTakes(task.id)]));
    return { ok: true, project, script, storyboard, tasks, capturePackage, takesByTask };
  } catch (error) {
    return { ok: false, errorCode: "project_load_failed", message: error instanceof Error ? error.message : "无法载入本地项目" };
  }
});

ipcMain.handle("desktop:import-media", async () => {
  if (!selectedWorkspacePath) return { ok: false, errorCode: "workspace_not_selected", message: "请先选择工作区" };
  const result = await dialog.showOpenDialog({
    properties: ["openFile"],
    title: "导入一段视频素材",
    filters: [{ name: "视频", extensions: ["mp4", "mov", "m4v", "webm", "mkv", "avi"] }],
  });
  if (result.canceled || result.filePaths.length === 0) return { ok: false, errorCode: "cancelled", message: "已取消导入" };
  try {
    const runtime = await getDesktopRuntime();
    const workspace = requireWorkspace();
    const imported = await importLocalMediaJob({ workspace, runtime, sourcePath: result.filePaths[0] });
    if (!imported.ok) return { ...imported, errorCode: imported.errorCode ?? "media_import_not_completed" };
    return {
      ok: true,
      reused: imported.reused,
      status: imported.status,
      sourceName: imported.sourceName,
      durationMs: imported.probe?.durationMs ?? null,
      streams: imported.probe?.streams.map(({ kind, codec, width, height, frameRate, sampleRate, channels, rotation }) => ({ kind, codec, width, height, frameRate, sampleRate, channels, rotation })) ?? [],
      artifacts: imported.artifacts,
      job: imported.job,
    };
  } catch (error) {
    return { ok: false, errorCode: "media_import_failed", message: error instanceof Error ? error.message : "媒体导入失败" };
  }
});

ipcMain.handle("desktop:analyze-asset", async (_event, raw) => {
  try {
    const workspace = requireWorkspace();
    if (!raw || typeof raw.artifactId !== "string" || !raw.artifactId.trim()) throw new Error("分析素材参数无效");
    const artifact = workspace.catalog.getArtifact(raw.artifactId.trim());
    if (!artifact || artifact.workspaceId !== workspace.workspaceId) throw new Error("素材不存在或不属于当前工作区");
    if (!artifact.mimeType.startsWith("video/")) throw new Error("当前本地分析只支持视频素材");
    const runtime = await getDesktopRuntime();
    return await analyzeLocalArtifact({ workspace, runtime, artifact });
  } catch (error) {
    return { ok: false, status: "failed", errorCode: "asset_analysis_failed", message: error instanceof Error ? error.message : "本地素材分析失败" };
  }
});

ipcMain.handle("desktop:cancel-analysis", async (_event, raw) => {
  try {
    const workspace = requireWorkspace();
    if (!raw || typeof raw.artifactId !== "string" || !raw.artifactId.trim()) throw new Error("取消分析参数无效");
    const artifact = workspace.catalog.getArtifact(raw.artifactId.trim());
    if (!artifact || artifact.workspaceId !== workspace.workspaceId) throw new Error("素材不存在或不属于当前工作区");
    const job = workspace.catalog.listJobsForWorkspace(workspace.workspaceId, "media.analysis")
      .filter((candidate) => candidate.artifactIds.includes(artifact.artifactId))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
    const jobId = job?.id;
    if (!job || !["claimed", "running"].includes(job.state)) return { ok: false, status: job?.state ?? "not_found", message: "这段素材当前没有正在运行的分析任务。" };
    const cancelled = cancelAnalysisWorker(jobId);
    return { ok: cancelled, status: cancelled ? "cancelling" : job.state, message: cancelled ? "已请求取消分析，正在清理 worker。" : "分析 worker 已结束或不属于当前窗口。" };
  } catch (error) {
    return { ok: false, errorCode: "asset_analysis_cancel_failed", message: error instanceof Error ? error.message : "取消本地分析失败" };
  }
});

ipcMain.handle("desktop:search-assets", async (_event, rawQuery) => {
  try {
    const workspace = requireWorkspace();
    const query = typeof rawQuery === "string" ? rawQuery.trim() : "";
    const artifacts = workspace.catalog.listArtifacts(workspace.workspaceId);
    const facts = artifacts.flatMap((artifact) => searchCurrentAnalysisFacts(workspace, { workspaceId: workspace.workspaceId, artifactId: artifact.artifactId, query, limit: 50 })).slice(0, 50);
    const matchingArtifactIds = new Set(facts.map((fact) => fact.artifactId));
    const visibleArtifacts = query ? artifacts.filter((artifact) => matchingArtifactIds.has(artifact.artifactId) || `${artifact.relativePath} ${artifact.kind} ${artifact.mimeType}`.toLowerCase().includes(query.toLowerCase())) : artifacts;
    const visibleArtifactIds = new Set(visibleArtifacts.map((artifact) => artifact.artifactId));
    const analysisJobs = workspace.catalog.listJobsForWorkspace(workspace.workspaceId, "media.analysis")
      .filter((job) => job.artifactIds.some((artifactId) => visibleArtifactIds.has(artifactId)))
      .map((job) => ({ id: job.id, state: job.state, attempt: job.attempt, artifactIds: job.artifactIds, lastError: job.lastError, updatedAt: job.updatedAt }));
    return { ok: true, artifacts: visibleArtifacts, facts, analysisJobs };
  } catch (error) {
    return { ok: false, errorCode: "asset_search_failed", message: error instanceof Error ? error.message : "素材搜索失败" };
  }
});

ipcMain.handle("desktop:research-account", async (_event, raw) => {
  try {
    const workspace = requireWorkspace();
    if (!raw || typeof raw.sourceInput !== "string" || !raw.sourceInput.trim()) throw new Error("请输入抖音主页链接或 sec_user_id");
    const count = raw.count === undefined ? 20 : Number(raw.count);
    const runtime = await getDesktopRuntime();
    const report = await runtime.research.buildAccountResearchReport({ workspaceId: workspace.workspaceId, sourceInput: raw.sourceInput.trim(), count, connector: getTikHubConnector(runtime), now: new Date().toISOString() });
    workspace.catalog.saveResearchReport(report);
    return { ok: true, report };
  } catch (error) {
    return { ok: false, errorCode: "account_research_failed", message: error instanceof Error ? error.message : "对标账号分析失败" };
  }
});

ipcMain.handle("desktop:quote-account-metrics", async (_event, raw) => {
  try {
    const workspace = requireWorkspace();
    if (!raw || typeof raw.reportId !== "string" || !Array.isArray(raw.awemeIds)) throw new Error("作品统计报价参数无效");
    const awemeIds = [...new Set(raw.awemeIds.filter((value) => typeof value === "string" && value.trim()).map((value) => value.trim()))];
    if (awemeIds.length < 1 || awemeIds.length > 50) throw new Error("一次最多补齐 50 条作品统计");
    const report = workspace.catalog.getResearchReport(raw.reportId);
    if (!report || report.workspaceId !== workspace.workspaceId) throw new Error("研究报告不存在或不属于当前工作区");
    if (awemeIds.some((awemeId) => !report.videos.some((video) => video.awemeId === awemeId))) throw new Error("选择的作品不在当前研究报告中");
    const runtime = await getDesktopRuntime();
    const connector = getTikHubConnector(runtime);
    if (typeof connector.fetchVideoStatistics !== "function") throw new Error("当前研究 Provider 不支持作品统计补齐");
    const price = await connector.getEndpointInfo(runtime.research.ACCOUNT_METRICS_ENDPOINT);
    const quote = runtime.research.createAccountMetricsQuote({ workspaceId: workspace.workspaceId, reportId: report.id, awemeIds, price, now: new Date().toISOString() });
    pendingAccountMetricsQuotes.set(quote.id, { workspaceId: workspace.workspaceId, quote, used: false });
    return { ok: true, quote };
  } catch (error) {
    return { ok: false, errorCode: "account_metrics_quote_failed", message: error instanceof Error ? error.message : "无法取得作品统计报价" };
  }
});

ipcMain.handle("desktop:run-account-metrics", async (_event, rawQuoteId) => {
  try {
    const workspace = requireWorkspace();
    if (typeof rawQuoteId !== "string" || !rawQuoteId.trim()) throw new Error("作品统计报价无效");
    const pending = pendingAccountMetricsQuotes.get(rawQuoteId);
    if (!pending || pending.workspaceId !== workspace.workspaceId) throw new Error("报价不存在、已重启失效或不属于当前工作区，请重新报价");
    const now = new Date();
    if (pending.used) throw new Error("报价已经使用，请重新报价");
    if (new Date(pending.quote.expiresAt).getTime() <= now.getTime()) throw new Error("报价已过期，请重新报价");
    pending.used = true;
    const report = workspace.catalog.getResearchReport(pending.quote.reportId);
    if (!report || report.workspaceId !== workspace.workspaceId) throw new Error("研究报告不存在或不属于当前工作区");
    const runtime = await getDesktopRuntime();
    const connector = getTikHubConnector(runtime);
    if (typeof connector.fetchVideoStatistics !== "function") throw new Error("当前研究 Provider 不支持作品统计补齐");
    const selectedIds = new Set(pending.quote.awemeIds);
    const rawUpdates = await connector.fetchVideoStatistics(pending.quote.awemeIds);
    const updates = rawUpdates.filter((update) => selectedIds.has(update.awemeId)).map((update) => ({ awemeId: update.awemeId, statistics: update.statistics, capturedAt: now.toISOString(), responseHash: update.responseHash }));
    if (updates.length === 0) return { ok: false, errorCode: "account_metrics_no_data", report, message: "TikHub 本次没有返回可用统计；报价已消耗，不会自动重试。" };
    const updatedReport = runtime.research.attachResearchMetrics(report, updates);
    workspace.catalog.saveResearchReport(updatedReport);
    const updatedIds = new Set(updates.map((update) => update.awemeId));
    const missingAwemeIds = pending.quote.awemeIds.filter((awemeId) => !updatedIds.has(awemeId));
    return { ok: true, report: updatedReport, updatedCount: updates.length, missingAwemeIds, message: missingAwemeIds.length > 0 ? `已补齐 ${updates.length} 条，另有 ${missingAwemeIds.length} 条未返回；不会自动重试。` : `已补齐 ${updates.length} 条作品的播放统计。` };
  } catch (error) {
    return { ok: false, errorCode: "account_metrics_run_failed", message: error instanceof Error ? error.message : "作品统计补齐失败" };
  }
});

ipcMain.handle("desktop:quote-account-analysis", async (_event, raw) => {
  try {
    const workspace = requireWorkspace();
    if (!raw || typeof raw.reportId !== "string") throw new Error("账号表现报价参数无效");
    const report = workspace.catalog.getResearchReport(raw.reportId);
    if (!report || report.workspaceId !== workspace.workspaceId) throw new Error("研究报告不存在或不属于当前工作区");
    const day = raw.day === undefined ? 7 : Number(raw.day);
    if (!Number.isInteger(day) || day < 1 || day > 30) throw new Error("账号表现分析时间范围必须是 1–30 天");
    const runtime = await getDesktopRuntime();
    const connector = getTikHubConnector(runtime);
    if (typeof connector.fetchAccountWorkAnalysis !== "function") throw new Error("当前研究 Provider 不支持账号表现分析");
    const price = await connector.getEndpointInfo(runtime.research.ACCOUNT_WORK_ANALYSIS_ENDPOINT);
    const quote = runtime.research.createAccountWorkAnalysisQuote({ workspaceId: workspace.workspaceId, reportId: report.id, secUserId: report.secUserId, day, price, now: new Date().toISOString() });
    pendingAccountAnalysisQuotes.set(quote.id, { workspaceId: workspace.workspaceId, quote, used: false });
    return { ok: true, quote };
  } catch (error) {
    return { ok: false, errorCode: "account_analysis_quote_failed", message: error instanceof Error ? error.message : "无法取得账号表现报价" };
  }
});

ipcMain.handle("desktop:run-account-analysis", async (_event, rawQuoteId) => {
  try {
    const workspace = requireWorkspace();
    if (typeof rawQuoteId !== "string" || !rawQuoteId.trim()) throw new Error("账号表现报价无效");
    const pending = pendingAccountAnalysisQuotes.get(rawQuoteId);
    if (!pending || pending.workspaceId !== workspace.workspaceId) throw new Error("报价不存在、已重启失效或不属于当前工作区，请重新报价");
    const now = new Date();
    if (pending.used) throw new Error("报价已经使用，请重新报价");
    if (new Date(pending.quote.expiresAt).getTime() <= now.getTime()) throw new Error("报价已过期，请重新报价");
    pending.used = true;
    const report = workspace.catalog.getResearchReport(pending.quote.reportId);
    if (!report || report.workspaceId !== workspace.workspaceId) throw new Error("研究报告不存在或不属于当前工作区");
    const runtime = await getDesktopRuntime();
    const connector = getTikHubConnector(runtime);
    if (typeof connector.fetchAccountWorkAnalysis !== "function") throw new Error("当前研究 Provider 不支持账号表现分析");
    const result = await connector.fetchAccountWorkAnalysis({ secUserId: pending.quote.secUserId, day: pending.quote.day });
    if (Object.keys(result.metrics).length === 0) return { ok: false, errorCode: "account_analysis_no_data", report, message: "TikHub 本次没有返回可用账号表现数据；报价已消耗，不会自动重试。" };
    const updatedReport = runtime.research.attachResearchAccountAnalysis(report, { day: result.day, metrics: result.metrics, capturedAt: now.toISOString(), responseHash: result.responseHash });
    workspace.catalog.saveResearchReport(updatedReport);
    return { ok: true, report: updatedReport, message: `已补充近 ${result.day} 日账号表现基准。` };
  } catch (error) {
    return { ok: false, errorCode: "account_analysis_run_failed", message: error instanceof Error ? error.message : "账号表现分析失败" };
  }
});

ipcMain.handle("desktop:quote-topic-radar", async (_event, raw) => {
  try {
    const workspace = requireWorkspace();
    const runtime = await getDesktopRuntime();
    const query = runtime.research.normalizeTopicRadarQuery(raw);
    const connector = getTikHubConnector(runtime);
    const prices = {};
    // TikHub's endpoint-info endpoint is limited to roughly one request/second.
    // Read prices in order with a small gap; never burst a quote request.
    for (const [index, source] of query.sources.entries()) {
      if (index > 0) await new Promise((resolve) => setTimeout(resolve, 1_050));
      prices[source] = await connector.getEndpointInfo(topicRadarEndpointFor(runtime, source));
    }
    const quote = runtime.research.createTopicRadarQuote({ workspaceId: workspace.workspaceId, query, prices, now: new Date().toISOString() });
    pendingTopicRadarQuotes.set(quote.id, { workspaceId: workspace.workspaceId, quote, used: false });
    return { ok: true, quote };
  } catch (error) {
    return { ok: false, errorCode: "topic_radar_quote_failed", message: error instanceof Error ? error.message : "无法取得选题雷达报价" };
  }
});

ipcMain.handle("desktop:run-topic-radar", async (_event, rawQuoteId) => {
  try {
    const workspace = requireWorkspace();
    if (typeof rawQuoteId !== "string" || !rawQuoteId.trim()) throw new Error("选题雷达报价无效");
    const pending = pendingTopicRadarQuotes.get(rawQuoteId);
    if (!pending || pending.workspaceId !== workspace.workspaceId) throw new Error("报价不存在、已重启失效或不属于当前工作区，请重新报价");
    const now = new Date();
    if (pending.used) throw new Error("报价已经使用，请重新报价");
    if (new Date(pending.quote.expiresAt).getTime() <= now.getTime()) throw new Error("报价已过期，请重新报价");
    pending.used = true;
    const runtime = await getDesktopRuntime();
    const connector = getTikHubConnector(runtime);
    const results = [];
    const runs = [];
    for (const source of pending.quote.query.sources) {
      const line = pending.quote.lines.find((candidate) => candidate.source === source);
      if (!line) throw new Error(`报价缺少 ${source} 明细`);
      const timestamp = new Date().toISOString();
      const jobId = `topic-radar-${pending.quote.id}-${source}`;
      const idempotencyKey = `${pending.quote.id}:${source}`;
      const existingJob = workspace.catalog.getJob(jobId);
      if (existingJob?.state === "succeeded") {
        runs.push({ schemaVersion: 1, source, endpoint: line.endpoint, jobId, quotedCostUsd: line.costUsd, status: "succeeded", itemCount: 0 });
        continue;
      }
      if (!existingJob) workspace.catalog.insertJob({ schemaVersion: 1, id: jobId, kind: "topic-radar.discovery", inputHash: `quote:${pending.quote.id}:${source}`, state: "queued", attempt: 0, idempotencyKey, idempotencyScope: workspace.workspaceId, providerKey: "tikhub", artifactIds: [], correlationId: pending.quote.id, createdAt: timestamp, updatedAt: timestamp });
      const leaseToken = workspace.catalog.claimJob(jobId, "topic-radar-main", now, 120_000);
      if (!leaseToken || !workspace.catalog.heartbeatJob(jobId, "topic-radar-main", leaseToken, now, 120_000)) {
        runs.push({ schemaVersion: 1, source, endpoint: line.endpoint, jobId, quotedCostUsd: line.costUsd, status: "submission_unknown", itemCount: 0, error: { code: "LEASE_UNAVAILABLE", message: "选题雷达任务无法取得本地租约，不会自动重复付费。", retryable: true } });
        continue;
      }
      try {
        const claimedJob = workspace.catalog.getJob(job.id) ?? job;
        const analysisRunId = `${job.id}-attempt-${claimedJob.attempt}`;
        let result;
        if (source === "search_hot") result = { search: await connector.fetchSearchHotList({ page: 1, pageSize: pending.quote.query.pageSize, dateWindow: pending.quote.query.dateWindow, keyword: pending.quote.query.keyword }) };
        else result = { billboard: await connector.fetchBillboardPosts({ kind: source, page: 1, pageSize: pending.quote.query.pageSize, dateWindow: pending.quote.query.dateWindow, keyword: pending.quote.query.keyword }) };
        const itemCount = result.search?.items.length ?? result.billboard?.items.length ?? 0;
        const responseHash = result.search?.responseHash ?? result.billboard?.responseHash;
        workspace.catalog.transitionJob(jobId, "running", "succeeded", leaseToken, { checkpoint: { source, itemCount, responseHash } });
        results.push({ source, ...result });
        runs.push({ schemaVersion: 1, source, endpoint: line.endpoint, jobId, quotedCostUsd: line.costUsd, status: "succeeded", itemCount, responseHash });
      } catch (error) {
        const failure = topicRadarJobError(error);
        const status = failure.submissionUnknown ? "submission_unknown" : "failed";
        workspace.catalog.transitionJob(jobId, "running", status === "submission_unknown" ? "submission_unknown" : "failed", leaseToken, { lastError: { code: failure.code, message: failure.message, retryable: failure.retryable } });
        runs.push({ schemaVersion: 1, source, endpoint: line.endpoint, jobId, quotedCostUsd: line.costUsd, status, itemCount: 0, error: { code: failure.code, message: failure.message, retryable: failure.retryable } });
      }
    }
    const report = runtime.research.createTopicRadarReport({ workspaceId: workspace.workspaceId, quote: pending.quote, runs, results, createdAt: new Date().toISOString() });
    workspace.catalog.saveTopicRadarReport(report);
    return { ok: report.status !== "failed", report, message: report.status === "partial" ? "部分来源完成，失败来源不会自动重试。" : undefined };
  } catch (error) {
    return { ok: false, errorCode: "topic_radar_run_failed", message: error instanceof Error ? error.message : "选题雷达运行失败" };
  }
});

ipcMain.handle("desktop:list-topic-radar-reports", async () => {
  try {
    const workspace = requireWorkspace();
    return { ok: true, reports: workspace.catalog.listTopicRadarReports(workspace.workspaceId) };
  } catch (error) {
    return { ok: false, errorCode: "topic_radar_history_failed", message: error instanceof Error ? error.message : "无法读取选题雷达历史" };
  }
});

ipcMain.handle("desktop:save-topic-opportunity", async (_event, raw) => {
  try {
    const workspace = requireWorkspace();
    if (!raw || (raw.source !== "account_research" && raw.source !== "topic_radar") || typeof raw.reportId !== "string" || !raw.reportId || typeof raw.opportunityId !== "string" || !raw.opportunityId) throw new Error("选题机会参数无效");
    const runtime = await getDesktopRuntime();
    const topic = buildTopicFromOpportunity({ workspace, runtime, source: raw.source, reportId: raw.reportId, opportunityId: raw.opportunityId });
    const existing = workspace.catalog.getTopic(topic.id);
    if (existing && existing.workspaceId !== workspace.workspaceId) throw new Error("选题不能跨工作区读取");
    if (existing) return { ok: true, created: false, topic: existing };
    workspace.catalog.saveTopic(topic);
    return { ok: true, created: true, topic };
  } catch (error) {
    return { ok: false, errorCode: "topic_save_failed", message: error instanceof Error ? error.message : "加入选题库失败" };
  }
});

ipcMain.handle("desktop:list-topics", async () => {
  try {
    const workspace = requireWorkspace();
    return { ok: true, topics: workspace.catalog.listTopics(workspace.workspaceId) };
  } catch (error) {
    return { ok: false, errorCode: "topic_list_failed", message: error instanceof Error ? error.message : "无法读取本地选题库" };
  }
});

ipcMain.handle("desktop:select-topic", async (_event, raw) => {
  try {
    const workspace = requireWorkspace();
    if (!raw || typeof raw.topicId !== "string" || !raw.topicId.trim()) throw new Error("选题 ID 无效");
    if (raw.expectedRevision !== undefined && (!Number.isInteger(raw.expectedRevision) || raw.expectedRevision < 1)) throw new Error("选题版本无效");
    const topic = workspace.catalog.selectTopic(raw.topicId.trim(), workspace.workspaceId, raw.expectedRevision, new Date().toISOString());
    if (!topic) return { ok: false, errorCode: "topic_revision_conflict", message: "选题已被其他操作更新，请刷新后重试。", topic: workspace.catalog.getTopic(raw.topicId.trim()) };
    return { ok: true, topic };
  } catch (error) {
    return { ok: false, errorCode: "topic_select_failed", message: error instanceof Error ? error.message : "确认选题失败" };
  }
});

ipcMain.handle("desktop:download-research-media", async (_event, raw) => {
  try {
    const workspace = requireWorkspace();
    if (!raw || typeof raw.reportId !== "string" || !Array.isArray(raw.awemeIds)) throw new Error("研究素材选择参数无效");
    const awemeIds = [...new Set(raw.awemeIds.filter((value) => typeof value === "string" && value.trim()).map((value) => value.trim()))];
    if (awemeIds.length < 1 || awemeIds.length > 5) throw new Error("一次只能选择 1–5 条作品进行本地化");
    const report = workspace.catalog.getResearchReport(raw.reportId);
    if (!report || report.workspaceId !== workspace.workspaceId) throw new Error("研究报告不存在或不属于当前工作区");
    const selected = report.videos.filter((video) => awemeIds.includes(video.awemeId));
    if (selected.length !== awemeIds.length) throw new Error("选择的作品不在当前研究报告中");
    const runtime = await getDesktopRuntime();
    const connector = getTikHubConnector(runtime);
    const attachments = [];
    const failed = [];
    const downloaded = [];
    for (const video of selected) {
      if (video.artifactIds.length > 0) {
        attachments.push({ awemeId: video.awemeId, artifactIds: video.artifactIds, attachedAt: new Date().toISOString() });
        downloaded.push({ awemeId: video.awemeId, reused: true, artifactIds: video.artifactIds });
        continue;
      }
      const temporaryPath = path.join(os.tmpdir(), `creator-copilot-research-${randomUUID()}.mp4`);
      try {
        const playUrl = await connector.fetchHighestQualityPlayUrl({ awemeId: video.awemeId, shareUrl: video.shareUrl, region: "CN" });
        await runtime.media.downloadRemoteFile({ url: playUrl.url, destinationPath: temporaryPath, maxBytes: 1024 * 1024 * 1024 });
        const imported = await importLocalMediaJob({ workspace, runtime, sourcePath: temporaryPath, workerId: "media-research-import-main", maxBytes: 1024 * 1024 * 1024 });
        if (!imported.ok) throw new Error(imported.message ?? "研究素材导入任务未完成");
        const artifactIds = imported.artifacts.map((artifact) => artifact.artifactId);
        attachments.push({ awemeId: video.awemeId, artifactIds, attachedAt: new Date().toISOString() });
        downloaded.push({ awemeId: video.awemeId, reused: imported.reused, artifactIds });
      } catch (error) {
        failed.push({ awemeId: video.awemeId, message: error instanceof Error ? error.message : "下载或导入失败" });
      } finally {
        await removeFile(temporaryPath, { force: true }).catch(() => undefined);
      }
    }
    let updated = runtime.research.attachResearchMedia(report, attachments);
    updated = runtime.research.markResearchMediaFailures(updated, failed.map((item) => item.awemeId));
    workspace.catalog.saveResearchReport(updated);
    if (downloaded.length === 0) return { ok: false, errorCode: "research_media_download_failed", message: failed[0]?.message ?? "没有作品成功本地化", report: updated, failed };
    return { ok: true, report: updated, downloaded, failed };
  } catch (error) {
    return { ok: false, errorCode: "research_media_download_failed", message: error instanceof Error ? error.message : "研究素材下载失败" };
  }
});

ipcMain.handle("desktop:analyze-research-media", async (_event, raw) => {
  try {
    const workspace = requireWorkspace();
    if (!raw || typeof raw.reportId !== "string" || !Array.isArray(raw.awemeIds)) throw new Error("媒体分析选择参数无效");
    const awemeIds = [...new Set(raw.awemeIds.filter((value) => typeof value === "string" && value.trim()).map((value) => value.trim()))];
    if (awemeIds.length < 1 || awemeIds.length > 5) throw new Error("一次只能分析 1–5 条作品");
    const report = workspace.catalog.getResearchReport(raw.reportId);
    if (!report || report.workspaceId !== workspace.workspaceId) throw new Error("研究报告不存在或不属于当前工作区");
    const selected = report.videos.filter((video) => awemeIds.includes(video.awemeId));
    if (selected.length !== awemeIds.length) throw new Error("选择的作品不在当前研究报告中");
    const runtime = await getDesktopRuntime();
    const analysisConfig = await activeAnalysisWorkerSettings(runtime);
    const settingsFingerprint = analysisConfigFingerprint(analysisConfig);
    const updates = [];
    const factSummaries = [];
    const failed = [];
    const jobs = [];
    for (const video of selected) {
      const sourceArtifactId = video.artifactIds[0];
      const artifact = sourceArtifactId ? workspace.catalog.getArtifact(sourceArtifactId) : undefined;
      if (!artifact) {
        failed.push({ awemeId: video.awemeId, message: "作品尚未本地化，无法开始分析" });
        continue;
      }
      const inputHash = `sha256:${createHash("sha256").update(JSON.stringify({ artifactId: artifact.artifactId, contentHash: artifact.contentHash, pipeline: "analysis-v2", settingsFingerprint })).digest("hex")}`;
      const jobId = `analysis-${artifact.artifactId}-${settingsFingerprint}`;
      const now = new Date();
      let job = workspace.catalog.getJob(jobId);
      if (!job) {
        const timestamp = now.toISOString();
        workspace.catalog.insertJob({ schemaVersion: 1, id: jobId, kind: "media.analysis", inputHash, state: "queued", attempt: 0, idempotencyKey: `analysis-${artifact.artifactId}-${artifact.contentHash}-${settingsFingerprint}`, idempotencyScope: workspace.workspaceId, providerKey: "local", artifactIds: [artifact.artifactId], correlationId: randomUUID(), createdAt: timestamp, updatedAt: timestamp });
        job = workspace.catalog.getJob(jobId);
      } else if (job.state === "succeeded") {
        const reusedFacts = searchCurrentAnalysisFacts(workspace, { workspaceId: workspace.workspaceId, artifactId: artifact.artifactId, analysisRunId: job.id, limit: 100 });
        updates.push({ awemeId: video.awemeId, status: video.mediaAnalysisStatus === "completed" ? "completed" : "partial", factIds: reusedFacts.map((fact) => fact.id), facts: reusedFacts, summary: "已复用已完成的本地分析任务。", analyzedAt: now.toISOString() });
        factSummaries.push({ awemeId: video.awemeId, artifactIds: video.artifactIds, facts: reusedFacts, analyzedAt: now.toISOString() });
        jobs.push({ id: job.id, state: job.state, reused: true });
        continue;
      } else if (["failed", "needs_attention", "timed_out"].includes(job.state)) {
        const recoveryState = job.state === "needs_attention" ? "queued" : "retry_wait";
        workspace.catalog.transitionJob(job.id, job.state, recoveryState, undefined, { retryAfter: now.toISOString(), lastError: undefined });
        job = workspace.catalog.getJob(job.id);
      }
      if (!job) throw new Error(`分析任务创建失败：${artifact.artifactId}`);
      workspace.catalog.recoverExpiredLeases(now);
      const leaseToken = workspace.catalog.claimJob(job.id, "analysis-main", now, 120_000);
      if (!leaseToken) {
        failed.push({ awemeId: video.awemeId, message: "分析任务正在运行或无法取得租约" });
        continue;
      }
      const heartbeatAt = new Date();
      if (!workspace.catalog.heartbeatJob(job.id, "analysis-main", leaseToken, heartbeatAt, 120_000)) {
        failed.push({ awemeId: video.awemeId, message: "分析任务租约已失效，请重试" });
        continue;
      }
      try {
        const absolutePath = path.resolve(workspace.workspacePath, artifact.relativePath);
        const root = realpathSync(workspace.workspacePath);
        if (!existsSync(absolutePath)) throw new Error("本地素材文件不存在");
        const canonicalPath = realpathSync(absolutePath);
        if (canonicalPath !== root && !canonicalPath.startsWith(`${root}${path.sep}`)) throw new Error("分析素材路径越过工作区");
        const probe = await new runtime.media.FfmpegToolchain().probe(canonicalPath);
        const durationMs = probe.durationMs ?? video.durationMs;
        if (!durationMs || durationMs <= 0) throw new Error("素材没有可用时长");
        const createdAt = new Date().toISOString();
        const workerResult = await runAnalysisWorker({ jobId: job.id, analysisRunId, sourcePath: canonicalPath, durationMs, workspaceId: workspace.workspaceId, artifactId: artifact.artifactId, contentHash: artifact.contentHash, createdAt, ...analysisConfig });
        workspace.catalog.saveAnalysisFacts(workerResult.facts);
        workspace.catalog.transitionJob(job.id, "running", "succeeded", leaseToken, { artifactIds: [artifact.artifactId], checkpoint: { analysisRunId, settingsFingerprint, shotCount: workerResult.shotCount, factIds: workerResult.facts.map((fact) => fact.id), asrStatus: workerResult.asrStatus, ocrStatus: workerResult.ocrStatus } });
        updates.push({ awemeId: video.awemeId, status: workerResult.asrReady && workerResult.ocrReady ? "completed" : "partial", factIds: workerResult.facts.map((fact) => fact.id), facts: workerResult.facts, summary: workerResult.summary, analyzedAt: createdAt });
        factSummaries.push({ awemeId: video.awemeId, artifactIds: video.artifactIds, facts: workerResult.facts, analyzedAt: createdAt });
        jobs.push({ id: job.id, state: "succeeded", factCount: workerResult.facts.length });
      } catch (error) {
        const message = error instanceof Error ? error.message : "本地媒体分析失败";
        const cancelled = error && typeof error === "object" && error.code === "MEDIA_ANALYSIS_CANCELLED";
        const nextState = cancelled ? "cancelled" : "failed";
        workspace.catalog.transitionJob(job.id, "running", nextState, leaseToken, { lastError: { code: cancelled ? "MEDIA_ANALYSIS_CANCELLED" : "MEDIA_ANALYSIS_FAILED", message, retryable: !cancelled } });
        failed.push({ awemeId: video.awemeId, message });
        jobs.push({ id: job.id, state: nextState });
      }
    }
    let updated = runtime.research.attachResearchAnalysis(workspace.catalog.getResearchReport(report.id) ?? report, updates);
    updated = runtime.research.attachResearchMediaPatterns(updated, factSummaries);
    workspace.catalog.saveResearchReport(updated);
    if (updates.length === 0) return { ok: false, errorCode: "research_media_analysis_failed", message: failed[0]?.message ?? "没有作品完成分析", report: updated, failed, jobs };
    return { ok: true, report: updated, failed, jobs };
  } catch (error) {
    return { ok: false, errorCode: "research_media_analysis_failed", message: error instanceof Error ? error.message : "本地媒体分析失败" };
  }
});

ipcMain.handle("desktop:propose-script", async (_event, raw) => {
  try {
    const workspace = requireWorkspace();
    if (!raw || typeof raw.brief !== "string" || !raw.brief.trim()) throw new Error("请先写下你真正想讲的主题或原始思路");
    const runtime = await getDesktopRuntime();
    const manualEvidence = Array.isArray(raw.sourceEvidence) ? raw.sourceEvidence.filter((item) => item && typeof item.id === "string" && typeof item.text === "string").slice(0, 20) : [];
    let topicContext;
    let sourceEvidence = manualEvidence;
    if (raw.topicId !== undefined) {
      if (typeof raw.topicId !== "string" || !raw.topicId.trim()) throw new Error("选题 ID 无效");
      const topic = workspace.catalog.getTopic(raw.topicId.trim());
      if (!topic || topic.workspaceId !== workspace.workspaceId) throw new Error("选题不存在或不属于当前工作区");
      if (topic.status !== "selected") throw new Error("请先在选题库确认这个选题，再生成脚本提案");
      const context = buildTopicScriptContext({ workspace, topic });
      topicContext = context.topicContext;
      sourceEvidence = [...context.sourceEvidence, ...manualEvidence.filter((item) => !context.sourceEvidence.some((evidence) => evidence.id === item.id))].slice(0, 20);
    }
    const result = await getScriptAgent(runtime).proposeScript({ workspaceId: workspace.workspaceId, brief: raw.brief.trim(), voiceProfile: typeof raw.voiceProfile === "string" ? raw.voiceProfile : undefined, sourceEvidence, topicContext, now: new Date().toISOString() });
    workspace.catalog.saveScriptProposal(result.proposal);
    return { ok: true, proposal: result.proposal, provider: result.provider };
  } catch (error) {
    return { ok: false, errorCode: "script_proposal_failed", message: error instanceof Error ? error.message : "脚本提案失败" };
  }
});

ipcMain.handle("desktop:accept-script-proposal", async (_event, raw) => {
  try {
    const workspace = requireWorkspace();
    if (!raw || typeof raw.proposalId !== "string" || typeof raw.projectTitle !== "string" || !raw.projectTitle.trim()) throw new Error("确认脚本需要提案 ID 和项目标题");
    const proposal = workspace.catalog.getScriptProposal(raw.proposalId);
    if (!proposal || proposal.workspaceId !== workspace.workspaceId) throw new Error("脚本提案不存在或不属于当前工作区");
    const runtime = await getDesktopRuntime();
    const now = new Date().toISOString();
    const projectId = `project-${randomUUID()}`;
    const script = runtime.creation.ScriptSchema.parse({ schemaVersion: 1, id: `script-${randomUUID()}`, projectId, topicId: proposal.topicId, topicRevision: proposal.topicRevision, revision: 1, status: "approved", blocks: proposal.blocks.map((block) => ({ schemaVersion: 1, id: block.id, order: block.order, kind: block.kind, text: block.text, emphasis: block.emphasis, evidenceIds: block.evidenceIds, visualNeed: block.visualNeed })), estimatedDurationMs: proposal.blocks.reduce((total, block) => total + Math.max(1_500, Math.round(block.text.length * 260)), 0), createdAt: now, updatedAt: now });
    const project = { id: projectId, workspaceId: workspace.workspaceId, title: raw.projectTitle.trim(), stage: "script", revision: 1, payload: { scriptId: script.id, scriptProposalId: proposal.id, topicId: proposal.topicId, topicRevision: proposal.topicRevision, visualSuggestions: Object.fromEntries(proposal.blocks.map((block) => [block.id, block.visualSuggestion])), shotPlans: Object.fromEntries(proposal.blocks.filter((block) => block.shotPlan).map((block) => [block.id, block.shotPlan])) }, createdAt: now, updatedAt: now };
    const accepted = workspace.catalog.acceptScriptProposal({ proposalId: proposal.id, workspaceId: workspace.workspaceId, project, script });
    return { ok: true, proposal: accepted.proposal, project: accepted.project, script: accepted.script };
  } catch (error) {
    return { ok: false, errorCode: "script_accept_failed", message: error instanceof Error ? error.message : "脚本确认失败" };
  }
});

ipcMain.handle("desktop:create-capture-workflow", async (_event, raw) => {
  try {
    const workspace = requireWorkspace();
    if (!raw || typeof raw.projectTitle !== "string" || !raw.projectTitle.trim()) throw new Error("项目标题不能为空");
    if (!Array.isArray(raw.blocks) || raw.blocks.length === 0 || raw.blocks.length > 30) throw new Error("脚本段落数量必须在 1–30 之间");
    if (!Array.isArray(raw.shots) || raw.shots.length === 0 || raw.shots.length > 60) throw new Error("分镜数量必须在 1–60 之间");
    const runtime = await getDesktopRuntime();
    const now = new Date().toISOString();
    const existingProjectId = typeof raw.existingProjectId === "string" ? raw.existingProjectId : undefined;
    const existingScriptId = typeof raw.existingScriptId === "string" ? raw.existingScriptId : undefined;
    const existingProject = existingProjectId ? workspace.catalog.getProject(existingProjectId) : undefined;
    const existingScript = existingScriptId ? workspace.catalog.getScript(existingScriptId) : undefined;
    if (existingProjectId && (!existingProject || existingProject.workspaceId !== workspace.workspaceId)) throw new Error("已确认的脚本项目不存在或不属于当前工作区");
    if (existingScriptId && (!existingScript || !existingProject || existingScript.projectId !== existingProject.id)) throw new Error("已确认的脚本版本不存在或项目归属不一致");
    const projectId = existingProject?.id ?? `project-${randomUUID()}`;
    const scriptId = existingScript?.id ?? `script-${randomUUID()}`;
    const storyboardId = `storyboard-${randomUUID()}`;
    const capturePackageId = `capture-${randomUUID()}`;
    const blocks = raw.blocks.map((block, index) => ({
      schemaVersion: 1,
      id: existingScript?.blocks[index]?.id ?? `${scriptId}-block-${String(index + 1).padStart(2, "0")}`,
      order: index,
      kind: block.kind,
      text: String(block.text ?? "").trim(),
      emphasis: [],
      evidenceIds: [],
      visualNeed: block.visualNeed,
    }));
    const estimatedDurationMs = blocks.reduce((total, block) => total + Math.max(1500, Math.round(block.text.length * 260)), 0);
    const script = existingScript
      ? runtime.creation.ScriptSchema.parse({ ...existingScript, revision: existingScript.revision + 1, blocks, estimatedDurationMs, updatedAt: now })
      : runtime.creation.ScriptSchema.parse({ schemaVersion: 1, id: scriptId, projectId, revision: 1, status: "approved", blocks, estimatedDurationMs, createdAt: now, updatedAt: now });
    const shotDrafts = raw.shots.map((shot, index) => {
      const scriptBlock = blocks[Number(shot.scriptBlockIndex)];
      if (!scriptBlock) throw new Error(`第 ${index + 1} 个分镜没有对应脚本段落`);
      return {
        id: `${storyboardId}-shot-${String(index + 1).padStart(2, "0")}`,
        order: index,
        scriptBlockIds: [scriptBlock.id],
        purpose: shot.purpose,
        mode: shot.mode,
        framing: shot.framing || undefined,
        cameraDirection: String(shot.cameraDirection ?? "").trim() || undefined,
        deviceHint: shot.deviceHint,
        orientation: shot.orientation,
        checklist: Array.isArray(shot.checklist) ? shot.checklist : undefined,
        actionDescription: String(shot.actionDescription ?? "").trim(),
        targetMs: Number(shot.targetMs),
        sourceRequirement: shot.sourceRequirement,
      };
    });
    const storyboard = runtime.creation.createStoryboard({ id: storyboardId, script, shots: shotDrafts, createdAt: now });
    runtime.creation.assertLayeredStoryboardCoverage(script, storyboard);
    const tasks = runtime.creation.createShootTasks(storyboard, now);
    const capturePackageDraft = runtime.creation.CapturePackageSchema.parse({ schemaVersion: 1, id: capturePackageId, projectId, storyboardRevision: storyboard.revision, format: "html", relativePath: `capture-packages/${capturePackageId}/index.html`, taskIds: tasks.map((task) => task.id), status: "draft", createdAt: now, updatedAt: now });
    const capturePackage = await runtime.creation.exportCapturePackage({ workspaceRoot: workspace.workspacePath, projectTitle: raw.projectTitle.trim(), capturePackage: capturePackageDraft, storyboard, tasks });
    workspace.catalog.saveCaptureWorkflow({ project: existingProject ? { ...existingProject, title: raw.projectTitle.trim(), stage: "capture", payload: { ...existingProject.payload, scriptId, storyboardId, capturePackageId, taskIds: tasks.map((task) => task.id) }, updatedAt: now } : { id: projectId, workspaceId: workspace.workspaceId, title: raw.projectTitle.trim(), stage: "capture", revision: 1, payload: { scriptId, storyboardId, capturePackageId, taskIds: tasks.map((task) => task.id) }, createdAt: now, updatedAt: now }, script, storyboard, tasks, capturePackage });
    return { ok: true, projectId, script, storyboard, tasks, capturePackage };
  } catch (error) {
    return { ok: false, errorCode: "capture_workflow_failed", message: error instanceof Error ? error.message : "拍摄包生成失败" };
  }
});

ipcMain.handle("desktop:propose-edit", async (_event, request) => {
  try {
    const workspace = requireWorkspace();
    const projectId = typeof request === "string" ? request : request && typeof request.projectId === "string" ? request.projectId : undefined;
    const retryNonce = request && typeof request === "object" && typeof request.retryNonce === "string" && request.retryNonce.length > 0 ? request.retryNonce : undefined;
    if (typeof projectId !== "string" || !projectId) throw new Error("项目 ID 无效");
    const project = workspace.catalog.getProject(projectId);
    if (!project || project.workspaceId !== workspace.workspaceId) throw new Error("项目不存在或不属于当前工作区");
    const payload = project.payload;
    const script = typeof payload.scriptId === "string" ? workspace.catalog.getScript(payload.scriptId) : undefined;
    const storyboard = typeof payload.storyboardId === "string" ? workspace.catalog.getStoryboard(payload.storyboardId) : undefined;
    const taskIds = Array.isArray(payload.taskIds) ? payload.taskIds.filter((taskId) => typeof taskId === "string") : [];
    const tasks = taskIds.map((taskId) => workspace.catalog.getShootTask(taskId)).filter(Boolean);
    if (!script || !storyboard || tasks.length === 0) throw new Error("项目还没有完整的脚本、分镜或拍摄任务");
    const takesByTask = {};
    const assetFacts = {};
    const analysisFactsByAsset = {};
    for (const task of tasks) {
      const takes = workspace.catalog.listTakes(task.id);
      takesByTask[task.id] = takes;
      for (const take of takes) {
        const artifact = workspace.catalog.getArtifact(take.assetId);
        if (artifact) {
          assetFacts[take.assetId] = { contentHash: artifact.contentHash, durationMs: take.durationMs };
          analysisFactsByAsset[take.assetId] = searchCurrentAnalysisFacts(workspace, { workspaceId: workspace.workspaceId, artifactId: take.assetId, limit: 100 });
        }
      }
    }
    const providerKey = configuredEditProvider();
    const modelKey = configuredEditModel();
    const assetCandidates = buildAssetCandidateSuggestions({ workspace, runtime: await getDesktopRuntime(), script, storyboard, tasks });
    const selectedTakeFacts = Object.entries(takesByTask).flatMap(([taskId, takes]) => takes.filter((take) => take.status === "selected").map((take) => ({ taskId, takeId: take.id, assetId: take.assetId, contentHash: assetFacts[take.assetId]?.contentHash, durationMs: assetFacts[take.assetId]?.durationMs, analysisFacts: (analysisFactsByAsset[take.assetId] ?? []).map((fact) => ({ id: fact.id, startMs: fact.startMs, endMs: fact.endMs, contentHash: fact.contentHash })) }))).sort((left, right) => `${left.taskId}:${left.takeId}`.localeCompare(`${right.taskId}:${right.takeId}`));
    const candidateFingerprint = assetCandidates.flatMap((set) => set.candidates.map((candidate) => ({ shotId: set.shotId, assetId: candidate.assetId, contentHash: candidate.contentHash, evidenceIds: candidate.evidenceIds }))).sort((left, right) => `${left.shotId}:${left.assetId}`.localeCompare(`${right.shotId}:${right.assetId}`));
    const inputFingerprint = createHash("sha256").update(JSON.stringify({ projectId, scriptRevision: script.revision, storyboardRevision: storyboard.revision, providerKey, modelKey, retryNonce, selectedTakeFacts, candidateFingerprint })).digest("hex").slice(0, 24);
    const proposalInput = {
      projectId,
      scriptRevision: script.revision,
      storyboardRevision: storyboard.revision,
      providerKey,
      ...(modelKey ? { modelKey } : {}),
      ...(retryNonce ? { retryNonce } : {}),
      selectedTakeFacts,
    };
    const command = {
      schemaVersion: 1,
      commandId: `command-edit-proposal-${randomUUID()}`,
      name: "edit.propose",
      target: { type: "project", id: projectId, expectedRevision: project.revision },
      actor: { type: "user", id: "desktop-user", sessionId: "desktop" },
      idempotencyKey: `edit-proposal:${projectId}:${script.revision}:${storyboard.revision}:${inputFingerprint}`,
      idempotencyScope: workspace.workspaceId,
      correlationId: `run-edit-proposal-${randomUUID()}`,
      input: proposalInput,
    };
    const jobId = `job-${command.correlationId}`;
    const pending = workspace.catalog.executeCommand(command, () => {
      const timestamp = new Date().toISOString();
      workspace.catalog.insertJob({ schemaVersion: 1, id: jobId, kind: "edit.proposal", inputHash: `sha256:${inputFingerprint}`, state: "queued", attempt: 0, idempotencyKey: command.idempotencyKey, idempotencyScope: workspace.workspaceId, providerKey, externalJobId: undefined, artifactIds: [], correlationId: command.correlationId, createdAt: timestamp, updatedAt: timestamp });
      return {
        receipt: { schemaVersion: 1, commandId: command.commandId, correlationId: command.correlationId, status: "pending", target: command.target, jobIds: [jobId], eventIds: [`event-${command.correlationId}-requested`], artifactIds: [], approvalRequired: false },
        events: [{ id: `event-${command.correlationId}-requested`, aggregateType: "project", aggregateId: projectId, aggregateRevision: project.revision, type: "edit.proposal.requested", payload: { jobId, providerKey, modelKey }, actorType: "user", idempotencyKey: command.idempotencyKey, correlationId: command.correlationId, occurredAt: timestamp }],
        outbox: [],
      };
    });
    const storedPending = workspace.catalog.getReceipt(workspace.workspaceId, command.idempotencyKey)?.receipt ?? pending;
    if (pending.status === "duplicate") {
      const proposalId = proposalIdFromReceipt(storedPending);
      const cachedProposal = proposalId ? workspace.catalog.getEditProposal(proposalId) : undefined;
      const cachedMissing = storedPending.errorDetails && typeof storedPending.errorDetails === "object" && Array.isArray(storedPending.errorDetails.missing) ? storedPending.errorDetails.missing : [];
      return { ok: Boolean(cachedProposal), status: cachedProposal ? "ready" : storedPending.status === "pending" ? "pending" : "needs_material", receipt: storedPending, idempotencyScope: workspace.workspaceId, idempotencyKey: command.idempotencyKey, proposal: cachedProposal, missing: cachedMissing, analysisFacts: Object.values(analysisFactsByAsset).flat(), assetCandidates, provider: storedPending.errorDetails?.provider };
    }
    const finishFailure = (failure, from, leaseToken, cancelled = false) => {
      const targetStatus = failure.submissionUnknown ? "pending" : "rejected";
      const nextJobState = failure.submissionUnknown ? "submission_unknown" : cancelled ? "cancelled" : "failed";
      const receipt = workspace.catalog.finalizeCommand(command, () => {
        if (!workspace.catalog.transitionJob(jobId, from, nextJobState, leaseToken, { lastError: { code: failure.code, message: failure.message, retryable: failure.retryable } })) throw new Error("AI 提案任务失败状态未能持久化");
        return {
          receipt: { schemaVersion: 1, commandId: command.commandId, correlationId: command.correlationId, status: targetStatus, target: command.target, jobIds: [jobId], eventIds: [`event-${command.correlationId}-failed`], artifactIds: [], approvalRequired: false, errorCode: failure.submissionUnknown ? "SUBMISSION_UNKNOWN" : failure.code, errorDetails: { state: nextJobState, provider: { providerKey, modelKey }, message: failure.message } },
          events: [{ id: `event-${command.correlationId}-failed`, aggregateType: "project", aggregateId: projectId, aggregateRevision: project.revision, type: failure.submissionUnknown ? "edit.proposal.submission_unknown" : "edit.proposal.failed", payload: { jobId, state: nextJobState, providerKey, message: failure.message }, actorType: "system", idempotencyKey: command.idempotencyKey, correlationId: command.correlationId, occurredAt: new Date().toISOString() }],
        };
      });
      return { ok: false, status: targetStatus === "pending" ? "pending" : "failed", receipt, idempotencyScope: workspace.workspaceId, idempotencyKey: command.idempotencyKey, jobId, provider: { providerKey, modelKey }, assetCandidates, errorCode: failure.submissionUnknown ? "SUBMISSION_UNKNOWN" : failure.code, message: failure.submissionUnknown ? "Provider 请求提交状态未知；已停止自动重试，请先核对用量后再决定是否重新发起。" : failure.message };
    };
    const leaseToken = workspace.catalog.claimJob(jobId, "agent-main", new Date(), 120_000);
    if (!leaseToken || !workspace.catalog.heartbeatJob(jobId, "agent-main", leaseToken, new Date(), 120_000)) return finishFailure({ code: "LEASE_UNAVAILABLE", message: "AI 提案任务无法取得本地租约", submissionUnknown: false, retryable: true }, "queued", undefined, true);
    let result;
    try {
      const runtime = await getDesktopRuntime();
      result = await getEditAgent(runtime).proposeEdit({ projectId, script, storyboard, tasks, takesByTask, assetFacts, analysisFacts: analysisFactsByAsset, now: new Date().toISOString() });
    } catch (error) {
      return finishFailure(proposalFailure(error, providerKey), "running", leaseToken);
    }
    const completed = workspace.catalog.finalizeCommand(command, () => {
      if (result.status === "ready" && result.proposal && !workspace.catalog.saveEditProposal(result.proposal)) throw new Error("剪辑提案版本保存失败");
      if (!workspace.catalog.transitionJob(jobId, "running", "succeeded", leaseToken, { checkpoint: { providerKey: result.provider.providerKey, modelKey: result.provider.modelKey, responseHash: result.provider.responseHash, status: result.status } })) throw new Error("AI 提案任务完成状态未能持久化");
      return {
        receipt: { schemaVersion: 1, commandId: command.commandId, correlationId: command.correlationId, status: "accepted", target: command.target, jobIds: [jobId], eventIds: [`event-${command.correlationId}-completed`], artifactIds: [], approvalRequired: false, errorDetails: { proposalId: result.proposal?.id, missing: result.missing, provider: result.provider } },
        events: [{ id: `event-${command.correlationId}-completed`, aggregateType: "project", aggregateId: projectId, aggregateRevision: project.revision, type: "edit.proposal.completed", payload: { jobId, proposalId: result.proposal?.id, status: result.status, provider: result.provider }, actorType: "system", idempotencyKey: command.idempotencyKey, correlationId: command.correlationId, occurredAt: new Date().toISOString() }],
      };
    });
    return { ok: true, ...result, analysisFacts: Object.values(analysisFactsByAsset).flat(), assetCandidates, receipt: completed, idempotencyScope: workspace.workspaceId, idempotencyKey: command.idempotencyKey, jobId, project: { id: project.id, title: project.title } };
  } catch (error) {
    return { ok: false, errorCode: "edit_proposal_failed", message: error instanceof Error ? error.message : "AI 剪辑提案生成失败" };
  }
});

ipcMain.handle("desktop:reconcile-edit-proposal", async (_event, raw) => {
  try {
    const workspace = requireWorkspace();
    if (!raw || typeof raw.idempotencyKey !== "string" || typeof raw.idempotencyScope !== "string" || raw.idempotencyScope !== workspace.workspaceId || raw.action !== "user_confirmed_not_submitted") throw new Error("人工恢复参数无效");
    const stored = workspace.catalog.getReceipt(raw.idempotencyScope, raw.idempotencyKey);
    if (!stored || stored.receipt.status !== "pending" || stored.receipt.errorCode !== "SUBMISSION_UNKNOWN") throw new Error("当前回执不是可人工处理的提交未知状态");
    const jobId = stored.receipt.jobIds[0];
    const retryNonce = randomUUID();
    const receipt = workspace.catalog.reconcilePendingCommand(raw.idempotencyScope, raw.idempotencyKey, (previous) => {
      const job = jobId ? workspace.catalog.getJob(jobId) : undefined;
      if (!job || job.state !== "submission_unknown") throw new Error("AI 提案任务不在 submission_unknown 状态");
      if (!workspace.catalog.transitionJob(job.id, "submission_unknown", "needs_attention", undefined, { lastError: { code: "SUBMISSION_UNKNOWN_RECONCILED", message: "用户已核对 Provider 用量，确认不再自动重试。", retryable: false } })) throw new Error("AI 提案任务无法进入人工处理状态");
      if (!workspace.catalog.transitionJob(job.id, "needs_attention", "failed", undefined, { lastError: { code: "SUBMISSION_UNKNOWN_RECONCILED", message: "用户已核对 Provider 用量，确认不再自动重试。", retryable: false } })) throw new Error("AI 提案任务无法收口");
      return {
        receipt: { ...previous, status: "rejected", errorCode: "SUBMISSION_UNKNOWN_RECONCILED", errorDetails: { ...(previous.errorDetails ?? {}), action: raw.action, retryNonce, reconciledAt: new Date().toISOString() }, eventIds: [...previous.eventIds, `event-${previous.correlationId}-reconciled`] },
        events: [{ id: `event-${previous.correlationId}-reconciled`, aggregateType: "project", aggregateId: previous.target.id, aggregateRevision: previous.target.expectedRevision ?? 0, type: "edit.proposal.submission_unknown.reconciled", payload: { jobId, action: raw.action, retryNonce }, actorType: "user", idempotencyKey: raw.idempotencyKey, correlationId: previous.correlationId, occurredAt: new Date().toISOString() }],
      };
    });
    return { ok: true, receipt, retryNonce, message: "已结束这次未知提交；下一次请求会使用新的幂等键。" };
  } catch (error) {
    return { ok: false, errorCode: "edit_proposal_reconcile_failed", message: error instanceof Error ? error.message : "人工恢复失败" };
  }
});

ipcMain.handle("desktop:list-edit-proposal-recoveries", async (_event, projectId) => {
  try {
    const workspace = requireWorkspace();
    if (typeof projectId !== "string" || !projectId) throw new Error("项目 ID 无效");
    const items = workspace.catalog.listPendingCommandReceipts(workspace.workspaceId, "project", projectId, "SUBMISSION_UNKNOWN").flatMap((stored) => {
      const jobId = stored.receipt.jobIds[0];
      const job = jobId ? workspace.catalog.getJob(jobId) : undefined;
      if (!job || job.state !== "submission_unknown") return [];
      return [{ idempotencyScope: stored.idempotencyScope, idempotencyKey: stored.idempotencyKey, receipt: stored.receipt, job: { id: job.id, state: job.state, attempt: job.attempt } }];
    });
    return { ok: true, items };
  } catch (error) {
    return { ok: false, errorCode: "edit_proposal_recovery_list_failed", message: error instanceof Error ? error.message : "无法读取 AI 提案恢复状态" };
  }
});

ipcMain.handle("desktop:render-edit", async (_event, raw) => {
  let renderId = null;
  let renderRunId = null;
  let renderJobId = null;
  let renderJobLeaseToken = null;
  let renderWorkspace = null;
  let renderRuntime = null;
  let freezeReceipt = null;
  let frozenSpec = null;
  try {
    const workspace = requireWorkspace();
    renderWorkspace = workspace;
    if (!raw || typeof raw.projectId !== "string" || !raw.proposal) throw new Error("剪辑提案参数无效");
    const runtime = await getDesktopRuntime();
    renderRuntime = runtime;
    const proposal = runtime.exchange.EditProposalSchema.parse(raw.proposal);
    const project = workspace.catalog.getProject(raw.projectId);
    if (!project || project.workspaceId !== workspace.workspaceId) throw new Error("项目不存在或不属于当前工作区");
    const payload = project.payload;
    const taskIds = Array.isArray(payload.taskIds) ? payload.taskIds.filter((taskId) => typeof taskId === "string") : [];
    const takes = taskIds.flatMap((taskId) => workspace.catalog.listTakes(taskId));
    const takeByAssetId = new Map(takes.map((take) => [take.assetId, take]));
    const assets = {};
    for (const operation of proposal.operations.filter((operation) => operation.status !== "rejected")) {
      const artifact = workspace.catalog.getArtifact(operation.sourceAssetId);
      const take = takeByAssetId.get(operation.sourceAssetId);
      if (!artifact || !take || !take.durationMs) throw new Error(`素材事实不完整：${operation.sourceAssetId}`);
      const absolutePath = path.resolve(workspace.workspacePath, artifact.relativePath);
      const workspaceRoot = realpathSync(workspace.workspacePath);
      if (!existsSync(absolutePath)) throw new Error(`素材文件不存在：${operation.sourceAssetId}`);
      const canonicalAssetPath = realpathSync(absolutePath);
      if (canonicalAssetPath !== workspaceRoot && !canonicalAssetPath.startsWith(`${workspaceRoot}${path.sep}`)) throw new Error(`素材路径越过工作区：${operation.sourceAssetId}`);
      const probe = await new runtime.media.FfmpegToolchain().probe(canonicalAssetPath).catch(() => null);
      assets[operation.sourceAssetId] = { assetId: operation.sourceAssetId, relativePath: artifact.relativePath, absolutePath: canonicalAssetPath, contentHash: artifact.contentHash, durationMs: take.durationMs, hasVideo: true, hasAudio: probe ? probe.streams.some((stream) => stream.kind === "audio") : true };
    }
    const assetLocks = Object.values(assets).map((asset) => ({ assetId: asset.assetId, contentHash: asset.contentHash }));
    // The user-facing action is “确认并导出”, but the first durable boundary
    // is the freeze command.  Rendering may be retried independently after a
    // crash; the accepted spec and its receipt must already exist.
    const freezeNow = proposal.updatedAt;
    const freezeInput = {
      projectId: raw.projectId,
      proposalId: proposal.id,
      proposalUpdatedAt: proposal.updatedAt,
      operationDecisions: proposal.operations.map((operation) => ({ id: operation.id, status: operation.status })),
      assetLocks: [...assetLocks].sort((left, right) => left.assetId.localeCompare(right.assetId)),
      freezeNow,
    };
    const freezeFingerprint = createHash("sha256").update(JSON.stringify(freezeInput)).digest("hex").slice(0, 24);
    const freezeCommand = {
      schemaVersion: 1,
      commandId: `command-edit-freeze-${randomUUID()}`,
      name: "edit.freeze",
      target: { type: "project", id: raw.projectId, expectedRevision: project.revision },
      actor: { type: "user", id: "desktop-user", sessionId: "desktop" },
      idempotencyKey: `edit-freeze:${raw.projectId}:${proposal.id}:${freezeFingerprint}`,
      idempotencyScope: workspace.workspaceId,
      correlationId: `run-edit-freeze-${randomUUID()}`,
      input: freezeInput,
    };
    const pendingFreeze = workspace.catalog.executeCommand(freezeCommand, () => ({
      receipt: { schemaVersion: 1, commandId: freezeCommand.commandId, correlationId: freezeCommand.correlationId, status: "pending", target: freezeCommand.target, eventIds: [`event-${freezeCommand.correlationId}-requested`], jobIds: [], artifactIds: [], approvalRequired: false },
      events: [{ id: `event-${freezeCommand.correlationId}-requested`, aggregateType: "project", aggregateId: raw.projectId, aggregateRevision: project.revision, type: "edit.freeze.requested", payload: { proposalId: proposal.id, assetCount: assetLocks.length }, actorType: "user", idempotencyKey: freezeCommand.idempotencyKey, correlationId: freezeCommand.correlationId, occurredAt: new Date().toISOString() }],
    }));
    const storedFreeze = workspace.catalog.getReceipt(workspace.workspaceId, freezeCommand.idempotencyKey)?.receipt ?? pendingFreeze;
    if (storedFreeze.status === "accepted") {
      const storedSpecId = storedFreeze.errorDetails && typeof storedFreeze.errorDetails === "object" ? storedFreeze.errorDetails.frozenEditSpecId : undefined;
      if (typeof storedSpecId !== "string") throw new Error("冻结回执缺少 FrozenEditSpec 引用");
      frozenSpec = workspace.catalog.getFrozenEditSpec(storedSpecId);
      if (!frozenSpec) throw new Error("冻结回执引用的 FrozenEditSpec 不存在");
      freezeReceipt = storedFreeze;
    } else if (storedFreeze.status === "rejected") {
      freezeReceipt = storedFreeze;
      const details = storedFreeze.errorDetails && typeof storedFreeze.errorDetails === "object" ? storedFreeze.errorDetails.message : undefined;
      throw Object.assign(new Error(typeof details === "string" ? details : "冻结剪辑规格失败"), { code: storedFreeze.errorCode ?? "EDIT_FREEZE_FAILED" });
    } else {
      const commandToFinalize = storedFreeze.status === "pending" && storedFreeze.commandId !== freezeCommand.commandId
        ? { ...freezeCommand, commandId: storedFreeze.commandId, correlationId: storedFreeze.correlationId }
        : freezeCommand;
      try {
        freezeReceipt = workspace.catalog.finalizeCommand(commandToFinalize, (command, previous) => {
          const frozen = runtime.exchange.freezeEditProposal({ proposal, assetLocks, now: freezeNow });
          if (!workspace.catalog.saveEditProposal(proposal)) throw new Error("剪辑提案版本保存失败");
          if (!workspace.catalog.saveFrozenEditSpec(frozen)) throw new Error("冻结剪辑规格版本冲突");
          frozenSpec = frozen;
          return {
            receipt: { schemaVersion: 1, commandId: command.commandId, correlationId: command.correlationId, status: "accepted", target: command.target, eventIds: [`event-${command.correlationId}-completed`], jobIds: [], artifactIds: [], approvalRequired: false, errorDetails: { frozenEditSpecId: frozen.id, sourceProposalId: proposal.id, authoredSpecHash: frozen.authoredSpecHash } },
            events: [{ id: `event-${command.correlationId}-completed`, aggregateType: "project", aggregateId: raw.projectId, aggregateRevision: project.revision, type: "edit.freeze.completed", payload: { proposalId: proposal.id, frozenEditSpecId: frozen.id, authoredSpecHash: frozen.authoredSpecHash }, actorType: "system", idempotencyKey: freezeCommand.idempotencyKey, correlationId: command.correlationId, causationId: previous.correlationId, occurredAt: new Date().toISOString() }],
          };
        });
        if (freezeReceipt.status === "duplicate") {
          const duplicateSpecId = freezeReceipt.errorDetails && typeof freezeReceipt.errorDetails === "object" ? freezeReceipt.errorDetails.frozenEditSpecId : undefined;
          if (typeof duplicateSpecId !== "string") throw new Error("重复冻结回执缺少 FrozenEditSpec 引用");
          frozenSpec = workspace.catalog.getFrozenEditSpec(duplicateSpecId);
          if (!frozenSpec) throw new Error("重复冻结回执引用的 FrozenEditSpec 不存在");
        }
      } catch (error) {
        // freezeEditProposal is pure, but persistence can still fail (schema,
        // revision, disk full). Convert that failure into a durable rejected
        // receipt while the pending command is still recoverable.
        const message = error instanceof Error ? error.message : "冻结剪辑规格失败";
        freezeReceipt = workspace.catalog.finalizeCommand(commandToFinalize, (command, previous) => ({
          receipt: { schemaVersion: 1, commandId: command.commandId, correlationId: command.correlationId, status: "rejected", target: command.target, eventIds: [`event-${command.correlationId}-failed`], jobIds: [], artifactIds: [], approvalRequired: false, errorCode: "EDIT_FREEZE_FAILED", errorDetails: { message, sourceProposalId: proposal.id } },
          events: [{ id: `event-${command.correlationId}-failed`, aggregateType: "project", aggregateId: raw.projectId, aggregateRevision: project.revision, type: "edit.freeze.failed", payload: { proposalId: proposal.id, message }, actorType: "system", idempotencyKey: freezeCommand.idempotencyKey, correlationId: command.correlationId, causationId: previous.correlationId, occurredAt: new Date().toISOString() }],
        }));
        throw Object.assign(new Error(message), { code: "EDIT_FREEZE_FAILED" });
      }
    }
    if (!frozenSpec) throw new Error("冻结剪辑规格没有生成");
    renderId = `render-${raw.projectId}-${randomUUID().slice(0, 8)}`;
    const frozen = frozenSpec;
    renderRunId = `render-${raw.projectId}-${randomUUID().slice(0, 8)}`;
    const renderNow = new Date().toISOString();
    workspace.catalog.saveRenderRun({ schemaVersion: 1, id: renderRunId, projectId: raw.projectId, frozenEditSpecId: frozen.id, state: "running", createdAt: renderNow, updatedAt: renderNow });
    renderJobId = `job-${renderRunId}`;
    workspace.catalog.insertJob({
      schemaVersion: 1,
      id: renderJobId,
      kind: "edit.render",
      inputHash: `sha256:${createHash("sha256").update(JSON.stringify({ projectId: raw.projectId, proposalId: proposal.id, assetLocks })).digest("hex")}`,
      state: "queued",
      attempt: 0,
      idempotencyKey: renderRunId,
      idempotencyScope: workspace.workspaceId,
      correlationId: renderRunId,
      artifactIds: [],
      createdAt: renderNow,
      updatedAt: renderNow,
    });
    renderJobLeaseToken = workspace.catalog.claimJob(renderJobId, "render-main", new Date(renderNow), 10 * 60 * 1000);
    if (!renderJobLeaseToken || !workspace.catalog.heartbeatJob(renderJobId, "render-main", renderJobLeaseToken, new Date(renderNow), 10 * 60 * 1000)) throw new Error("渲染任务无法取得本地租约");
    const result = await runtime.exchange.exportRenderPackage({ workspaceRoot: workspace.workspacePath, renderId, frozenEditSpec: frozen, assets });
    const parentArtifactIds = assetLocks.map((lock) => lock.assetId);
    const outputArtifacts = result.manifest.outputs.map((output) => ({
      schemaVersion: 1,
      artifactId: `artifact-${renderId}-${output.kind}`,
      workspaceId: workspace.workspaceId,
      kind: `render-${output.kind}`,
      relativePath: output.relativePath,
      mimeType: output.mimeType,
      contentHash: output.contentHash,
      byteSize: output.byteSize,
      parentArtifactIds,
      validationStatus: "valid",
    }));
    outputArtifacts.push({
      schemaVersion: 1,
      artifactId: `artifact-${renderId}-manifest`,
      workspaceId: workspace.workspaceId,
      kind: "render-manifest",
      relativePath: path.relative(workspace.workspacePath, result.manifestPath).split(path.sep).join("/"),
      mimeType: "application/json",
      contentHash: result.manifestHash,
      byteSize: result.manifestByteSize,
      parentArtifactIds,
      validationStatus: "valid",
    });
    workspace.catalog.insertArtifacts(outputArtifacts);
    const outputArtifactIds = outputArtifacts.map((artifact) => artifact.artifactId);
    if (!workspace.catalog.transitionJob(renderJobId, "running", "succeeded", renderJobLeaseToken, { artifactIds: outputArtifactIds, checkpoint: { renderRunId, manifestHash: result.manifestHash, outputCount: outputArtifactIds.length } })) throw new Error("渲染任务完成状态未能持久化");
    workspace.catalog.saveRenderRun({ schemaVersion: 1, id: renderRunId, projectId: raw.projectId, frozenEditSpecId: frozen.id, state: "succeeded", manifestRelativePath: path.relative(workspace.workspacePath, result.manifestPath).split(path.sep).join("/"), manifestHash: result.manifestHash, createdAt: renderNow, updatedAt: new Date().toISOString() });
    return { ok: true, freezeReceipt, frozenEditSpecId: frozen.id, renderId, renderRunId, jobId: renderJobId, artifactIds: outputArtifactIds, manifest: result.manifest, files: { video: path.relative(workspace.workspacePath, result.outputPath).split(path.sep).join("/"), subtitle: result.subtitlePath ? path.relative(workspace.workspacePath, result.subtitlePath).split(path.sep).join("/") : null, manifest: path.relative(workspace.workspacePath, result.manifestPath).split(path.sep).join("/") } };
  } catch (error) {
    if (renderJobId && renderJobLeaseToken && renderWorkspace) {
      try {
        renderWorkspace.catalog.transitionJob(renderJobId, "running", "failed", renderJobLeaseToken, { lastError: { code: "EDIT_RENDER_FAILED", message: error instanceof Error ? error.message : "AI 剪辑导出失败", retryable: true } });
      } catch {
        // If the lease expired, recovery will leave the job inspectable instead of overwriting a newer worker.
      }
    }
    if (renderRunId && renderWorkspace && renderRuntime) {
      const message = error instanceof Error ? error.message : "AI 剪辑导出失败";
      try {
        const current = renderWorkspace.catalog.getRenderRun(renderRunId);
        if (current) renderWorkspace.catalog.saveRenderRun({ ...current, state: "failed", error: { code: "edit_render_failed", message }, updatedAt: new Date().toISOString() });
      } catch {
        // Preserve the original render error; recovery can inspect a running run after restart.
      }
    }
    return { ok: false, errorCode: error && typeof error === "object" && "code" in error ? String(error.code) : "edit_render_failed", freezeReceipt, renderId, renderRunId, jobId: renderJobId, message: error instanceof Error ? error.message : "AI 剪辑导出失败" };
  }
});

ipcMain.handle("desktop:list-render-recoveries", async (_event, projectId) => {
  try {
    const workspace = requireWorkspace();
    if (typeof projectId !== "string" || !projectId) throw new Error("项目 ID 无效");
    const project = workspace.catalog.getProject(projectId);
    if (!project || project.workspaceId !== workspace.workspaceId) throw new Error("项目不存在或不属于当前工作区");
    const items = workspace.catalog.listRenderRunsForProject(projectId).flatMap((renderRun) => {
      const job = workspace.catalog.getJob(`job-${renderRun.id}`);
      if (!job || job.state === "succeeded" || job.state === "cancelled") return [];
      return [{ renderRun, job: { id: job.id, state: job.state, attempt: job.attempt, lastError: job.lastError } }];
    });
    return { ok: true, items };
  } catch (error) {
    return { ok: false, errorCode: "render_recovery_list_failed", message: error instanceof Error ? error.message : "无法读取渲染恢复状态" };
  }
});

ipcMain.handle("desktop:retry-render", async (_event, raw) => {
  let workspace = null;
  let runtime = null;
  let renderRun = null;
  let job = null;
  let leaseToken = null;
  try {
    workspace = requireWorkspace();
    if (!raw || typeof raw.projectId !== "string" || typeof raw.renderRunId !== "string") throw new Error("渲染重试参数无效");
    const project = workspace.catalog.getProject(raw.projectId);
    if (!project || project.workspaceId !== workspace.workspaceId) throw new Error("项目不存在或不属于当前工作区");
    renderRun = workspace.catalog.getRenderRun(raw.renderRunId);
    if (!renderRun || renderRun.projectId !== raw.projectId) throw new Error("渲染运行不存在或不属于当前项目");
    const frozen = workspace.catalog.getFrozenEditSpec(renderRun.frozenEditSpecId);
    if (!frozen || frozen.projectId !== raw.projectId) throw new Error("渲染重试对应的 FrozenEditSpec 不存在");
    const jobId = `job-${renderRun.id}`;
    job = workspace.catalog.getJob(jobId);
    if (!job) throw new Error("渲染重试对应的 Job 不存在");
    if (job.state === "succeeded") throw new Error("这次渲染已经成功，无需重试");
    if (["claimed", "running"].includes(job.state)) return { ok: false, status: "running", renderRunId: renderRun.id, jobId, message: "渲染任务仍在运行，请等待当前任务完成。" };
    if (["failed", "timed_out"].includes(job.state)) {
      if (!workspace.catalog.transitionJob(job.id, job.state, "retry_wait", undefined, { retryAfter: new Date().toISOString(), lastError: undefined })) throw new Error("失败渲染任务无法进入重试队列");
      job = workspace.catalog.getJob(job.id);
    }
    if (job?.state === "needs_attention") {
      if (!workspace.catalog.transitionJob(job.id, "needs_attention", "queued", undefined, { lastError: undefined })) throw new Error("需要人工处理的渲染任务无法重新排队");
      job = workspace.catalog.getJob(job.id);
    }
    if (job?.state === "retry_wait") {
      if (!workspace.catalog.transitionJob(job.id, "retry_wait", "queued")) throw new Error("渲染任务无法重新排队");
      job = workspace.catalog.getJob(job.id);
    }
    if (!job || job.state !== "queued") throw new Error(`当前渲染状态不可重试：${job?.state ?? "unknown"}`);
    const now = new Date();
    leaseToken = workspace.catalog.claimJob(job.id, "render-main", now, 10 * 60 * 1000);
    if (!leaseToken || !workspace.catalog.heartbeatJob(job.id, "render-main", leaseToken, new Date(), 10 * 60 * 1000)) throw new Error("渲染重试任务无法取得本地租约");
    job = workspace.catalog.getJob(job.id);
    if (!job) throw new Error("渲染重试 Job 在取得租约后消失");
    runtime = await getDesktopRuntime();
    const assets = await resolveFrozenRenderAssets({ workspace, runtime, frozen });
    const renderId = `${renderRun.id}-attempt-${job.attempt}`;
    const renderNow = new Date().toISOString();
    workspace.catalog.saveRenderRun({ ...renderRun, state: "running", error: undefined, updatedAt: renderNow });
    const result = await runtime.exchange.exportRenderPackage({ workspaceRoot: workspace.workspacePath, renderId, frozenEditSpec: frozen, assets });
    const parentArtifactIds = frozen.assetLocks.map((lock) => lock.assetId);
    const outputArtifacts = renderOutputArtifacts({ workspace, renderId, result, parentArtifactIds });
    workspace.catalog.insertArtifacts(outputArtifacts);
    if (!workspace.catalog.transitionJob(job.id, "running", "succeeded", leaseToken, { artifactIds: outputArtifacts.map((artifact) => artifact.artifactId), checkpoint: { renderRunId: renderRun.id, renderId, manifestHash: result.manifestHash, outputCount: outputArtifacts.length } })) throw new Error("渲染重试完成状态未能持久化");
    workspace.catalog.saveRenderRun({ ...renderRun, state: "succeeded", manifestRelativePath: path.relative(workspace.workspacePath, result.manifestPath).split(path.sep).join("/"), manifestHash: result.manifestHash, updatedAt: new Date().toISOString() });
    return { ok: true, frozenEditSpecId: frozen.id, renderId, renderRunId: renderRun.id, jobId: job.id, artifactIds: outputArtifacts.map((artifact) => artifact.artifactId), manifest: result.manifest, files: { video: path.relative(workspace.workspacePath, result.outputPath).split(path.sep).join("/"), subtitle: result.subtitlePath ? path.relative(workspace.workspacePath, result.subtitlePath).split(path.sep).join("/") : null, manifest: path.relative(workspace.workspacePath, result.manifestPath).split(path.sep).join("/") } };
  } catch (error) {
    const message = error instanceof Error ? error.message : "AI 剪辑重试失败";
    if (workspace && job && leaseToken) {
      try {
        workspace.catalog.transitionJob(job.id, "running", "failed", leaseToken, { lastError: { code: "EDIT_RENDER_RETRY_FAILED", message, retryable: true } });
      } catch {
        // A stale lease is intentionally not allowed to overwrite a newer worker.
      }
    }
    if (workspace && renderRun) {
      try {
        const current = workspace.catalog.getRenderRun(renderRun.id);
        if (current) workspace.catalog.saveRenderRun({ ...current, state: "failed", error: { code: "edit_render_retry_failed", message }, updatedAt: new Date().toISOString() });
      } catch {
        // Keep the original failure observable in the Job when persistence itself fails.
      }
    }
    return { ok: false, errorCode: "edit_render_retry_failed", renderRunId: renderRun?.id, jobId: job?.id, message };
  }
});

ipcMain.handle("desktop:export-exchange", async (_event, raw) => {
  try {
    const workspace = requireWorkspace();
    if (!raw || typeof raw.renderRunId !== "string" || !Array.isArray(raw.formats)) throw new Error("交换格式导出参数无效");
    const formats = [...new Set(raw.formats.filter((format) => format === "fcpxml" || format === "otio"))];
    if (formats.length === 0 || formats.length > 2) throw new Error("请选择 FCPXML 或 OTIO");
    const run = workspace.catalog.getRenderRun(raw.renderRunId);
    if (!run || run.state !== "succeeded") throw new Error("只有成功的渲染结果才能导出交换格式");
    const spec = workspace.catalog.getFrozenEditSpec(run.frozenEditSpecId);
    if (!spec || spec.projectId !== run.projectId) throw new Error("冻结剪辑规格不存在");
    const runtime = await getDesktopRuntime();
    const assets = {};
    for (const lock of spec.assetLocks) {
      const artifact = workspace.catalog.getArtifact(lock.assetId);
      if (!artifact) throw new Error(`交换导出缺少素材：${lock.assetId}`);
      const absolutePath = path.resolve(workspace.workspacePath, artifact.relativePath);
      const root = realpathSync(workspace.workspacePath);
      if (!existsSync(absolutePath)) throw new Error(`交换导出素材文件不存在：${lock.assetId}`);
      const canonicalPath = realpathSync(absolutePath);
      if (canonicalPath !== root && !canonicalPath.startsWith(`${root}${path.sep}`)) throw new Error(`交换导出素材越过工作区：${lock.assetId}`);
      const probe = await new runtime.media.FfmpegToolchain().probe(canonicalPath);
      if (!probe.durationMs || probe.durationMs <= 0) throw new Error(`交换导出素材没有有效时长：${lock.assetId}`);
      assets[lock.assetId] = { assetId: lock.assetId, relativePath: artifact.relativePath, absolutePath: canonicalPath, contentHash: artifact.contentHash, durationMs: probe.durationMs, hasAudio: probe.streams.some((stream) => stream.kind === "audio") };
    }
    const ir = runtime.exchange.compileFrozenEditSpec({ spec, assets });
    const outputs = {};
    for (const format of formats) {
      const exchange = format === "fcpxml" ? runtime.exchange.exportFcpXml({ ir, workspaceRoot: workspace.workspacePath }) : runtime.exchange.exportOtio({ ir, workspaceRoot: workspace.workspacePath });
      const relativePath = `exports/${raw.renderRunId}.${format === "fcpxml" ? "fcpxml" : "otio.json"}`;
      const lossRelativePath = `${relativePath}.loss.json`;
      const outputPath = path.resolve(workspace.workspacePath, relativePath);
      const lossPath = path.resolve(workspace.workspacePath, lossRelativePath);
      const root = realpathSync(workspace.workspacePath);
      for (const target of [outputPath, lossPath]) if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error("交换导出路径越过工作区");
      await makeDirectory(path.dirname(outputPath), { recursive: true });
      await writeFile(outputPath, exchange.body, "utf8");
      await writeFile(lossPath, `${JSON.stringify(exchange.report, null, 2)}\n`, "utf8");
      const outputHash = await runtime.media.sha256File(outputPath);
      const lossHash = await runtime.media.sha256File(lossPath);
      const parentArtifactIds = spec.assetLocks.map((lock) => lock.assetId);
      workspace.catalog.insertArtifacts([
        { schemaVersion: 1, artifactId: `exchange-${raw.renderRunId}-${format}`, workspaceId: workspace.workspaceId, kind: `exchange-${format}`, relativePath, mimeType: format === "fcpxml" ? "application/xml" : "application/json", contentHash: outputHash, byteSize: Buffer.byteLength(exchange.body), parentArtifactIds, validationStatus: "valid" },
        { schemaVersion: 1, artifactId: `exchange-${raw.renderRunId}-${format}-loss`, workspaceId: workspace.workspaceId, kind: "exchange-loss-report", relativePath: lossRelativePath, mimeType: "application/json", contentHash: lossHash, byteSize: Buffer.byteLength(JSON.stringify(exchange.report)), parentArtifactIds: [`exchange-${raw.renderRunId}-${format}`], validationStatus: "valid" },
      ]);
      outputs[format] = { relativePath, lossReportPath: lossRelativePath, report: exchange.report };
    }
    return { ok: true, renderRunId: raw.renderRunId, outputs };
  } catch (error) {
    return { ok: false, errorCode: "exchange_export_failed", message: error instanceof Error ? error.message : "交换格式导出失败" };
  }
});

ipcMain.handle("desktop:create-publish-package", async (_event, raw) => {
  try {
    const workspace = requireWorkspace();
    if (!raw || typeof raw.renderRunId !== "string" || typeof raw.title !== "string" || !raw.title.trim()) throw new Error("发布包参数无效");
    const run = workspace.catalog.getRenderRun(raw.renderRunId);
    if (!run || run.state !== "succeeded" || !run.manifestRelativePath) throw new Error("只有成功的渲染结果才能生成发布包");
    const spec = workspace.catalog.getFrozenEditSpec(run.frozenEditSpecId);
    if (!spec || spec.projectId !== run.projectId) throw new Error("发布包对应的冻结剪辑规格不存在");
    const runtime = await getDesktopRuntime();
    const manifestPath = path.resolve(workspace.workspacePath, run.manifestRelativePath);
    const root = realpathSync(workspace.workspacePath);
    if (!existsSync(manifestPath)) throw new Error("渲染 manifest 文件不存在");
    const canonicalManifestPath = realpathSync(manifestPath);
    if (canonicalManifestPath !== root && !canonicalManifestPath.startsWith(`${root}${path.sep}`)) throw new Error("渲染 manifest 越过工作区");
    const renderManifest = runtime.exchange.RenderManifestSchema.parse(JSON.parse(await readFile(canonicalManifestPath, "utf8")));
    const video = renderManifest.outputs.find((output) => output.kind === "video");
    if (!video) throw new Error("渲染 manifest 缺少视频输出");
    const subtitle = renderManifest.outputs.find((output) => output.kind === "subtitle");
    const packageId = `publish-${raw.renderRunId}`;
    const result = await runtime.publishing.exportPublishPackage({
      workspaceRoot: workspace.workspacePath,
      packageId,
      projectId: run.projectId,
      renderRunId: raw.renderRunId,
      platform: typeof raw.platform === "string" && raw.platform.trim() ? raw.platform.trim() : "抖音",
      title: raw.title.trim(),
      description: typeof raw.description === "string" ? raw.description : "",
      hashtags: Array.isArray(raw.hashtags) ? raw.hashtags.filter((tag) => typeof tag === "string") : [],
      rightsNote: typeof raw.rightsNote === "string" ? raw.rightsNote : undefined,
      sourceArtifactIds: spec.assetLocks.map((lock) => lock.assetId),
      sourceFiles: { video: path.resolve(workspace.workspacePath, video.relativePath), subtitle: subtitle ? path.resolve(workspace.workspacePath, subtitle.relativePath) : undefined, manifest: canonicalManifestPath },
    });
    const artifactIds = result.files.map((file) => `publish-${raw.renderRunId}-${file.kind}`);
    const manifestStats = await statFile(result.manifestPath);
    const manifestHash = await runtime.media.sha256File(result.manifestPath);
    workspace.catalog.insertArtifacts([
      ...result.files.map((file, index) => ({ schemaVersion: 1, artifactId: artifactIds[index], workspaceId: workspace.workspaceId, kind: `publish-${file.kind}`, relativePath: file.relativePath, mimeType: file.mimeType, contentHash: file.contentHash, byteSize: file.byteSize, parentArtifactIds: spec.assetLocks.map((lock) => lock.assetId), validationStatus: "valid" })),
      { schemaVersion: 1, artifactId: `publish-${raw.renderRunId}-package-manifest`, workspaceId: workspace.workspaceId, kind: "publish-package-manifest", relativePath: path.relative(workspace.workspacePath, result.manifestPath).split(path.sep).join("/"), mimeType: "application/json", contentHash: manifestHash, byteSize: manifestStats.size, parentArtifactIds: artifactIds, validationStatus: "valid" },
    ]);
    const now = new Date().toISOString();
    const publication = workspace.catalog.savePublication({ schemaVersion: 1, id: `publication-${raw.renderRunId}`, projectId: run.projectId, packageId, platform: result.manifest.platform, status: "draft", createdAt: now, updatedAt: now });
    return { ok: true, packageId, publicationId: publication.id, manifest: result.manifest, packageRelativePath: path.relative(workspace.workspacePath, result.packageDir).split(path.sep).join("/"), manifestRelativePath: path.relative(workspace.workspacePath, result.manifestPath).split(path.sep).join("/") };
  } catch (error) {
    return { ok: false, errorCode: "publish_package_failed", message: error instanceof Error ? error.message : "发布包生成失败" };
  }
});

ipcMain.handle("desktop:list-publications", async () => {
  try {
    const workspace = requireWorkspace();
    return { ok: true, publications: workspace.catalog.listPublicationsForWorkspace(workspace.workspaceId).map((publication) => ({ publication, snapshots: workspace.catalog.listMetricSnapshots(publication.id) })), proposals: workspace.catalog.listReviewMemoryProposals(workspace.workspaceId) };
  } catch (error) {
    return { ok: false, errorCode: "publication_list_failed", message: error instanceof Error ? error.message : "读取发布记录失败" };
  }
});

ipcMain.handle("desktop:record-metrics", async (_event, raw) => {
  try {
    const workspace = requireWorkspace();
    const runtime = await getDesktopRuntime();
    const publication = typeof raw?.publicationId === "string" ? workspace.catalog.getPublication(raw.publicationId) : undefined;
    if (!publication || workspace.catalog.getProject(publication.projectId)?.workspaceId !== workspace.workspaceId) throw new Error("发布记录不存在或不属于当前工作区");
    const snapshot = runtime.publishing.MetricSnapshotSchema.parse({ schemaVersion: 1, id: `metric-${randomUUID()}`, publicationId: publication.id, capturedAt: new Date().toISOString(), window: typeof raw.window === "string" && raw.window.trim() ? raw.window.trim() : "24h", source: "manual", metrics: { views: typeof raw.metrics?.views === "number" ? raw.metrics.views : null, likes: typeof raw.metrics?.likes === "number" ? raw.metrics.likes : null, comments: typeof raw.metrics?.comments === "number" ? raw.metrics.comments : null, shares: typeof raw.metrics?.shares === "number" ? raw.metrics.shares : null, saves: typeof raw.metrics?.saves === "number" ? raw.metrics.saves : null, completionRate: typeof raw.metrics?.completionRate === "number" ? raw.metrics.completionRate : null, averageWatchSeconds: typeof raw.metrics?.averageWatchSeconds === "number" ? raw.metrics.averageWatchSeconds : null, newFollowers: typeof raw.metrics?.newFollowers === "number" ? raw.metrics.newFollowers : null }, notes: typeof raw.notes === "string" ? raw.notes : "" });
    workspace.catalog.saveMetricSnapshot(snapshot);
    return { ok: true, snapshot };
  } catch (error) {
    return { ok: false, errorCode: "metric_record_failed", message: error instanceof Error ? error.message : "指标录入失败" };
  }
});

ipcMain.handle("desktop:propose-review-memory", async (_event, raw) => {
  try {
    const workspace = requireWorkspace();
    const runtime = await getDesktopRuntime();
    const publication = typeof raw?.publicationId === "string" ? workspace.catalog.getPublication(raw.publicationId) : undefined;
    if (!publication || workspace.catalog.getProject(publication.projectId)?.workspaceId !== workspace.workspaceId) throw new Error("发布记录不存在或不属于当前工作区");
    const snapshots = workspace.catalog.listMetricSnapshots(publication.id);
    const proposal = runtime.publishing.proposeReviewMemory({ workspaceId: workspace.workspaceId, sourcePublicationIds: [publication.id], snapshots, statement: typeof raw.statement === "string" ? raw.statement : "", appliesTo: { platforms: [publication.platform] } });
    workspace.catalog.saveReviewMemoryProposal(proposal);
    return { ok: true, proposal };
  } catch (error) {
    return { ok: false, errorCode: "review_memory_failed", message: error instanceof Error ? error.message : "复盘建议生成失败" };
  }
});

ipcMain.handle("desktop:confirm-review-memory", async (_event, proposalId) => {
  try {
    const workspace = requireWorkspace();
    if (typeof proposalId !== "string" || !proposalId) throw new Error("复盘建议无效");
    const proposal = workspace.catalog.getReviewMemoryProposal(proposalId);
    if (!proposal || proposal.workspaceId !== workspace.workspaceId) throw new Error("复盘建议不存在或不属于当前工作区");
    if (!workspace.catalog.confirmReviewMemoryProposal(proposalId)) throw new Error("复盘建议不存在或已经处理");
    return { ok: true, proposal: workspace.catalog.getReviewMemoryProposal(proposalId) };
  } catch (error) {
    return { ok: false, errorCode: "review_memory_confirm_failed", message: error instanceof Error ? error.message : "确认复盘记忆失败" };
  }
});

ipcMain.handle("desktop:import-take", async (_event, shootTaskId) => {
  try {
    const workspace = requireWorkspace();
    if (typeof shootTaskId !== "string" || !shootTaskId) throw new Error("拍摄任务无效");
    const task = workspace.catalog.getShootTask(shootTaskId);
    if (!task) throw new Error("拍摄任务不存在");
    const result = process.argv.includes("--ui-smoke") && process.env.UI_SMOKE_SOURCE_PATH
      ? { canceled: false, filePaths: [process.env.UI_SMOKE_SOURCE_PATH] }
      : await dialog.showOpenDialog({ properties: ["openFile"], title: `为“${task.title}”导入 Take`, filters: [{ name: "视频", extensions: ["mp4", "mov", "m4v", "webm", "mkv", "avi"] }] });
    if (result.canceled || result.filePaths.length === 0) return { ok: false, errorCode: "cancelled", message: "已取消导入" };
    const runtime = await getDesktopRuntime();
    const imported = await importLocalMediaJob({ workspace, runtime, sourcePath: result.filePaths[0], workerId: "media-take-import-main" });
    if (!imported.ok) return { ...imported, errorCode: imported.errorCode ?? "take_import_not_completed" };
    const now = new Date().toISOString();
    const source = imported.artifacts.find((artifact) => artifact.kind === "source");
    if (!source) throw new Error("媒体导入任务没有返回 source artifact");
    const take = runtime.creation.TakeSchema.parse({ schemaVersion: 1, id: `take-${randomUUID()}`, shootTaskId, assetId: source.artifactId, relativePath: source.relativePath, durationMs: imported.probe?.durationMs, status: "candidate", createdAt: now, updatedAt: now });
    workspace.catalog.addTake(take);
    const thumbnail = imported.artifacts.find((artifact) => artifact.kind === "thumbnail");
    return { ok: true, take, task: workspace.catalog.getShootTask(shootTaskId), sourceName: imported.sourceName, thumbnail, reused: imported.reused, job: imported.job };
  } catch (error) {
    return { ok: false, errorCode: "take_import_failed", message: error instanceof Error ? error.message : "Take 导入失败" };
  }
});

ipcMain.handle("desktop:select-take", (_event, input) => {
  try {
    const workspace = requireWorkspace();
    if (!input || typeof input.shootTaskId !== "string" || typeof input.takeId !== "string") throw new Error("Take 选择参数无效");
    const selection = workspace.catalog.selectTakeForTask(input.shootTaskId, input.takeId);
    return { ok: true, ...selection };
  } catch (error) {
    return { ok: false, errorCode: "take_selection_failed", message: error instanceof Error ? error.message : "Take 选择失败" };
  }
});

ipcMain.handle("desktop:adopt-asset-candidate", async (_event, raw) => {
  try {
    const workspace = requireWorkspace();
    if (!raw || typeof raw.shootTaskId !== "string" || !raw.shootTaskId || typeof raw.assetId !== "string" || !raw.assetId) throw new Error("候选素材选择参数无效");
    const task = workspace.catalog.getShootTask(raw.shootTaskId);
    if (!task) throw new Error("拍摄任务不存在");
    const artifact = workspace.catalog.getArtifact(raw.assetId);
    if (!artifact || artifact.workspaceId !== workspace.workspaceId || artifact.kind !== "source" || !artifact.mimeType.startsWith("video/")) throw new Error("候选素材不存在、跨工作区或不是视频源素材");

    const absolutePath = path.resolve(workspace.workspacePath, artifact.relativePath);
    const root = realpathSync(workspace.workspacePath);
    const canonicalPath = realpathSync(absolutePath);
    if (canonicalPath !== root && !canonicalPath.startsWith(`${root}${path.sep}`)) throw new Error("候选素材路径越过工作区");
    const fileStats = await statFile(canonicalPath);
    if (!fileStats.isFile()) throw new Error("候选素材不是可读取的文件");

    const sourceSegment = raw.sourceSegment && Number.isInteger(raw.sourceSegment.startMs) && Number.isInteger(raw.sourceSegment.endMs) && raw.sourceSegment.startMs >= 0 && raw.sourceSegment.endMs > raw.sourceSegment.startMs
      ? { startMs: raw.sourceSegment.startMs, endMs: raw.sourceSegment.endMs }
      : undefined;
    const evidenceIds = Array.isArray(raw.evidenceIds) ? raw.evidenceIds.filter((value) => typeof value === "string" && value.length > 0).slice(0, 12) : [];
    const reason = typeof raw.reason === "string" ? raw.reason.trim().slice(0, 240) : "";
    const existingTake = workspace.catalog.listTakes(task.id).find((take) => take.assetId === artifact.artifactId && take.relativePath === artifact.relativePath);
    const runtime = await getDesktopRuntime();
    const now = new Date().toISOString();
    const noteParts = ["从 AI 候选素材人工采用", sourceSegment ? `建议片段 ${sourceSegment.startMs}-${sourceSegment.endMs}ms` : "", reason, evidenceIds.length > 0 ? `证据 ${evidenceIds.join("、")}` : ""].filter(Boolean);
    const take = existingTake ?? runtime.creation.TakeSchema.parse({ schemaVersion: 1, id: `take-${randomUUID()}`, shootTaskId: task.id, assetId: artifact.artifactId, relativePath: artifact.relativePath, capturedAt: now, status: "candidate", note: noteParts.join("；"), createdAt: now, updatedAt: now });
    if (!existingTake) workspace.catalog.addTake(take);
    const selection = workspace.catalog.selectTakeForTask(task.id, take.id);
    return { ok: true, reused: Boolean(existingTake), ...selection, take: selection.takes.find((item) => item.id === take.id) ?? take };
  } catch (error) {
    return { ok: false, errorCode: "asset_candidate_adopt_failed", message: error instanceof Error ? error.message : "候选素材采用失败" };
  }
});

ipcMain.handle("desktop:open-workspace-file", async (_event, relativePath) => {
  try {
    const workspace = requireWorkspace();
    if (typeof relativePath !== "string" || !relativePath) throw new Error("文件路径无效");
    const absolutePath = path.resolve(workspace.workspacePath, relativePath);
    const root = realpathSync(workspace.workspacePath);
    if (absolutePath !== root && !absolutePath.startsWith(`${root}${path.sep}`)) throw new Error("文件路径越过工作区");
    const canonicalPath = realpathSync(absolutePath);
    if (canonicalPath !== root && !canonicalPath.startsWith(`${root}${path.sep}`)) throw new Error("文件路径越过工作区");
    const message = await shell.openPath(canonicalPath);
    if (message) throw new Error(message);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "无法打开文件" };
  }
});

ipcMain.handle("desktop:open-external", async (_event, rawUrl) => {
  try {
    if (typeof rawUrl !== "string") throw new Error("外部链接无效");
    const url = new URL(rawUrl);
    if (url.protocol !== "https:") throw new Error("仅允许打开 HTTPS 链接");
    await shell.openExternal(url.toString());
    return { ok: true };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "无法打开外部链接" };
  }
});

app.whenReady().then(() => {
  const start = async () => {
    if (process.argv.includes("--settings-smoke")) {
      const smokeUserData = process.env.SETTINGS_SMOKE_USER_DATA;
      if (!smokeUserData) throw new Error("SETTINGS_SMOKE_USER_DATA 未配置");
      app.setPath("userData", smokeUserData);
    }
    if (process.argv.includes("--ui-smoke") || process.argv.includes("--topic-library-smoke") || process.argv.includes("--media-import-smoke")) {
      const smokeWorkspace = process.env.UI_SMOKE_WORKSPACE ?? process.env.MEDIA_IMPORT_SMOKE_WORKSPACE;
      if (!smokeWorkspace) throw new Error("UI_SMOKE_WORKSPACE 未配置");
      await initializeWorkspace(smokeWorkspace);
    }
    const window = createWindow();
  if (process.argv.includes("--smoke")) {
    window.webContents.once("did-finish-load", async () => {
      try {
        const result = await window.webContents.executeJavaScript("window.desktop?.getInfo ? window.desktop.getInfo().then((info) => ({ info, hasQuoteGeneratedShots: typeof window.desktop.quoteGeneratedShots === 'function', hasRunGeneratedShots: typeof window.desktop.runGeneratedShots === 'function' })) : null");
        if (!result?.info || typeof result.info.platform !== "string" || typeof result.info.arch !== "string" || !result.hasQuoteGeneratedShots || !result.hasRunGeneratedShots) throw new Error("preload IPC smoke 返回值或生成分镜 allowlist 无效");
        const runtime = await getDesktopRuntime();
        const smokeRoot = mkdtempSync(path.join(os.tmpdir(), "creator-copilot-desktop-smoke-"));
        const smokeCatalog = new runtime.storage.SqliteCatalog(path.join(smokeRoot, "catalog.sqlite"));
        const schemaVersion = smokeCatalog.schemaVersion();
        smokeCatalog.close();
        await removeFile(smokeRoot, { recursive: true, force: true });
        console.log(JSON.stringify({ ok: true, smoke: "preload-ipc+runtime-sqlite", platform: result.info.platform, arch: result.info.arch, schemaVersion, generatedShotIpc: true }));
        app.exit(0);
      } catch (error) {
        console.error(JSON.stringify({ ok: false, smoke: "preload-ipc", message: error instanceof Error ? error.message : "preload IPC smoke 失败" }));
        app.exit(1);
      }
    });
  }
  if (process.argv.includes("--topic-library-smoke")) {
    window.webContents.once("did-finish-load", async () => {
      try {
        const runtime = await getDesktopRuntime();
        const workspace = requireWorkspace();
        const now = new Date().toISOString();
        const report = runtime.research.TopicRadarReportSchema.parse({
          schemaVersion: 1,
          id: "topic-radar-smoke-report",
          workspaceId: workspace.workspaceId,
          providerKey: "tikhub",
          query: { schemaVersion: 1, sources: ["search_hot"], keyword: "表达", dateWindow: 24, pageSize: 1 },
          quote: { schemaVersion: 1, id: "topic-radar-smoke-quote", workspaceId: workspace.workspaceId, query: { schemaVersion: 1, sources: ["search_hot"], keyword: "表达", dateWindow: 24, pageSize: 1 }, lines: [{ source: "search_hot", endpoint: "/fixture", costUsd: 0 }], totalCostUsd: 0, currency: "USD", quotedAt: now, expiresAt: new Date(Date.parse(now) + 600_000).toISOString() },
          status: "completed",
          signals: [{ schemaVersion: 1, id: "topic-signal-smoke", source: "search_hot", kind: "search_term", label: "表达结构", detail: "fixture signal", metrics: { searchScore: 1 }, sourceId: "表达结构", capturedAt: now }],
          opportunities: [{ schemaVersion: 1, id: "topic-opportunity-smoke", source: "search_hot", title: "搜索机会：表达结构", angle: "把热词改写成自己的真实案例。", whyNow: "fixture signal", evidenceIds: ["topic-signal-smoke"], status: "candidate" }],
          runs: [{ schemaVersion: 1, source: "search_hot", endpoint: "/fixture", jobId: "topic-job-smoke", quotedCostUsd: 0, status: "succeeded", itemCount: 1 }],
          createdAt: now,
        });
        workspace.catalog.saveTopicRadarReport(report);
        const first = await window.webContents.executeJavaScript("window.desktop.saveTopicOpportunity({source:'topic_radar',reportId:'topic-radar-smoke-report',opportunityId:'topic-opportunity-smoke'})");
        const second = await window.webContents.executeJavaScript("window.desktop.saveTopicOpportunity({source:'topic_radar',reportId:'topic-radar-smoke-report',opportunityId:'topic-opportunity-smoke'})");
        const selected = first?.topic ? await window.webContents.executeJavaScript(`window.desktop.selectTopic({topicId:${JSON.stringify(first.topic.id)},expectedRevision:${first.topic.revision}})`) : null;
        const proposal = selected?.topic ? await window.webContents.executeJavaScript(`window.desktop.proposeScript({brief:'我想讲一个具体案例。',topicId:${JSON.stringify(selected.topic.id)}})`) : null;
        const topics = workspace.catalog.listTopics(workspace.workspaceId);
        if (!first?.ok || !first.created || !second?.ok || second.created || topics.length !== 1 || !selected?.ok || selected.topic?.status !== "selected" || !proposal?.ok || proposal.proposal?.topicId !== selected.topic.id || proposal.proposal?.topicRevision !== selected.topic.revision) throw new Error("Topic → script IPC smoke 没有保持幂等、确认和上下文追溯");
        console.log(JSON.stringify({ ok: true, smoke: "topic-library-to-script-context", firstCreated: first.created, secondCreated: second.created, selectedStatus: selected.topic.status, proposalTopicId: proposal.proposal.topicId, proposalTopicRevision: proposal.proposal.topicRevision, topicCount: topics.length, schemaVersion: workspace.catalog.schemaVersion() }));
        app.exit(0);
      } catch (error) {
        console.error(JSON.stringify({ ok: false, smoke: "topic-library-ipc-idempotency", message: error instanceof Error ? error.message : "Topic IPC smoke 失败" }));
        app.exit(1);
      }
    });
  }
  if (process.argv.includes("--media-import-smoke")) {
    window.webContents.once("did-finish-load", async () => {
      try {
        const sourcePath = process.env.MEDIA_IMPORT_SMOKE_SOURCE_PATH;
        if (!sourcePath) throw new Error("MEDIA_IMPORT_SMOKE_SOURCE_PATH 未配置");
        const badSourcePath = process.env.MEDIA_IMPORT_SMOKE_BAD_SOURCE_PATH;
        const runtime = await getDesktopRuntime();
        const workspace = requireWorkspace();
        const first = await importLocalMediaJob({ workspace, runtime, sourcePath, workerId: "media-import-smoke" });
        const second = await importLocalMediaJob({ workspace, runtime, sourcePath, workerId: "media-import-smoke" });
        const jobs = workspace.catalog.listJobsForWorkspace(workspace.workspaceId, "media.import");
        const sourceArtifactCount = workspace.catalog.listArtifacts(workspace.workspaceId).filter((artifact) => artifact.kind === "source").length;
        let failedFirst;
        let failedSecond;
        if (badSourcePath) {
          failedFirst = await importLocalMediaJob({ workspace, runtime, sourcePath: badSourcePath, workerId: "media-import-smoke" });
          failedSecond = await importLocalMediaJob({ workspace, runtime, sourcePath: badSourcePath, workerId: "media-import-smoke" });
        }
        const finalJobs = workspace.catalog.listJobsForWorkspace(workspace.workspaceId, "media.import");
        if (!first.ok || first.reused || first.status !== "succeeded" || !second.ok || !second.reused || second.status !== "succeeded" || finalJobs.length !== (badSourcePath ? 2 : 1) || sourceArtifactCount !== 1 || (badSourcePath && (failedFirst?.ok || failedFirst.status !== "failed" || failedSecond?.ok || failedSecond.status !== "failed" || failedSecond.job?.attempt !== 2))) throw new Error("媒体导入 Job smoke 没有保持成功、幂等复用、失败重试和单份 source artifact");
        console.log(JSON.stringify({ ok: true, smoke: "media-import-job-idempotency-recovery", firstReused: first.reused, secondReused: second.reused, jobState: second.job?.state, attempt: second.job?.attempt, failedState: failedSecond?.job?.state ?? null, failedAttempt: failedSecond?.job?.attempt ?? null, artifactCount: second.artifacts.length, sourceArtifactCount, jobCount: finalJobs.length, schemaVersion: workspace.catalog.schemaVersion() }));
        app.exit(0);
      } catch (error) {
        console.error(JSON.stringify({ ok: false, smoke: "media-import-job-idempotency", message: error instanceof Error ? error.message : "媒体导入 Job smoke 失败" }));
        app.exit(1);
      }
    });
  }
  if (process.argv.includes("--settings-smoke")) {
    window.webContents.once("did-finish-load", async () => {
      try {
        const result = await window.webContents.executeJavaScript(`(async () => {
          const buttons = [...document.querySelectorAll("button")];
          const settingsButton = buttons.find((button) => button.textContent?.includes("设置"));
          if (!settingsButton) throw new Error("设置 smoke 找不到设置入口");
          settingsButton.click();
          await new Promise((resolve) => setTimeout(resolve, 250));
          if (!document.querySelector(".settings-workbench")) throw new Error("设置 smoke 没有渲染设置工作台");
          const first = await window.desktop.getLocalAnalysisSettings();
          if (!first?.ok || !first.settings) throw new Error("设置 smoke 无法读取本地分析设置");
          const next = { ...first.settings, asr: { ...first.settings.asr, engine: "disabled" }, ocr: { ...first.settings.ocr, engine: "disabled", sampleIntervalMs: 1250 }, updatedAt: new Date().toISOString() };
          const invalid = await window.desktop.saveLocalAnalysisSettings({ ...next, asr: { ...next.asr, modelPath: "relative/model.bin" } });
          if (invalid?.ok !== false) throw new Error("设置 smoke 没有拒绝相对模型路径");
          const saved = await window.desktop.saveLocalAnalysisSettings(next);
          if (!saved?.ok || saved.settings?.ocr?.sampleIntervalMs !== 1250) throw new Error("设置 smoke 保存结果不正确");
          const reopened = await window.desktop.getLocalAnalysisSettings();
          if (!reopened?.ok || reopened.settings?.ocr?.sampleIntervalMs !== 1250 || reopened.settings?.asr?.engine !== "disabled" || reopened.settings?.ocr?.engine !== "disabled") throw new Error("设置 smoke 重读结果不正确");
          if (first.source !== "environment") throw new Error("设置 smoke 来源不正确：" + (first.source ?? "unknown"));
          return { ok: true, source: first.source, reopenedSource: reopened.source, persistedIntervalMs: reopened.settings.ocr.sampleIntervalMs, asrEngine: reopened.settings.asr.engine, ocrEngine: reopened.settings.ocr.engine, sceneDetectionReady: reopened.capabilities?.sceneDetection.ready };
        })()`);
        if (!result?.ok || result.persistedIntervalMs !== 1250 || result.sceneDetectionReady !== true) throw new Error("设置 smoke 没有验证持久化和基础能力状态");
        console.log(JSON.stringify({ ok: true, smoke: "local-analysis-settings-ipc-persistence", settings: result }));
        app.exit(0);
      } catch (error) {
        console.error(JSON.stringify({ ok: false, smoke: "local-analysis-settings-ipc-persistence", message: error instanceof Error ? error.message : "设置 smoke 失败" }));
        app.exit(1);
      }
    });
  }
  if (process.argv.includes("--ui-smoke")) {
    window.webContents.once("did-finish-load", async () => {
      const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
      try {
        await wait(700);
        const result = await window.webContents.executeJavaScript(`(async () => {
          const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
          const buttons = () => [...document.querySelectorAll("button")];
          for (let attempt = 0; attempt < 40 && buttons().length === 0; attempt += 1) await wait(250);
          if (buttons().length === 0) throw new Error("React 页面没有挂载按钮；body=" + (document.body?.innerText ?? "").slice(0, 300));
          const clickText = (text, occurrence = 0) => {
            const matches = buttons().filter((button) => !button.disabled && button.textContent?.includes(text));
            const button = matches[occurrence];
            if (!button) throw new Error("找不到按钮：" + text + " #" + occurrence);
            button.click();
          };
          const waitFor = async (predicate, label) => {
            for (let attempt = 0; attempt < 80; attempt += 1) {
              if (predicate()) return;
              await wait(250);
            }
            throw new Error("等待超时：" + label);
          };
          clickText("创作项目");
          await wait(300);
          if (!document.querySelector("h1")?.textContent?.includes("脚本、分镜与拍摄包")) throw new Error("没有进入创作项目页面");
          clickText("生成脚本提案");
          await waitFor(() => document.querySelector(".script-proposal-review"), "脚本提案预览");
          if (!document.querySelector(".script-proposal-shot-plan")) throw new Error("脚本提案没有生成结构化拍摄计划");
          clickText("确认并保存脚本");
          await waitFor(() => document.querySelector(".script-proposal-review")?.textContent?.includes("脚本已确认"), "脚本提案确认");
          const scriptStageProjects = await window.desktop.listProjects();
          const scriptStageProject = scriptStageProjects.projects?.[0];
          const scriptStageLoaded = scriptStageProject ? await window.desktop.loadProject({ projectId: scriptStageProject.id }) : null;
          if (!scriptStageProjects.ok || !scriptStageProject || !scriptStageLoaded?.ok || !scriptStageLoaded.script || scriptStageLoaded.storyboard || scriptStageLoaded.capturePackage) throw new Error("UI smoke 没有恢复仅完成脚本的项目阶段");
          await waitFor(() => document.querySelector(".project-resume-row"), "脚本阶段项目恢复列表");
          const scriptContinueButton = [...document.querySelectorAll(".project-resume-row button")].find((button) => !button.disabled && button.textContent?.includes("继续编辑"));
          if (!scriptContinueButton) throw new Error("UI smoke 没有找到脚本阶段继续编辑入口");
          scriptContinueButton.click();
          await waitFor(() => document.querySelector(".creation-message.success")?.textContent?.includes("继续完善分镜"), "脚本阶段项目恢复反馈");
          clickText("生成并导出拍摄包");
          await wait(900);
          if (!document.querySelector(".capture-result")) throw new Error("拍摄包没有出现在创作页面；body=" + (document.body?.innerText ?? "").slice(-1800));
          if (!document.querySelector(".capture-task-checklist")) throw new Error("拍摄包没有展示拍摄检查清单");
          const captureTaskCount = document.querySelectorAll(".capture-task").length;
          if (captureTaskCount < 3) throw new Error("分镜没有为口播主干和补充画面生成足够拍摄任务");
          for (let index = 0; index < captureTaskCount; index += 1) {
            await waitFor(() => buttons().some((button) => !button.disabled && button.textContent?.includes("导入 Take")), "Take 导入按钮可用");
            clickText("导入 Take", index);
            await waitFor(() => buttons().filter((button) => button.classList.contains("take-chip")).length >= index + 1, "第 " + (index + 1) + " 个 Take 导入完成");
          }
          const takeButtons = buttons().filter((button) => button.classList.contains("take-chip"));
          if (takeButtons.length < captureTaskCount) throw new Error("没有为每个拍摄任务生成 Take");
          for (const button of takeButtons.slice(0, captureTaskCount)) button.click();
          await wait(500);
          const assetsBeforeAnalysis = await window.desktop.searchAssets("");
          const sourceArtifact = assetsBeforeAnalysis.artifacts?.find((artifact) => artifact.kind === "source");
          if (!sourceArtifact) throw new Error("UI smoke 没有找到导入后的 source artifact");
          const analysis = await window.desktop.analyzeAsset({ artifactId: sourceArtifact.artifactId });
          if (!analysis.ok || analysis.status !== "succeeded") throw new Error("UI smoke 的本地素材分析没有成功：" + (analysis.message ?? "unknown"));
          const analyzedAssets = await window.desktop.searchAssets("");
          if (!analyzedAssets.facts?.some((fact) => fact.kind === "shot" && fact.artifactId === sourceArtifact.artifactId)) throw new Error("UI smoke 没有回写镜头事实");
          clickText("进入 AI 剪辑");
          await wait(350);
          clickText("生成 AI 剪辑提案");
          await wait(1_000);
          if (!document.querySelector(".proposal-list")) throw new Error("AI 提案没有出现在页面；body=" + (document.body?.innerText ?? "").slice(-1200));
          if (!document.querySelector(".proposal-intent")) throw new Error("AI 提案没有显示原拍摄意图");
          if (!document.querySelector(".proposal-row.overlay") || !document.querySelector(".proposal-row.primary")) throw new Error("AI 提案没有同时生成口播主干和画面覆盖");
          await waitFor(() => buttons().some((button) => !button.disabled && button.textContent?.includes("作为 Take")), "候选素材采用按钮");
          clickText("作为 Take");
          await waitFor(() => (document.body?.innerText ?? "").includes("已复用已有 Take") || (document.body?.innerText ?? "").includes("已创建 Take"), "候选素材写入 Take");
          clickText("确认并导出");
          await wait(2_500);
          if (!document.querySelector(".render-success")) throw new Error("AI 剪辑没有成功导出");
          const renderTitle = document.querySelector(".render-success h3")?.textContent ?? null;
          const proposalRowCount = document.querySelectorAll(".proposal-row").length;
          const workspaceText = document.querySelector(".workspace-state")?.textContent ?? "";
          const projectId = workspaceText.match(/project-[a-z0-9-]+/i)?.[0] ?? null;
          const persistedProjects = await window.desktop.listProjects();
          const loaded = projectId ? await window.desktop.loadProject({ projectId }) : null;
          if (!persistedProjects.ok || !persistedProjects.projects?.some((project) => project.id === projectId) || !loaded?.ok || loaded.project?.id !== projectId || !loaded.script || !loaded.storyboard || !loaded.tasks?.length || !loaded.capturePackage) throw new Error("UI smoke 没有从 SQLite 恢复已保存项目的脚本、分镜和拍摄包");
          for (const block of loaded.script.blocks) {
            const blockShots = loaded.storyboard.shots.filter((shot) => shot.scriptBlockIds.includes(block.id));
            if (!blockShots.some((shot) => shot.mode === "talking_head")) throw new Error("脚本段落缺少连续口播主干：" + block.id);
            if (block.visualNeed !== "none" && !blockShots.some((shot) => shot.mode !== "talking_head")) throw new Error("需要画面支持的脚本段落缺少补充镜头：" + block.id);
          }
          clickText("创作项目");
          await waitFor(() => document.querySelector(".project-resume-row"), "本地项目恢复列表");
          const continueButton = [...document.querySelectorAll(".project-resume-row button")].find((button) => !button.disabled && button.textContent?.includes("继续编辑"));
          if (!continueButton) throw new Error("UI smoke 没有找到继续编辑入口");
          continueButton.click();
          await waitFor(() => document.querySelector(".creation-message.success")?.textContent?.includes("已从本地工作区恢复"), "项目恢复成功反馈");
          if (!document.querySelector(".capture-result") || document.querySelectorAll(".capture-task").length !== loaded.tasks.length) throw new Error("UI smoke 点击继续编辑后没有恢复拍摄任务和拍摄包");
          return { ok: true, title: renderTitle, proposalRows: proposalRowCount, projectId, scriptStageRecovered: true, analysisFactCount: analyzedAssets.facts?.length ?? 0, persistedProjectCount: persistedProjects.projects.length, loadedTaskCount: loaded.tasks.length };
        })()`);
        if (!result?.ok) throw new Error("UI smoke 没有返回成功结果");
        const workspace = requireWorkspace();
        if (!result.projectId) throw new Error("UI smoke 没有返回项目 ID");
        const renderRuns = workspace.catalog.listRenderRunsForProject(result.projectId);
        if (!renderRuns.some((run) => run.state === "succeeded")) throw new Error("UI smoke 的 SQLite 没有成功 render run");
        console.log(JSON.stringify({ ok: true, smoke: "electron-ui-creation-import-proposal-render", ui: result, workspace: workspace.workspacePath, renderRuns: renderRuns.map((run) => ({ id: run.id, state: run.state, manifestHash: run.manifestHash })) }));
        app.exit(0);
      } catch (error) {
        console.error(JSON.stringify({ ok: false, smoke: "electron-ui-creation-import-proposal-render", message: error instanceof Error ? error.message : "Electron UI smoke 失败" }));
        app.exit(1);
      }
    });
  }
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
  };
  void start().catch((error) => {
    console.error(JSON.stringify({ ok: false, smoke: "electron-startup", message: error instanceof Error ? error.message : "Electron 启动失败" }));
    app.exit(1);
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  if (catalog) {
    catalog.close();
    catalog = null;
  }
});
