const { createHash, randomUUID } = require("node:crypto");
const { mkdir, rename, rm, stat } = require("node:fs/promises");
const path = require("node:path");

const GENERATED_SHOT_PROFILE = Object.freeze({
  providerKey: "apimart",
  modelKey: "kling-v3",
  modelLabel: "Kling V3 · 标准模式（720p）",
  durationSeconds: 5,
  aspectRatio: "9:16",
  unitPriceUsd: 0.0672,
  estimatedCostPerShotUsd: 0.336,
  maxShotsPerBatch: 5,
  priceCheckedAt: "2026-08-19",
  priceSourceUrl: "https://apimart.ai/blog/top-ai-video-models-2026-pricing-api-comparison",
});

function safeQuote(quote) {
  return {
    ...quote,
    shots: quote.shots.map(({ shotId, materialKind }) => ({ shotId, materialKind })),
    consumed: undefined,
  };
}

function normalizeQuoteInput(raw, profile) {
  if (!raw || !Array.isArray(raw.shots) || raw.shots.length === 0) throw new Error("没有可生成的缺失分镜");
  if (raw.shots.length > profile.maxShotsPerBatch) throw new Error(`一次最多生成 ${profile.maxShotsPerBatch} 个缺失分镜`);
  const allowedKinds = new Set(["store", "product", "graphic", "generic"]);
  const seen = new Set();
  return raw.shots.map((shot) => {
    const shotId = typeof shot?.shotId === "string" ? shot.shotId.trim() : "";
    const prompt = typeof shot?.prompt === "string" ? shot.prompt.trim() : "";
    const materialKind = typeof shot?.materialKind === "string" ? shot.materialKind : "";
    if (!shotId || shotId.length > 200 || !/^[A-Za-z0-9._:-]+$/.test(shotId) || seen.has(shotId)) throw new Error("缺失分镜 ID 无效或重复");
    if (!prompt || prompt.length > 2_500) throw new Error("生成提示词必须在 1–2500 字之间");
    if (!allowedKinds.has(materialKind)) throw new Error("本人、客户或真实过程镜头不能用 AI 生成替代");
    seen.add(shotId);
    return { shotId, prompt, materialKind };
  });
}

function generationFailure(error, fallbackCode = "MEDIA_GENERATION_FAILED") {
  const normalized = error && typeof error === "object" && "normalized" in error ? error.normalized : undefined;
  const category = normalized && typeof normalized === "object" && typeof normalized.category === "string" ? normalized.category : undefined;
  const code = normalized && typeof normalized === "object" && normalized.code ? String(normalized.code) : fallbackCode;
  const message = normalized && typeof normalized === "object" && normalized.message
    ? String(normalized.message).slice(0, 500)
    : error instanceof Error ? error.message.slice(0, 500) : "视频生成失败";
  return {
    code,
    message,
    retryable: normalized && typeof normalized === "object" && "retryable" in normalized ? Boolean(normalized.retryable) : false,
    submissionUnknown: code === "TASK_ID_MISSING" || category === "network" || category === "timeout" || /network|timeout|fetch|socket|econn/i.test(message),
  };
}

function jobIdFor(quoteId, shotId) {
  return `job-video-${createHash("sha256").update(`${quoteId}:${shotId}`).digest("hex").slice(0, 24)}`;
}

function artifactPathsFor(workspacePath, providerTaskId) {
  const safeTaskId = providerTaskId.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 120);
  const directory = path.join(workspacePath, "generated", "owner-studio");
  return {
    directory,
    outputPath: path.join(directory, `${safeTaskId}.mp4`),
    temporaryPath: path.join(directory, `.${safeTaskId}.${process.pid}.${randomUUID()}.tmp.mp4`),
  };
}

const waitForPoll = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function createShotGenerationService(options) {
  const profile = options.profile ?? GENERATED_SHOT_PROFILE;
  const pendingQuotes = new Map();

  function configuration() {
    const providerSelected = (options.getProviderKey?.() ?? profile.providerKey) === profile.providerKey;
    return {
      configured: providerSelected && Boolean(options.getApiKey()),
      providerKey: profile.providerKey,
      modelKey: profile.modelKey,
    };
  }

  function createProvider(runtime) {
    const apiKey = options.getApiKey();
    if (!apiKey) throw new Error("APIMart API key 未配置；请用本地 .env 启动桌面端");
    if ((options.getProviderKey?.() ?? profile.providerKey) !== profile.providerKey) throw new Error("视频生成 Provider 未配置为 APIMart");
    return new runtime.providers.ApiMartClient({
      apiKey,
      baseUrl: options.getBaseUrl?.() ?? "https://api.apimart.ai",
      fetcher: options.fetcher,
    });
  }

  async function runOne({ workspace, runtime, provider, quote, shot }) {
    const jobId = jobIdFor(quote.id, shot.shotId);
    const now = new Date().toISOString();
    const inputHash = `sha256:${createHash("sha256").update(JSON.stringify({ quoteId: quote.id, shotId: shot.shotId, prompt: shot.prompt, profile })).digest("hex")}`;
    if (!workspace.catalog.getJob(jobId)) {
      workspace.catalog.insertJob({
        schemaVersion: 1,
        id: jobId,
        kind: "provider.video.generate",
        inputHash,
        state: "queued",
        attempt: 0,
        idempotencyKey: `${quote.id}:${shot.shotId}`,
        idempotencyScope: workspace.workspaceId,
        providerKey: profile.providerKey,
        checkpoint: { stage: "approved", quoteId: quote.id, shotId: shot.shotId, modelKey: profile.modelKey },
        correlationId: quote.id,
        artifactIds: [],
        createdAt: now,
        updatedAt: now,
      });
    }

    const workerId = `owner-studio-${process.pid}`;
    const leaseToken = workspace.catalog.claimJob(jobId, workerId, new Date(), 120_000);
    if (!leaseToken) throw new Error("这个分镜的生成任务已经在运行或等待人工处理");
    if (!workspace.catalog.heartbeatJob(jobId, workerId, leaseToken, new Date(), 120_000)) throw new Error("无法启动视频生成任务");
    if (!workspace.catalog.checkpointActiveJob(jobId, workerId, leaseToken, { checkpoint: { stage: "submitting", quoteId: quote.id, shotId: shot.shotId, modelKey: profile.modelKey } })) throw new Error("无法持久化提交前检查点");

    let submission;
    try {
      submission = await provider.submitVideo({
        modelKey: profile.modelKey,
        prompt: shot.prompt,
        durationSeconds: profile.durationSeconds,
        aspectRatio: profile.aspectRatio,
        quality: "standard",
        timeoutMs: 60_000,
      });
    } catch (error) {
      const failure = generationFailure(error, "MEDIA_SUBMIT_FAILED");
      const state = failure.submissionUnknown ? "submission_unknown" : "failed";
      workspace.catalog.transitionJob(jobId, "running", state, leaseToken, {
        lastError: { code: failure.code, message: failure.message, retryable: false },
        checkpoint: { stage: state, quoteId: quote.id, shotId: shot.shotId, modelKey: profile.modelKey },
      });
      return { shotId: shot.shotId, ok: false, status: state, errorCode: failure.code, message: failure.message };
    }

    const receiptStored = workspace.catalog.checkpointActiveJob(jobId, workerId, leaseToken, {
      externalJobId: submission.providerTaskId,
      checkpoint: { stage: "submitted", quoteId: quote.id, shotId: shot.shotId, modelKey: profile.modelKey, providerState: submission.providerState ?? "submitted" },
    });
    if (!receiptStored) {
      workspace.catalog.transitionJob(jobId, "running", "needs_attention", leaseToken, {
        externalJobId: submission.providerTaskId,
        lastError: { code: "SUBMISSION_RECEIPT_NOT_PERSISTED", message: "Provider 已接单，但本地提交回执没有完成检查点保存", retryable: false },
        checkpoint: { stage: "receipt_persist_failed", quoteId: quote.id, shotId: shot.shotId, providerTaskId: submission.providerTaskId },
      });
      return { shotId: shot.shotId, ok: false, status: "needs_attention", errorCode: "SUBMISSION_RECEIPT_NOT_PERSISTED", message: "Provider 已接单，但本地未能保存任务 ID；不会自动重提" };
    }

    let pollFailures = 0;
    const deadline = Date.now() + 12 * 60_000;
    let completedStatus;
    while (Date.now() < deadline) {
      await waitForPoll(5_000);
      if (!workspace.catalog.heartbeatJob(jobId, workerId, leaseToken, new Date(), 120_000)) return { shotId: shot.shotId, ok: false, status: "needs_attention", errorCode: "JOB_LEASE_LOST", message: "本地任务租约已失效；Provider 任务 ID 已保存，不会自动重提" };
      try {
        const status = await provider.pollMediaTask(submission.providerTaskId);
        pollFailures = 0;
        workspace.catalog.checkpointActiveJob(jobId, workerId, leaseToken, {
          externalJobId: submission.providerTaskId,
          checkpoint: { stage: "polling", quoteId: quote.id, shotId: shot.shotId, modelKey: profile.modelKey, providerState: status.providerState ?? status.state, progress: status.progress ?? null },
        });
        if (status.state === "queued" || status.state === "processing") continue;
        if (status.state === "cancelled") {
          workspace.catalog.transitionJob(jobId, "running", "cancelled", leaseToken, { checkpoint: { stage: "cancelled", quoteId: quote.id, shotId: shot.shotId } });
          return { shotId: shot.shotId, ok: false, status: "cancelled", errorCode: "MEDIA_GENERATION_CANCELLED", message: "Provider 已取消视频生成任务" };
        }
        if (status.state === "failed") {
          const failure = status.error ?? { code: "MEDIA_GENERATION_FAILED", message: "Provider 视频生成失败", retryable: false };
          workspace.catalog.transitionJob(jobId, "running", "failed", leaseToken, {
            lastError: { code: failure.code, message: failure.message, retryable: false },
            checkpoint: { stage: "provider_failed", quoteId: quote.id, shotId: shot.shotId, providerState: status.providerState ?? status.state },
          });
          return { shotId: shot.shotId, ok: false, status: "failed", errorCode: failure.code, message: failure.message };
        }
        completedStatus = status;
        break;
      } catch (error) {
        pollFailures += 1;
        const failure = generationFailure(error, "MEDIA_POLL_FAILED");
        if (failure.retryable && pollFailures < 3) continue;
        workspace.catalog.transitionJob(jobId, "running", "needs_attention", leaseToken, {
          lastError: { code: failure.code, message: failure.message, retryable: failure.retryable },
          checkpoint: { stage: "poll_failed", quoteId: quote.id, shotId: shot.shotId, providerTaskId: submission.providerTaskId },
        });
        return { shotId: shot.shotId, ok: false, status: "needs_attention", errorCode: failure.code, message: `${failure.message}；Provider 任务 ID 已保存，不会自动重提` };
      }
    }

    if (!completedStatus) {
      workspace.catalog.transitionJob(jobId, "running", "needs_attention", leaseToken, {
        lastError: { code: "MEDIA_POLL_TIMEOUT", message: "等待 Provider 任务完成超时", retryable: true },
        checkpoint: { stage: "poll_timeout", quoteId: quote.id, shotId: shot.shotId, providerTaskId: submission.providerTaskId },
      });
      return { shotId: shot.shotId, ok: false, status: "needs_attention", errorCode: "MEDIA_POLL_TIMEOUT", message: "等待生成超时；Provider 任务 ID 已保存，不会自动重提" };
    }

    const output = completedStatus.outputs?.[0];
    if (!output) {
      workspace.catalog.transitionJob(jobId, "running", "needs_attention", leaseToken, {
        lastError: { code: "MEDIA_OUTPUT_MISSING", message: "Provider 完成任务但没有返回视频地址", retryable: false },
        checkpoint: { stage: "output_missing", quoteId: quote.id, shotId: shot.shotId, providerTaskId: submission.providerTaskId },
      });
      return { shotId: shot.shotId, ok: false, status: "needs_attention", errorCode: "MEDIA_OUTPUT_MISSING", message: "Provider 显示完成，但没有可下载的视频地址" };
    }

    const artifactPaths = artifactPathsFor(workspace.workspacePath, submission.providerTaskId);
    await mkdir(artifactPaths.directory, { recursive: true });
    try {
      workspace.catalog.checkpointActiveJob(jobId, workerId, leaseToken, {
        externalJobId: submission.providerTaskId,
        checkpoint: { stage: "downloading", quoteId: quote.id, shotId: shot.shotId, providerTaskId: submission.providerTaskId },
      });
      const download = await runtime.media.downloadRemoteFile({
        url: output.url,
        destinationPath: artifactPaths.temporaryPath,
        maxBytes: 500 * 1024 * 1024,
        fetcher: options.fetcher,
      });
      const probe = await new runtime.media.FfmpegToolchain().probe(artifactPaths.temporaryPath);
      if (!probe.streams.some((stream) => stream.kind === "video") || !probe.durationMs || probe.durationMs <= 0) throw new Error("下载结果没有可用的视频流");
      await rename(artifactPaths.temporaryPath, artifactPaths.outputPath);
      const stats = await stat(artifactPaths.outputPath);
      const contentHash = await runtime.media.sha256File(artifactPaths.outputPath);
      const artifactId = `generated-video-${createHash("sha256").update(submission.providerTaskId).digest("hex").slice(0, 24)}`;
      const relativePath = path.relative(workspace.workspacePath, artifactPaths.outputPath).split(path.sep).join("/");
      workspace.catalog.insertArtifacts([{
        schemaVersion: 1,
        artifactId,
        workspaceId: workspace.workspaceId,
        kind: "generated-video",
        relativePath,
        mimeType: download.contentType?.startsWith("video/") ? download.contentType.split(";")[0] : "video/mp4",
        contentHash,
        byteSize: stats.size,
        parentArtifactIds: [],
        validationStatus: "valid",
      }]);
      workspace.catalog.transitionJob(jobId, "running", "succeeded", leaseToken, {
        artifactIds: [artifactId],
        checkpoint: { stage: "completed", quoteId: quote.id, shotId: shot.shotId, providerTaskId: submission.providerTaskId, durationMs: probe.durationMs, contentHash, actualCostUsd: completedStatus.cost ?? null },
      });
      return {
        shotId: shot.shotId,
        ok: true,
        status: "succeeded",
        providerTaskId: submission.providerTaskId,
        artifactId,
        relativePath,
        durationMs: probe.durationMs,
        byteSize: stats.size,
        contentHash,
        actualCostUsd: completedStatus.cost,
      };
    } catch (error) {
      await rm(artifactPaths.temporaryPath, { force: true }).catch(() => undefined);
      const failure = generationFailure(error, "MEDIA_DOWNLOAD_VALIDATE_FAILED");
      workspace.catalog.transitionJob(jobId, "running", "needs_attention", leaseToken, {
        lastError: { code: failure.code, message: failure.message, retryable: true },
        checkpoint: { stage: "download_or_validation_failed", quoteId: quote.id, shotId: shot.shotId, providerTaskId: submission.providerTaskId },
      });
      return { shotId: shot.shotId, ok: false, status: "needs_attention", errorCode: failure.code, message: `${failure.message}；Provider 任务 ID 已保存，不会自动重提` };
    }
  }

  return {
    profile,
    configuration,
    clearQuotes() {
      pendingQuotes.clear();
    },
    async quoteGeneratedShots(raw) {
      try {
        const workspace = options.requireWorkspace();
        createProvider(await options.getRuntime());
        const shots = normalizeQuoteInput(raw, profile);
        const quotedAt = new Date();
        const quote = {
          id: `quote-video-${randomUUID()}`,
          workspaceId: workspace.workspaceId,
          shots,
          providerKey: profile.providerKey,
          modelKey: profile.modelKey,
          modelLabel: profile.modelLabel,
          durationSeconds: profile.durationSeconds,
          aspectRatio: profile.aspectRatio,
          unitPriceUsd: profile.unitPriceUsd,
          estimatedCostPerShotUsd: profile.estimatedCostPerShotUsd,
          estimatedTotalCostUsd: Number((shots.length * profile.estimatedCostPerShotUsd).toFixed(4)),
          currency: "USD",
          priceCheckedAt: profile.priceCheckedAt,
          priceSourceUrl: profile.priceSourceUrl,
          quotedAt: quotedAt.toISOString(),
          expiresAt: new Date(quotedAt.getTime() + 10 * 60_000).toISOString(),
          consumed: false,
        };
        pendingQuotes.set(quote.id, quote);
        return { ok: true, quote: safeQuote(quote) };
      } catch (error) {
        return { ok: false, errorCode: "generated_shot_quote_failed", message: error instanceof Error ? error.message : "无法生成缺失分镜报价" };
      }
    },
    async runGeneratedShots(rawQuoteId) {
      try {
        const quoteId = typeof rawQuoteId === "string" ? rawQuoteId : "";
        if (!/^quote-video-[A-Za-z0-9-]+$/.test(quoteId)) throw new Error("生成报价 ID 无效");
        const quote = pendingQuotes.get(quoteId);
        if (!quote) throw new Error("生成报价不存在或桌面端已经重启，请重新报价");
        const workspace = options.requireWorkspace();
        if (quote.workspaceId !== workspace.workspaceId) throw new Error("生成报价不属于当前工作区");
        if (quote.consumed) throw new Error("这个报价已经提交过，不能重复扣费");
        if (Date.parse(quote.expiresAt) <= Date.now()) throw new Error("生成报价已过期，请重新报价");
        quote.consumed = true;
        const runtime = await options.getRuntime();
        const provider = createProvider(runtime);
        const results = [];
        for (const shot of quote.shots) {
          const result = await runOne({ workspace, runtime, provider, quote, shot });
          results.push(result);
          if (result.status === "submission_unknown" || result.errorCode === "SUBMISSION_RECEIPT_NOT_PERSISTED") break;
        }
        const completed = results.filter((result) => result.ok).length;
        const actualCosts = results.flatMap((result) => typeof result.actualCostUsd === "number" ? [result.actualCostUsd] : []);
        return {
          ok: completed === quote.shots.length,
          partial: completed > 0 && completed < quote.shots.length,
          quote: safeQuote(quote),
          completed,
          total: quote.shots.length,
          results,
          totalActualCostUsd: actualCosts.length > 0 ? Number(actualCosts.reduce((sum, cost) => sum + cost, 0).toFixed(6)) : undefined,
        };
      } catch (error) {
        return { ok: false, errorCode: "generated_shot_run_failed", message: error instanceof Error ? error.message : "缺失分镜生成失败" };
      }
    },
  };
}

module.exports = { GENERATED_SHOT_PROFILE, createShotGenerationService };
