import { useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  BadgeCheck,
  Check,
  CircleAlert,
  CircleCheck,
  Clapperboard,
  FileVideo,
  FolderUp,
  Info,
  Layers3,
  LockKeyhole,
  Play,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Upload,
  UserRound,
  WandSparkles,
} from "lucide-react";
import {
  adoptGeneratedShot,
  applyGeneratedShotResults,
  buildStoryboard,
  demoOwnerAssets,
  demoOwnerProfile,
  emptyOwnerProfile,
  generateMissingShots,
  generationPromptForShot,
  generateScriptVariant,
  getProfileCompletion,
  getStoryboardCoverage,
  inferAssetKind,
  isAssemblyReady,
  markShotsGenerating,
  narrativeTemplates,
  profileFields,
  recommendTemplate,
  type OwnerAsset,
  type OwnerProfile,
  type ScriptVariant,
  type StoryboardShot,
  type TemplateId,
} from "../lib/owner-creator-workflow";

type StageId = "profile" | "brief" | "script" | "shots" | "assembly";

const stages: Array<{ id: StageId; label: string; shortLabel: string }> = [
  { id: "profile", label: "老板资料", shortLabel: "资料" },
  { id: "brief", label: "视频方向", shortLabel: "方向" },
  { id: "script", label: "脚本版本", shortLabel: "脚本" },
  { id: "shots", label: "逐镜素材", shortLabel: "素材" },
  { id: "assembly", label: "拼合提案", shortLabel: "拼合" },
];

const assetKindLabels: Record<OwnerAsset["kind"], string> = {
  person: "本人出镜",
  store: "门店环境",
  product: "产品特写",
  process: "工作过程",
  customer: "客户案例",
  generic: "待 AI 识别",
};

const shotStatusLabels: Record<StoryboardShot["status"], string> = {
  matched: "已用实拍",
  missing: "待生成",
  generating: "生成中",
  generated_review: "待预览采用",
  generated: "已生成提案",
  failed: "生成未完成",
  blocked: "需要真实素材",
};

export function OwnerCreatorWorkbench({ openLegacyProjects, openEdit, workspaceReady, chooseWorkspace }: {
  openLegacyProjects: () => void;
  openEdit: () => void;
  workspaceReady: boolean;
  chooseWorkspace: () => Promise<void>;
}) {
  const [stage, setStage] = useState<StageId>("profile");
  const [profile, setProfile] = useState<OwnerProfile>(emptyOwnerProfile);
  const [profileSource, setProfileSource] = useState<"empty" | "demo" | "user">("empty");
  const [assets, setAssets] = useState<OwnerAsset[]>([]);
  const [entryMode, setEntryMode] = useState<"template" | "custom">("template");
  const [selectedTemplate, setSelectedTemplate] = useState<TemplateId>("behind-scenes");
  const [brief, setBrief] = useState("");
  const [followupAnswers, setFollowupAnswers] = useState<Record<string, string>>({});
  const [versions, setVersions] = useState<ScriptVariant[]>([]);
  const [activeVersionIndex, setActiveVersionIndex] = useState(0);
  const [shots, setShots] = useState<StoryboardShot[]>([]);
  const [profileError, setProfileError] = useState("");
  const [assemblyStatus, setAssemblyStatus] = useState<"idle" | "assembling" | "ready">("idle");
  const [flowNotice, setFlowNotice] = useState("");
  const [generationQuote, setGenerationQuote] = useState<GeneratedShotQuote | null>(null);
  const [generationState, setGenerationState] = useState<"idle" | "quoting" | "generating">("idle");
  const [generationError, setGenerationError] = useState("");
  const [generationSafetyHolds, setGenerationSafetyHolds] = useState<Record<string, string>>({});
  const fileInputRef = useRef<HTMLInputElement>(null);
  const completion = getProfileCompletion(profile);
  const activeVariant = versions[activeVersionIndex] ?? null;
  const coverage = getStoryboardCoverage(shots);
  const recommendedTemplate = recommendTemplate(brief);
  const chosenTemplate = entryMode === "custom" ? recommendedTemplate : selectedTemplate;
  const chosenTemplateInfo = narrativeTemplates.find((template) => template.id === chosenTemplate)!;
  const chosenFollowupAnswers = chosenTemplateInfo.followup.map((_, index) => followupAnswers[`${chosenTemplate}-${index}`] ?? "");
  const activeStageIndex = stages.findIndex((item) => item.id === stage);
  const generationCandidates = shots.filter((shot) =>
    (shot.status === "missing" || shot.status === "failed")
    && shot.generationAllowed
    && !generationSafetyHolds[shot.id]);
  const generationBatchCandidates = generationCandidates.slice(0, 5);
  const heldGenerationCount = Object.keys(generationSafetyHolds).length;

  function resetGenerationState() {
    setGenerationQuote(null);
    setGenerationState("idle");
    setGenerationError("");
    setGenerationSafetyHolds({});
  }

  const canOpenStage = (target: StageId) => {
    const targetIndex = stages.findIndex((item) => item.id === target);
    if (targetIndex <= activeStageIndex) return true;
    if (target === "brief") return completion.ready;
    if (target === "script") return versions.length > 0;
    if (target === "shots") return shots.length > 0;
    if (target === "assembly") return isAssemblyReady(shots);
    return false;
  };

  const assemblyStats = useMemo(() => ({
    real: shots.filter((shot) => shot.status === "matched").length,
    generated: shots.filter((shot) => shot.status === "generated").length,
    duration: shots.reduce((total, shot) => total + shot.targetSeconds, 0),
  }), [shots]);

  function resetAfterProfileChange() {
    if (versions.length > 0) setFlowNotice("资料已变化，原脚本和镜头已标记为过期，请重新生成。演示版已清空下游状态。");
    setVersions([]);
    setShots([]);
    setAssemblyStatus("idle");
    resetGenerationState();
  }

  function updateProfile(key: keyof OwnerProfile, value: string) {
    setProfile((current) => ({ ...current, [key]: value }));
    setProfileSource("user");
    setProfileError("");
    resetAfterProfileChange();
  }

  function loadDemo() {
    setProfile(demoOwnerProfile);
    setProfileSource("demo");
    setAssets(demoOwnerAssets);
    setSelectedTemplate("behind-scenes");
    setEntryMode("template");
    setBrief("拍一条早餐店从凌晨备料到出餐的幕后视频");
    setFollowupAnswers({});
    setVersions([]);
    setShots([]);
    setAssemblyStatus("idle");
    resetGenerationState();
    setProfileError("");
    setFlowNotice("已载入“王姐早餐店”演示资料。示例事实和素材仅用于体验这条产品流程。");
  }

  function continueFromProfile() {
    if (!completion.ready) {
      const missing = profileFields.filter(({ key }) => !profile[key].trim()).map(({ label }) => label).slice(0, 3);
      setProfileError(`还差 ${completion.total - completion.completed} 项：${missing.join("、")}${completion.total - completion.completed > 3 ? "等" : ""}。`);
      return;
    }
    setProfileError("");
    setStage("brief");
  }

  function handleFiles(files: FileList | null) {
    if (!files?.length) return;
    const nextAssets = Array.from(files).map((file, index): OwnerAsset => ({
      id: `upload-${Date.now()}-${index}`,
      name: file.name,
      kind: inferAssetKind(file.name),
      durationLabel: "待本地分析",
      rightsConfirmed: false,
      source: "upload",
    }));
    setAssets((current) => [...current, ...nextAssets]);
    setFlowNotice(`已读取 ${nextAssets.length} 个文件的名称与类型；请逐条确认使用权。`);
    setShots([]);
    setAssemblyStatus("idle");
    resetGenerationState();
  }

  function toggleAssetRights(assetId: string) {
    setAssets((current) => current.map((asset) => asset.id === assetId ? { ...asset, rightsConfirmed: !asset.rightsConfirmed } : asset));
    setShots([]);
    setAssemblyStatus("idle");
    resetGenerationState();
  }

  function removeAsset(assetId: string) {
    setAssets((current) => current.filter((asset) => asset.id !== assetId));
    setShots([]);
    setAssemblyStatus("idle");
    resetGenerationState();
  }

  function createFirstScript() {
    const resolvedBrief = brief.trim() || `${profile.displayName}的${chosenTemplateInfo.label}视频`;
    const first = generateScriptVariant({ profile, templateId: chosenTemplate, brief: resolvedBrief, version: 1, followupAnswers: chosenFollowupAnswers });
    setSelectedTemplate(chosenTemplate);
    setBrief(resolvedBrief);
    setVersions([first]);
    setActiveVersionIndex(0);
    setShots([]);
    setAssemblyStatus("idle");
    resetGenerationState();
    setStage("script");
    setFlowNotice(entryMode === "custom" ? `已把你的意图映射为“${chosenTemplateInfo.label}”结构；你仍可返回改选。` : "已生成第一版。每段都显示使用了哪些资料。" );
  }

  function createAnotherVersion() {
    const nextVersionNumber = Math.max(...versions.map((version) => version.version), 0) + 1;
    const templateInfo = narrativeTemplates.find((template) => template.id === selectedTemplate)!;
    const answers = templateInfo.followup.map((_, index) => followupAnswers[`${selectedTemplate}-${index}`] ?? "");
    const next = generateScriptVariant({ profile, templateId: selectedTemplate, brief, version: nextVersionNumber, followupAnswers: answers });
    setVersions((current) => [...current, next]);
    setActiveVersionIndex(versions.length);
    setShots([]);
    setAssemblyStatus("idle");
    resetGenerationState();
    setFlowNotice(`已保留旧版，并新增脚本 v${nextVersionNumber}。`);
  }

  function updateBeat(beatId: string, text: string) {
    setVersions((current) => current.map((variant, index) => index === activeVersionIndex
      ? { ...variant, beats: variant.beats.map((beat) => beat.id === beatId ? { ...beat, text } : beat) }
      : variant));
    setShots([]);
    setAssemblyStatus("idle");
    resetGenerationState();
  }

  function confirmScriptAndMatch() {
    if (!activeVariant) return;
    const nextShots = buildStoryboard(activeVariant, assets);
    setShots(nextShots);
    setAssemblyStatus("idle");
    resetGenerationState();
    setStage("shots");
    setFlowNotice(nextShots.some((shot) => shot.status === "blocked")
      ? "有镜头需要真实素材，系统不会用生成画面伪造本人、客户或真实过程。"
      : "已优先匹配有授权的实拍素材，并把剩余缺口集中列出。" );
  }

  async function requestGenerationQuote() {
    if (generationState !== "idle") return;
    if (!window.desktop) {
      setShots(generateMissingShots(shots));
      setFlowNotice("浏览器演示已创建本地示意提案；安装并从桌面端打开后才会显示真实报价和调用 APIMart。" );
      return;
    }
    if (!workspaceReady) {
      setGenerationError("真实生成需要一个本地工作区来保存和校验视频。请先选择工作区，再点击生成。" );
      await chooseWorkspace();
      return;
    }
    const candidates = generationBatchCandidates;
    if (candidates.length === 0) {
      setGenerationError(heldGenerationCount > 0
        ? "这些分镜有尚未核清的 Provider 任务。为避免重复扣费，已暂停重新提交。"
        : "当前没有可以生成的素材缺口。" );
      return;
    }
    setGenerationState("quoting");
    setGenerationError("");
    try {
      const result = await window.desktop.quoteGeneratedShots({ shots: candidates.map((shot) => ({ shotId: shot.id, prompt: generationPromptForShot(shot), materialKind: shot.materialKind })) });
      if (!result.ok || !result.quote) throw new Error(result.message ?? "无法取得生成报价");
      setGenerationQuote(result.quote);
      setFlowNotice("报价已就绪。请核对模型、数量和预计总价；只有点击“确认并付费生成”才会提交。" );
    } catch (error) {
      setGenerationError(error instanceof Error ? error.message : "无法取得生成报价");
    } finally {
      setGenerationState("idle");
    }
  }

  async function confirmGeneratedShots() {
    if (!window.desktop || !generationQuote || generationState === "generating") return;
    const quote = generationQuote;
    const quotedShotIds = new Set(quote.shots.map((shot) => shot.shotId));
    setGenerationState("generating");
    setGenerationError("");
    setShots((current) => {
      const marked = markShotsGenerating(current);
      return marked.map((shot, index) => quotedShotIds.has(shot.id) ? shot : current[index]);
    });
    try {
      const result = await window.desktop.runGeneratedShots(quote.id);
      const generatedResults = result.results ?? [];
      setShots((current) => applyGeneratedShotResults(current, generatedResults));
      const safetyHolds = Object.fromEntries(generatedResults
        .filter((item) => item.status === "submission_unknown" || item.status === "needs_attention")
        .map((item) => [item.shotId, item.message ?? "Provider 任务需要人工核查，已暂停重复提交。"]));
      if (Object.keys(safetyHolds).length > 0) setGenerationSafetyHolds((current) => ({ ...current, ...safetyHolds }));
      if (!result.ok) {
        const firstFailure = generatedResults.find((item) => !item.ok);
        setGenerationError(firstFailure?.message ?? result.message ?? `已完成 ${result.completed ?? 0}/${result.total ?? quote.shots.length} 个分镜；未完成项可以重新报价。`);
      }
      const actualCostUsd = result.totalActualCostUsd;
      const costNotice = typeof actualCostUsd === "number" ? ` 本轮 Provider 返回实际费用 $${actualCostUsd.toFixed(3)}。` : "";
      setFlowNotice(result.ok
        ? `生成视频已下载并通过本地校验。${costNotice}请逐镜打开预览并明确采用，之后才能进入拼合。`
        : `本轮生成未全部完成；已成功的视频仍可预览采用，系统不会自动重复提交未知任务。${costNotice}` );
    } catch (error) {
      setShots((current) => applyGeneratedShotResults(current, []));
      setGenerationError(error instanceof Error ? error.message : "生成请求未完成");
    } finally {
      setGenerationQuote(null);
      setGenerationState("idle");
    }
  }

  async function openGeneratedShot(shot: StoryboardShot) {
    if (!window.desktop || !shot.localRelativePath) return;
    const result = await window.desktop.openWorkspaceFile(shot.localRelativePath);
    if (!result.ok) setGenerationError(result.message ?? "无法打开生成视频");
  }

  function adoptGeneratedMaterial(shotId: string) {
    setShots((current) => adoptGeneratedShot(current, shotId));
    setAssemblyStatus("idle");
    setFlowNotice("已采用这份 AI 生成素材；它会在拼合清单中保持 AI 标记。" );
  }

  function openAssembly() {
    if (!isAssemblyReady(shots)) return;
    setAssemblyStatus("idle");
    setStage("assembly");
  }

  function assemblePreview() {
    if (!isAssemblyReady(shots) || assemblyStatus === "assembling") return;
    setAssemblyStatus("assembling");
    window.setTimeout(() => setAssemblyStatus("ready"), 900);
  }

  return (
    <section className="owner-studio" aria-label="老板短视频创作流水线">
      <header className="owner-studio-header">
        <div>
          <h1>从你的资料和实拍开始，做完一条视频。</h1>
          <p>先确认“你是谁、做什么生意”，再生成脚本、匹配素材、补齐分镜。桌面端只有在你看过预计费用并明确确认后，才会调用付费生成服务。</p>
        </div>
        <div className="owner-studio-trust"><ShieldCheck size={18} /><div><strong>本地优先</strong><span>资料变化会让下游结果过期，不会静默覆盖。</span></div></div>
      </header>

      <nav className="owner-stage-nav" aria-label="创作步骤">
        {stages.map((item, index) => {
          const completed = index < activeStageIndex;
          const enabled = canOpenStage(item.id);
          return <button key={item.id} className={`${item.id === stage ? "active" : ""} ${completed ? "completed" : ""}`} disabled={!enabled} onClick={() => enabled && setStage(item.id)} aria-current={item.id === stage ? "step" : undefined}><span>{completed ? <Check size={14} /> : index + 1}</span><b>{item.label}</b><small>{item.shortLabel}</small></button>;
        })}
      </nav>

      {flowNotice && <div className="owner-flow-notice" role="status"><Info size={16} /><span>{flowNotice}</span><button onClick={() => setFlowNotice("")} aria-label="关闭提示">知道了</button></div>}

      {stage === "profile" && <section className="owner-stage-panel profile-stage">
        <div className="owner-stage-heading"><div><h2>先告诉原点，你是谁、做什么生意</h2><p>先回答 9 个核心问题。年龄、城市等资料可以以后按模板补充。</p></div><button className="owner-demo-button" onClick={loadDemo}><Sparkles size={16} /> 使用“王姐早餐店”演示资料</button></div>
        <div className="profile-progress"><div><strong>{completion.completed}/{completion.total} 项已完成</strong><span>{completion.ready ? "可以生成个性化脚本" : "填完核心资料即可继续"}</span></div><progress value={completion.completed} max={completion.total} /></div>
        <div className="owner-profile-grid">{profileFields.map((field) => <label key={field.key} className={field.wide ? "wide" : ""}><span>{field.label}</span>{field.wide && field.key !== "audiencePain" && field.key !== "differentiation" && field.key !== "contentGoal" ? <textarea value={profile[field.key]} onChange={(event) => updateProfile(field.key, event.target.value)} placeholder={field.placeholder} /> : <input value={profile[field.key]} onChange={(event) => updateProfile(field.key, event.target.value)} placeholder={field.placeholder} />}<small>{field.why}</small></label>)}</div>
        <details className="owner-optional-profile"><summary>按需要补充年龄段和服务城市</summary><div><label><span>年龄段（选填）</span><select value={profile.ageBand} onChange={(event) => updateProfile("ageBand", event.target.value)}><option value="">暂不填写</option><option>20–29 岁</option><option>30–39 岁</option><option>40–49 岁</option><option>50–59 岁</option><option>60 岁以上</option></select><small>只用于你主动选择的表达语境，不采集生日。</small></label><label><span>城市或服务区域（选填）</span><input value={profile.city} onChange={(event) => updateProfile("city", event.target.value)} placeholder="例如：杭州城西、本地社区" /><small>不需要家庭住址或精确定位。</small></label></div></details>
        <section className="owner-assets-panel"><div className="owner-assets-heading"><div><h3>上传你已经拍过的真实视频</h3><p>建议上传本人、门店、产品和工作过程。脚本可以先生成，素材会在分镜阶段自动匹配。</p></div><button className="secondary-button" onClick={() => fileInputRef.current?.click()}><Upload size={16} /> 选择视频</button><input ref={fileInputRef} type="file" accept="video/*" multiple hidden onChange={(event) => { handleFiles(event.target.files); event.currentTarget.value = ""; }} /></div>{assets.length === 0 ? <button className="owner-assets-empty" onClick={() => fileInputRef.current?.click()}><FolderUp size={28} /><strong>还没有实拍素材</strong><span>可跳过；有素材时优先使用真实画面，缺口再生成。</span></button> : <div className="owner-asset-list">{assets.map((asset) => <article key={asset.id}><div className="owner-asset-icon"><FileVideo size={18} /></div><div><strong>{asset.name}</strong><span>{assetKindLabels[asset.kind]} · {asset.durationLabel}</span></div><button className={asset.rightsConfirmed ? "rights-confirmed" : "rights-pending"} onClick={() => toggleAssetRights(asset.id)} aria-pressed={asset.rightsConfirmed}>{asset.rightsConfirmed ? <CircleCheck size={15} /> : <CircleAlert size={15} />}{asset.rightsConfirmed ? "本项目可用" : "确认使用权"}</button><button className="asset-remove" onClick={() => removeAsset(asset.id)} aria-label={`移除 ${asset.name}`}>移除</button></article>)}</div>}<p className="owner-assets-privacy"><LockKeyhole size={14} /> 浏览器预览只读取文件名和类型；桌面端正式导入需记录肖像、声音、商用及衍生生成授权。</p></section>
        {profileError && <div className="owner-inline-error" role="alert"><CircleAlert size={16} />{profileError}</div>}
        <div className="owner-stage-actions"><button className="text-button" onClick={openLegacyProjects}>打开旧创作工作台</button><button className="owner-primary" onClick={continueFromProfile}>保存资料，决定这条视频 <ArrowRight size={17} /></button></div>
      </section>}

      {stage === "brief" && <section className="owner-stage-panel brief-stage">
        <div className="owner-stage-heading"><div><h2>这条视频，想让谁看完做什么？</h2><p>选一个固定结构，或者用一句话描述想法。自定义意图也会先映射到可审阅结构。</p></div><button className="owner-back" onClick={() => setStage("profile")}><ArrowLeft size={16} /> 返回资料</button></div>
        <div className="brief-entry-switch" role="tablist"><button className={entryMode === "template" ? "active" : ""} onClick={() => setEntryMode("template")} role="tab" aria-selected={entryMode === "template"}>从固定模板开始</button><button className={entryMode === "custom" ? "active" : ""} onClick={() => setEntryMode("custom")} role="tab" aria-selected={entryMode === "custom"}>描述我想做的视频</button></div>
        <div className="template-layout"><div className="template-list">{narrativeTemplates.map((template) => <button key={template.id} className={selectedTemplate === template.id && entryMode === "template" ? "selected" : ""} onClick={() => { setEntryMode("template"); setSelectedTemplate(template.id); }}><span className="template-radio">{selectedTemplate === template.id && entryMode === "template" ? <Check size={13} /> : null}</span><div><strong>{template.label}</strong><p>{template.description}</p><small>适合：{template.bestFor}</small></div><ArrowRight size={15} /></button>)}</div><aside className="template-context"><div className="template-context-title"><Layers3 size={18} /><strong>{chosenTemplateInfo.label}</strong></div>{entryMode === "custom" && <div className="template-recommendation"><WandSparkles size={15} /><span>根据你的描述，建议先用这个结构；生成前仍由你确认。</span></div>}<label><span>这条视频具体想讲什么？</span><textarea value={brief} onChange={(event) => setBrief(event.target.value)} placeholder="例如：拍一条从凌晨备料到第一笼包子出锅的幕后视频" /></label><div className="template-followup"><strong>按这个模板补充（选填）</strong>{chosenTemplateInfo.followup.map((question, index) => <label key={question}><span>{question}</span><input value={followupAnswers[`${chosenTemplate}-${index}`] ?? ""} onChange={(event) => setFollowupAnswers((current) => ({ ...current, [`${chosenTemplate}-${index}`]: event.target.value }))} placeholder="不知道可以留空，AI 不会自行补造" /></label>)}</div><div className="template-source-summary"><UserRound size={16} /><p>将使用 <b>{profile.displayName}</b> 的身份、业务、客户痛点、差异化、补充回答和内容边界。</p></div></aside></div>
        <div className="owner-stage-actions"><button className="owner-back" onClick={() => setStage("profile")}><ArrowLeft size={16} /> 上一步</button><button className="owner-primary" onClick={createFirstScript}><Sparkles size={17} /> 生成第一版脚本</button></div>
      </section>}

      {stage === "script" && activeVariant && <section className="owner-stage-panel script-stage">
        <div className="owner-stage-heading"><div><h2>脚本已经按你的资料填好</h2><p>每一段都标出资料来源。修改后再生成分镜；“换一版”会保留当前版本。</p></div><div className="script-heading-actions"><button className="secondary-button" onClick={() => setStage("brief")}><ArrowLeft size={16} /> 改方向</button><button className="secondary-button" onClick={createAnotherVersion}><RefreshCw size={16} /> 换一版</button></div></div>
        <div className="script-version-tabs" role="tablist">{versions.map((variant, index) => <button key={variant.id} className={index === activeVersionIndex ? "active" : ""} onClick={() => setActiveVersionIndex(index)} role="tab" aria-selected={index === activeVersionIndex}><span>v{variant.version}</span><small>{variant.templateId === selectedTemplate ? chosenTemplateInfo.label : variant.templateId}</small></button>)}</div>
        <div className="script-summary-line"><div><BadgeCheck size={17} /><span>资料快照：{profileSource === "demo" ? "王姐演示资料" : "本次填写"}</span></div><div><span>结构：{chosenTemplateInfo.label}</span><span>预计 {activeVariant.estimatedSeconds} 秒</span><span>{activeVariant.beats.length} 个段落</span></div></div>
        <div className="owner-script-beats">{activeVariant.beats.map((beat, index) => <article key={beat.id}><div className="script-beat-order">{String(index + 1).padStart(2, "0")}</div><div className="script-beat-main"><div className="script-beat-heading"><strong>{beat.label}</strong><span>{beat.sourceLabels.map((source) => `资料：${source}`).join(" · ")}</span></div><textarea aria-label={`编辑“${beat.label}”台词`} value={beat.text} onChange={(event) => updateBeat(beat.id, event.target.value)} /><div className="script-beat-visual"><FileVideo size={14} /><span>{beat.visualDirection}</span><b>{beat.generationAllowed ? "缺口可生成" : "必须用真实素材"}</b></div></div></article>)}</div>
        <div className="owner-stage-actions"><button className="owner-back" onClick={() => setStage("brief")}><ArrowLeft size={16} /> 上一步</button><button className="owner-primary" onClick={confirmScriptAndMatch}>确认脚本，自动匹配素材 <ArrowRight size={17} /></button></div>
      </section>}

      {stage === "shots" && <section className="owner-stage-panel shots-stage">
        <div className="owner-stage-heading"><div><h2>每个分镜，都有明确的素材去向</h2><p>先用已授权实拍；缺口再生成。本人、客户和真实过程不会被合成画面冒充。</p></div><button className="owner-back" onClick={() => setStage("script")}><ArrowLeft size={16} /> 返回脚本</button></div>
        <div className="coverage-summary">
          <div><strong>{coverage.ready}/{coverage.total}</strong><span>镜头已经就绪</span></div>
          <div className="coverage-track"><span style={{ width: `${coverage.total ? coverage.ready / coverage.total * 100 : 0}%` }} /></div>
          <div className="coverage-counts">
            <span><i className="matched" />已用实拍 {shots.filter((shot) => shot.status === "matched").length}</span>
            <span><i className="missing" />待生成/重试 {coverage.missing}</span>
            <span><i className="generating" />生成中 {coverage.generating}</span>
            <span><i className="review" />待预览采用 {coverage.review}</span>
            <span><i className="blocked" />需真实素材 {coverage.blocked}</span>
          </div>
        </div>
        <div className="shot-coverage-list">{shots.map((shot) => {
          const safetyHold = generationSafetyHolds[shot.id];
          return <article key={shot.id} className={`shot-row status-${shot.status}`}>
            <div className="shot-preview"><Play size={18} /><span>{String(shot.order + 1).padStart(2, "0")}</span></div>
            <div className="shot-copy"><div><strong>{shot.purpose}</strong><span>{shot.targetSeconds} 秒 · {shot.materialKind}</span></div><p>{shot.line}</p><small>{shot.matchReason}</small></div>
            <div className="shot-material">
              <span className={`shot-status ${shot.status}`}>{shotStatusLabels[shot.status]}</span>
              <strong>{shot.assetLabel ?? "暂无素材"}</strong>
              {(shot.status === "missing" || shot.status === "failed") && !safetyHold
                ? <button onClick={() => void requestGenerationQuote()}>给全部缺口看报价</button>
                : shot.status === "generating"
                  ? <span className="shot-material-note"><RefreshCw className="spin" size={12} /> 正在生成并回收到本地</span>
                  : shot.status === "generated_review"
                    ? <div className="shot-review-actions">
                      <button disabled={!shot.localRelativePath} onClick={() => void openGeneratedShot(shot)}>{shot.localRelativePath ? "打开视频预览" : "演示素材无本地文件"}</button>
                      <button className="adopt" onClick={() => adoptGeneratedMaterial(shot.id)}>采用这份素材</button>
                    </div>
                    : shot.status === "generated"
                      ? <span className="shot-material-note"><CircleCheck size={12} /> 已采用，可以进入拼合</span>
                      : safetyHold
                        ? <span className="shot-material-note attention">已暂停重试，先核查 Provider 任务</span>
                        : <button onClick={() => setStage("profile")}>{shot.status === "matched" ? "回资料页更换" : "回资料页上传"}</button>}
            </div>
          </article>;
        })}</div>
        {generationError && <div className="owner-inline-error" role="alert"><CircleAlert size={16} />{generationError}</div>}
        {generationState === "generating" && <section className="generation-batch generation-running" aria-live="polite"><div><RefreshCw className="spin" size={20} /><div><strong>正在生成 {generationQuote?.shots.length ?? generationCandidates.length} 个分镜</strong><p>正在等待 Provider 完成、下载视频并做本地校验。请保持应用打开；不会因刷新状态而重复提交。</p></div></div></section>}
        {coverage.missing > 0 && generationState !== "generating" && !generationQuote && generationCandidates.length > 0 && <section className="generation-batch"><div><WandSparkles size={20} /><div><strong>发现 {generationCandidates.length} 个允许生成的缺口</strong><p>先取得本轮预计费用；看报价不会提交任务，也不会扣费。{generationCandidates.length > 5 ? "为控制费用，本轮先处理前 5 个，其余下一轮再确认。" : ""}</p></div></div><button className="owner-generate" onClick={() => void requestGenerationQuote()} disabled={generationState === "quoting"}>{generationState === "quoting" ? <><RefreshCw className="spin" size={16} /> 正在获取报价…</> : <><Sparkles size={16} /> 先看报价</>}</button></section>}
        {generationQuote && generationState !== "generating" && <section className="generation-quote" aria-label="AI 分镜生成报价">
          <div className="generation-quote-heading"><div><span>付费前确认</span><h3>{generationQuote.modelLabel}</h3><p>{generationQuote.shots.length} 个分镜 · 每个 {generationQuote.durationSeconds} 秒 · 竖屏 {generationQuote.aspectRatio}</p></div><ShieldCheck size={22} /></div>
          <dl className="generation-quote-grid">
            <div><dt>预计每镜</dt><dd>${generationQuote.estimatedCostPerShotUsd.toFixed(3)}</dd></div>
            <div><dt>预计总费用</dt><dd>${generationQuote.estimatedTotalCostUsd.toFixed(3)} USD</dd></div>
            <div><dt>价格核对日期</dt><dd>{generationQuote.priceCheckedAt}</dd></div>
          </dl>
          <p className="generation-quote-note">这是按公开单价计算的预计费用，实际扣费以 Provider 返回结果为准。点击下面的深色按钮后才会逐镜提交付费任务。</p>
          <div className="generation-quote-actions"><button className="text-button" onClick={() => void window.desktop?.openExternal(generationQuote.priceSourceUrl)}>查看价格来源</button><button className="secondary-button" onClick={() => setGenerationQuote(null)}>取消</button><button className="owner-generate generation-confirm" onClick={() => void confirmGeneratedShots()}>确认并付费生成（预计 ${generationQuote.estimatedTotalCostUsd.toFixed(3)}）</button></div>
        </section>}
        {coverage.review > 0 && <div className="generation-review-notice"><Play size={17} /><div><strong>有 {coverage.review} 个视频等待你决定</strong><p>逐个打开本地视频预览；只有点击“采用这份素材”，这个镜头才会进入拼合清单。</p></div></div>}
        {heldGenerationCount > 0 && <div className="owner-inline-error generation-hold" role="alert"><ShieldCheck size={16} />有 {heldGenerationCount} 个 Provider 任务状态尚未核清。为避免重复扣费，已暂停这些分镜的再次生成。</div>}
        {coverage.blocked > 0 && <div className="owner-inline-error" role="alert"><CircleAlert size={16} />还有 {coverage.blocked} 个镜头需要本人、客户授权或真实过程素材，不能用 AI 伪造。请返回资料上传或更换脚本结构。</div>}
        <div className="owner-stage-actions"><button className="owner-back" onClick={() => setStage("script")}><ArrowLeft size={16} /> 上一步</button><button className="owner-primary" disabled={!isAssemblyReady(shots)} onClick={openAssembly}>{isAssemblyReady(shots) ? "镜头已采用，进入拼合" : coverage.review > 0 ? `还有 ${coverage.review} 个生成视频待采用` : "镜头未齐，暂不能拼合"} <ArrowRight size={17} /></button></div>
      </section>}

      {stage === "assembly" && <section className="owner-stage-panel assembly-stage">
        <div className="owner-stage-heading"><div><h2>所有镜头已经排好，确认后创建拼合提案</h2><p>拼合使用当前冻结的脚本和素材顺序，不会在执行中重新选择或改写。</p></div><button className="owner-back" onClick={() => setStage("shots")}><ArrowLeft size={16} /> 返回替换镜头</button></div>
        <div className="assembly-board"><div className="assembly-player"><div className="assembly-player-screen"><div className="assembly-play"><Play size={26} fill="currentColor" /></div><span>{assemblyStatus === "ready" ? "拼合提案 v1 已就绪" : assemblyStatus === "assembling" ? "正在按冻结清单创建提案…" : "等待确认拼合"}</span></div><div className="assembly-timeline">{shots.map((shot, index) => <div key={shot.id} className={shot.status === "generated" ? "generated" : "real"} style={{ flex: Math.max(1, shot.targetSeconds) }}><span>{String(index + 1).padStart(2, "0")}</span><small>{shot.status === "generated" ? "AI" : "实拍"}</small></div>)}</div></div><aside className="assembly-manifest"><h3>冻结清单</h3><dl><div><dt>脚本</dt><dd>v{activeVariant?.version ?? 1} · {activeVariant?.beats.length ?? 0} 段</dd></div><div><dt>镜头</dt><dd>{shots.length} 个 · {assemblyStats.duration} 秒</dd></div><div><dt>实拍</dt><dd>{assemblyStats.real} 个</dd></div><div><dt>生成提案</dt><dd>{assemblyStats.generated} 个</dd></div><div><dt>空镜头</dt><dd>0 个</dd></div></dl><div className="assembly-safety"><ShieldCheck size={16} /><span>当前清单只使用标记为“本项目可用”的实拍和你已经预览采用的 AI 视频；正式导出前仍需复核授权。</span></div><button className="owner-assemble" onClick={assemblePreview} disabled={assemblyStatus === "assembling"}>{assemblyStatus === "assembling" ? <><RefreshCw className="spin" size={17} /> 正在拼合…</> : assemblyStatus === "ready" ? <><CircleCheck size={17} /> 重新创建拼合提案</> : <><Clapperboard size={17} /> 一键拼合</>}</button><p>当前阶段会创建拼合交互提案，暂不输出最终 MP4；前一步已确认生成的视频会从本地冻结清单读取。</p></aside></div>
        {assemblyStatus === "ready" && <section className="assembly-success" aria-live="polite"><CircleCheck size={23} /><div><strong>拼合提案 v1 已就绪</strong><p>你可以返回替换任一镜头后重新拼合，或进入现有 AI 剪辑工作台继续查看真实渲染链路。</p></div><button className="secondary-button" onClick={openEdit}>进入 AI 剪辑 <ArrowRight size={16} /></button></section>}
        <div className="owner-stage-actions"><button className="owner-back" onClick={() => setStage("shots")}><ArrowLeft size={16} /> 上一步</button><button className="text-button" onClick={openLegacyProjects}>查看旧创作项目</button></div>
      </section>}
    </section>
  );
}
