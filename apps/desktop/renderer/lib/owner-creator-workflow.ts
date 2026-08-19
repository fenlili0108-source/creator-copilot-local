export type OwnerProfile = {
  displayName: string;
  publicIdentity: string;
  industry: string;
  offering: string;
  audience: string;
  audiencePain: string;
  differentiation: string;
  persona: string;
  contentGoal: string;
  boundaries: string;
  ageBand?: string;
  city?: string;
};

export type ProfileFieldKey = keyof Pick<
  OwnerProfile,
  | "displayName"
  | "publicIdentity"
  | "offering"
  | "audience"
  | "audiencePain"
  | "differentiation"
  | "persona"
  | "contentGoal"
  | "boundaries"
>;

export type OwnerAssetKind = "person" | "store" | "product" | "process" | "customer" | "generic";

export type OwnerAsset = {
  id: string;
  name: string;
  kind: OwnerAssetKind;
  durationLabel: string;
  rightsConfirmed: boolean;
  source: "demo" | "upload";
};

export type TemplateId = "intro" | "pain-solution" | "knowledge" | "case" | "behind-scenes";

export type NarrativeTemplate = {
  id: TemplateId;
  label: string;
  description: string;
  bestFor: string;
  followup: string[];
};

export type ScriptBeat = {
  id: string;
  label: string;
  text: string;
  sourceLabels: string[];
  materialKind: OwnerAssetKind | "graphic";
  visualDirection: string;
  generationAllowed: boolean;
  required: boolean;
};

export type ScriptVariant = {
  id: string;
  version: number;
  templateId: TemplateId;
  brief: string;
  title: string;
  estimatedSeconds: number;
  beats: ScriptBeat[];
};

export type ShotMaterialStatus = "matched" | "missing" | "generating" | "generated_review" | "generated" | "failed" | "blocked";

export type StoryboardShot = {
  id: string;
  order: number;
  beatId: string;
  line: string;
  purpose: string;
  targetSeconds: number;
  materialKind: OwnerAssetKind | "graphic";
  status: ShotMaterialStatus;
  assetId?: string;
  assetLabel?: string;
  providerTaskId?: string;
  artifactId?: string;
  localRelativePath?: string;
  matchReason: string;
  generationAllowed: boolean;
  required: boolean;
};

export const profileFields: Array<{
  key: ProfileFieldKey;
  label: string;
  placeholder: string;
  why: string;
  wide?: boolean;
}> = [
  { key: "displayName", label: "大家怎么称呼你？", placeholder: "例如：王姐、阿成师傅", why: "用于开场称呼，不要求填写实名。" },
  { key: "publicIdentity", label: "你做什么行业、以什么身份出镜？", placeholder: "例如：餐饮行业的社区早餐店老板", why: "用于一句话说明你是谁，并决定行业表达。", wide: true },
  { key: "offering", label: "你主要卖什么或提供什么？", placeholder: "例如：每天现做的包子和豆浆", why: "决定视频里的产品与服务主体。", wide: true },
  { key: "audience", label: "你最想服务哪类人？", placeholder: "例如：附近赶早班的上班族", why: "决定这条视频在对谁说。" },
  { key: "audiencePain", label: "他们最头疼什么？", placeholder: "例如：早上赶时间，又想吃口热乎的", why: "用于前三秒钩子和客户场景。", wide: true },
  { key: "differentiation", label: "客户为什么选择你？", placeholder: "例如：凌晨到店现包，当天做当天卖", why: "用于核心观点和证明镜头。", wide: true },
  { key: "persona", label: "你希望观众觉得你是个怎样的人？", placeholder: "例如：实在、利落、温暖", why: "决定句长、语气和表达力度。" },
  { key: "contentGoal", label: "这阶段最想实现什么目标？", placeholder: "例如：让附近顾客愿意到店尝一次", why: "用于脚本结尾和行动提示。", wide: true },
  { key: "boundaries", label: "哪些话题、承诺或人物绝对不能出现？", placeholder: "例如：不贬低同行；不拍顾客正脸；不说“全城最好”", why: "作为生成硬边界，不会直接写进台词。", wide: true },
];

export const emptyOwnerProfile: OwnerProfile = {
  displayName: "",
  publicIdentity: "",
  industry: "",
  offering: "",
  audience: "",
  audiencePain: "",
  differentiation: "",
  persona: "",
  contentGoal: "",
  boundaries: "",
  ageBand: "",
  city: "",
};

export const demoOwnerProfile: OwnerProfile = {
  displayName: "王姐",
  publicIdentity: "开了 12 年社区早餐店的老板",
  industry: "餐饮 · 社区早餐",
  offering: "每天现做的包子、豆浆和早餐套餐",
  audience: "附近赶早班、又想吃口热乎饭的上班族",
  audiencePain: "早上时间紧，怕排队，也担心吃到放久了的早餐",
  differentiation: "凌晨四点半到店备料，包子当天现包现蒸，出餐流程利落",
  persona: "实在、利落、说话不绕弯",
  contentGoal: "让附近的新顾客愿意到店尝一次",
  boundaries: "不贬低同行；不说全城最好；不出现未授权顾客正脸",
  ageBand: "40–49 岁",
  city: "本地社区",
};

export const demoOwnerAssets: OwnerAsset[] = [
  { id: "demo-person", name: "王姐正面自我介绍.mp4", kind: "person", durationLabel: "00:32", rightsConfirmed: true, source: "demo" },
  { id: "demo-store", name: "早餐店门头清晨外景.mp4", kind: "store", durationLabel: "00:08", rightsConfirmed: true, source: "demo" },
  { id: "demo-process", name: "凌晨备料与现包过程.mp4", kind: "process", durationLabel: "00:21", rightsConfirmed: true, source: "demo" },
  { id: "demo-product", name: "包子出笼与豆浆特写.mp4", kind: "product", durationLabel: "00:12", rightsConfirmed: true, source: "demo" },
];

export const narrativeTemplates: NarrativeTemplate[] = [
  { id: "intro", label: "老板自我介绍", description: "让附近的人先记住你、你做什么，以及你为什么坚持。", bestFor: "新账号、置顶视频、品牌建立", followup: ["为什么入行？", "最想坚持的经营原则是什么？"] },
  { id: "pain-solution", label: "客户痛点", description: "从客户正在经历的问题切入，再展示你的解决方式。", bestFor: "咨询、到店、产品转化", followup: ["客户最常见的顾虑是什么？", "什么人不适合这项服务？"] },
  { id: "knowledge", label: "知识避坑", description: "用专业经验解释一个误区、步骤或判断方法。", bestFor: "建立信任、关注、咨询", followup: ["有哪些可核验的专业依据？", "需要提醒什么适用边界？"] },
  { id: "case", label: "真实案例", description: "讲一个经授权、可证明的客户过程，而不是编一段见证。", bestFor: "服务证明、异议处理", followup: ["客户是否授权公开？", "结果与数字的证据在哪里？"] },
  { id: "behind-scenes", label: "幕后过程", description: "把门店、产品和真实工作过程变成可看的故事。", bestFor: "探店、产品、同城内容", followup: ["最值得拍的一个步骤是什么？", "门店或产品有哪些公开信息？"] },
];

export function getProfileCompletion(profile: OwnerProfile) {
  const completed = profileFields.filter(({ key }) => profile[key].trim().length > 0).length;
  return { completed, total: profileFields.length, ready: completed === profileFields.length };
}

export function inferAssetKind(fileName: string): OwnerAssetKind {
  const name = fileName.toLowerCase();
  if (/老板|本人|介绍|口播|正面/.test(name)) return "person";
  if (/门店|门头|外景|环境|店内/.test(name)) return "store";
  if (/产品|成品|包子|菜品|商品|细节/.test(name)) return "product";
  if (/过程|制作|备料|服务|工作|操作/.test(name)) return "process";
  if (/客户|顾客|案例/.test(name)) return "customer";
  return "generic";
}

export function recommendTemplate(brief: string): TemplateId {
  if (/过程|幕后|一天|怎么做|制作|探店|门店/.test(brief)) return "behind-scenes";
  if (/案例|顾客|客户|变化|前后/.test(brief)) return "case";
  if (/避坑|为什么|误区|怎么选|方法|知识/.test(brief)) return "knowledge";
  if (/介绍|认识|我是谁|创业/.test(brief)) return "intro";
  return "pain-solution";
}

function callToAction(profile: OwnerProfile) {
  if (/到店|门店|尝/.test(profile.contentGoal)) return "如果你就在附近，也有同样的需求，可以先来看看真实过程，再决定适不适合你。";
  if (/咨询|联系|线索/.test(profile.contentGoal)) return "如果你正被这个问题困住，可以把具体情况留在评论里，我会先帮你判断方向。";
  if (/关注|涨粉|信任/.test(profile.contentGoal)) return "如果你想继续看我怎么做这门生意，可以先关注，下一条我把过程讲得更具体。";
  return "如果这正好是你关心的问题，可以先收藏，再按自己的情况做判断。";
}

function alternate(primary: string, secondary: string, version: number) {
  return version % 2 === 0 ? secondary : primary;
}

export function generateScriptVariant(input: {
  profile: OwnerProfile;
  templateId: TemplateId;
  brief: string;
  version: number;
  followupAnswers?: string[];
}): ScriptVariant {
  const { profile, templateId, brief, version, followupAnswers = [] } = input;
  if (!getProfileCompletion(profile).ready) throw new Error("老板资料尚未达到最小可用状态");
  const commonIdentity = `我是${profile.displayName}，${profile.publicIdentity}，平时主要做${profile.offering}。`;
  const safeBoundary = "这条只讲我们自己的真实做法，具体是否适合，仍要结合每个人的实际情况。";
  const beatsByTemplate: Record<TemplateId, ScriptBeat[]> = {
    intro: [
      { id: "hook", label: "开场", text: alternate(`大家好，我是${profile.displayName}。如果你也在意${profile.audiencePain}，可以先认识一下我。`, `我是${profile.displayName}，每天面对最多的，就是${profile.audiencePain}这件事。`, version), sourceLabels: ["对外称呼", "客户痛点"], materialKind: "person", visualDirection: "本人正面出镜，中景，直说开场。", generationAllowed: false, required: true },
      { id: "identity", label: "我是谁", text: commonIdentity, sourceLabels: ["出镜身份", "主营产品/服务"], materialKind: "person", visualDirection: "本人工作状态或门店内自然口播。", generationAllowed: false, required: true },
      { id: "belief", label: "经营判断", text: `我最看重的不是把话说得多漂亮，而是把这件事做好：${profile.differentiation}。`, sourceLabels: ["差异化"], materialKind: "process", visualDirection: "真实工作过程，展示最能证明差异的动作。", generationAllowed: false, required: true },
      { id: "audience", label: "对谁有用", text: `我们主要服务${profile.audience}，希望先解决的就是：${profile.audiencePain}。`, sourceLabels: ["目标客户", "客户痛点"], materialKind: "store", visualDirection: "门店环境或典型服务场景，不拍未授权顾客正脸。", generationAllowed: true, required: true },
      { id: "cta", label: "行动", text: callToAction(profile), sourceLabels: ["内容目标"], materialKind: "graphic", visualDirection: "简洁字幕收尾，保留门店或产品背景。", generationAllowed: true, required: true },
    ],
    "pain-solution": [
      { id: "hook", label: "客户场景", text: alternate(`如果你是${profile.audience}，是不是也遇到过：${profile.audiencePain}？`, `${profile.audiencePain}，这可能是${profile.audience}每天都要做的一次选择。`, version), sourceLabels: ["目标客户", "客户痛点"], materialKind: "store", visualDirection: "真实使用场景或门店外景，前三秒建立情境。", generationAllowed: true, required: true },
      { id: "identity", label: "可信身份", text: commonIdentity, sourceLabels: ["对外称呼", "出镜身份", "主营产品/服务"], materialKind: "person", visualDirection: "本人正面出镜，语气自然。", generationAllowed: false, required: true },
      { id: "solution", label: "解决方式", text: `我们自己的做法是：${profile.differentiation}。`, sourceLabels: ["差异化"], materialKind: "process", visualDirection: "用真实过程证明做法，不用抽象口号。", generationAllowed: false, required: true },
      { id: "proof", label: "看得见的证明", text: safeBoundary, sourceLabels: ["内容边界"], materialKind: "product", visualDirection: "产品或交付结果特写，只展示可核验内容。", generationAllowed: true, required: true },
      { id: "cta", label: "行动", text: callToAction(profile), sourceLabels: ["内容目标"], materialKind: "graphic", visualDirection: "字幕给出下一步，不公开私人联系方式。", generationAllowed: true, required: true },
    ],
    knowledge: [
      { id: "hook", label: "误区钩子", text: alternate(`${profile.audiencePain}，真正要先看的，可能不是大家最常讨论的那个点。`, `为什么${profile.audience}会反复遇到${profile.audiencePain}？先看一个容易忽略的细节。`, version), sourceLabels: ["目标客户", "客户痛点"], materialKind: "graphic", visualDirection: "问题字幕配真实场景，避免夸张结论。", generationAllowed: true, required: true },
      { id: "identity", label: "经验来源", text: commonIdentity, sourceLabels: ["出镜身份", "主营产品/服务"], materialKind: "person", visualDirection: "本人出镜说明经验来源，不添加未确认资质。", generationAllowed: false, required: true },
      { id: "point", label: "核心判断", text: `按我们自己的实践，值得先看的是：${profile.differentiation}。`, sourceLabels: ["差异化"], materialKind: "process", visualDirection: "对应步骤或判断标准的真实过程。", generationAllowed: false, required: true },
      { id: "boundary", label: "适用边界", text: safeBoundary, sourceLabels: ["内容边界"], materialKind: "product", visualDirection: "产品/服务细节作辅助，字幕提示适用边界。", generationAllowed: true, required: true },
      { id: "cta", label: "行动", text: callToAction(profile), sourceLabels: ["内容目标"], materialKind: "graphic", visualDirection: "以问题或下一期预告收尾。", generationAllowed: true, required: true },
    ],
    case: [
      { id: "hook", label: "案例前提", text: `有些${profile.audience}会因为${profile.audiencePain}来找我们，但案例必须在获得授权后才能讲。`, sourceLabels: ["目标客户", "客户痛点", "内容边界"], materialKind: "customer", visualDirection: "只有已授权客户素材才能使用；否则改用匿名图形。", generationAllowed: false, required: true },
      { id: "identity", label: "服务身份", text: commonIdentity, sourceLabels: ["出镜身份", "主营产品/服务"], materialKind: "person", visualDirection: "本人出镜交代自己的角色。", generationAllowed: false, required: true },
      { id: "process", label: "处理过程", text: `我们会先把真实问题弄清楚，再按自己的做法执行：${profile.differentiation}。`, sourceLabels: ["差异化"], materialKind: "process", visualDirection: "真实服务过程，不重建客户隐私场景。", generationAllowed: false, required: true },
      { id: "boundary", label: "结果边界", text: "结果只能使用已核验、已授权的事实；没有证据的数字和效果不会写进视频。", sourceLabels: ["内容边界"], materialKind: "graphic", visualDirection: "用匿名流程图或文字说明边界。", generationAllowed: true, required: true },
      { id: "cta", label: "行动", text: callToAction(profile), sourceLabels: ["内容目标"], materialKind: "graphic", visualDirection: "明确下一步，不承诺结果。", generationAllowed: true, required: true },
    ],
    "behind-scenes": [
      { id: "hook", label: "过程钩子", text: alternate(`很多人看到的是${profile.offering}，看不到的是我们每天开始工作的第一步。`, `做${profile.offering}之前，我们最先忙的不是出镜，而是这一道真实过程。`, version), sourceLabels: ["主营产品/服务"], materialKind: "store", visualDirection: "清晨门店或工作现场建立时间和地点。", generationAllowed: true, required: true },
      { id: "identity", label: "人物出场", text: commonIdentity, sourceLabels: ["对外称呼", "出镜身份"], materialKind: "person", visualDirection: "本人在工作环境里自然出镜。", generationAllowed: false, required: true },
      { id: "process", label: "关键过程", text: `我们每天最想让你看见的是：${profile.differentiation}。`, sourceLabels: ["差异化"], materialKind: "process", visualDirection: "连续展示最能证明差异的真实动作。", generationAllowed: false, required: true },
      { id: "result", label: "产品结果", text: `最后交到顾客手里的，是${profile.offering}。`, sourceLabels: ["主营产品/服务"], materialKind: "product", visualDirection: "成品细节、交付或服务完成后的真实状态。", generationAllowed: true, required: true },
      { id: "cta", label: "行动", text: callToAction(profile), sourceLabels: ["内容目标"], materialKind: "graphic", visualDirection: "真实背景配简洁字幕收尾。", generationAllowed: true, required: true },
    ],
  };
  const template = narrativeTemplates.find((item) => item.id === templateId)!;
  const followupDetail = followupAnswers.map((answer) => answer.trim()).filter(Boolean).join(" ");
  const beats = beatsByTemplate[templateId].map((beat, index) => index === 2 && followupDetail
    ? { ...beat, text: `${beat.text} ${followupDetail}`, sourceLabels: [...beat.sourceLabels, "本条补充"] }
    : beat);
  return {
    id: `script-${templateId}-v${version}`,
    version,
    templateId,
    brief,
    title: brief.trim() || `${profile.displayName}的${template.label}视频`,
    estimatedSeconds: beats.length * 7,
    beats,
  };
}

export function buildStoryboard(variant: ScriptVariant, assets: OwnerAsset[]): StoryboardShot[] {
  const available = assets.filter((asset) => asset.rightsConfirmed);
  const used = new Set<string>();
  return variant.beats.map((beat, index) => {
    const exact = available.find((asset) => !used.has(asset.id) && asset.kind === beat.materialKind);
    const generic = available.find((asset) => !used.has(asset.id) && asset.kind === "generic" && beat.materialKind !== "customer");
    const asset = exact ?? generic;
    if (asset) used.add(asset.id);
    const status: ShotMaterialStatus = asset ? "matched" : beat.generationAllowed ? "missing" : "blocked";
    return {
      id: `shot-${variant.version}-${index + 1}`,
      order: index,
      beatId: beat.id,
      line: beat.text,
      purpose: beat.label,
      targetSeconds: 7,
      materialKind: beat.materialKind,
      status,
      assetId: asset?.id,
      assetLabel: asset?.name,
      matchReason: asset
        ? `素材类型“${asset.kind}”符合“${beat.visualDirection}”，且已确认本项目使用权。`
        : status === "blocked"
          ? "这一镜需要本人、客户或真实过程证据，不能用生成素材替代。"
          : `没有找到已授权的${beat.materialKind === "graphic" ? "图形/字幕" : beat.materialKind}素材，可生成一份待审阅提案。`,
      generationAllowed: beat.generationAllowed,
      required: beat.required,
    };
  });
}

export function generateMissingShots(shots: StoryboardShot[]) {
  return shots.map((shot) => shot.status === "missing" && shot.generationAllowed ? {
    ...shot,
    status: "generated" as const,
    assetId: `generated-${shot.id}`,
    assetLabel: `AI 示意素材 · ${shot.purpose}`,
    matchReason: "本地交互原型已创建生成提案；真实接入需先展示报价、授权和 Provider 状态。",
  } : shot);
}

export function generationPromptForShot(shot: StoryboardShot) {
  if (!shot.generationAllowed || !["store", "product", "graphic", "generic"].includes(shot.materialKind)) throw new Error("这个分镜必须使用真实素材，不能生成替代");
  return [
    "竖屏 9:16 的真实质感短视频 B-roll；不要出现可识别人物正脸、顾客、品牌标识、水印或可读文字。",
    `镜头目的：${shot.purpose}。`,
    `内容语境：${shot.line}`,
    shot.materialKind === "graphic" ? "使用简洁抽象动态图形和留白，文字由本地剪辑阶段叠加。" : `主体类型：${shot.materialKind}；自然光、真实经营场景、稳定运镜。`,
  ].join(" ");
}

export function markShotsGenerating(shots: StoryboardShot[]) {
  return shots.map((shot) => (shot.status === "missing" || shot.status === "failed") && shot.generationAllowed ? { ...shot, status: "generating" as const, matchReason: "已确认报价，正在等待 Provider 生成并回收到本地。" } : shot);
}

export function applyGeneratedShotResults(shots: StoryboardShot[], results: NonNullable<GeneratedShotRunResult["results"]>) {
  const byShotId = new Map(results.map((result) => [result.shotId, result]));
  return shots.map((shot) => {
    const result = byShotId.get(shot.id);
    if (!result) return shot.status === "generating" ? { ...shot, status: "missing" as const, matchReason: "本轮在提交这一镜前已停止，可以重新报价。" } : shot;
    if (!result.ok || !result.artifactId || !result.relativePath) return { ...shot, status: "failed" as const, matchReason: result.message ?? "生成失败，可以重新报价；不会自动重复提交。" };
    return {
      ...shot,
      status: "generated_review" as const,
      assetId: result.artifactId,
      assetLabel: `AI 生成待审 · ${shot.purpose}`,
      providerTaskId: result.providerTaskId,
      artifactId: result.artifactId,
      localRelativePath: result.relativePath,
      targetSeconds: result.durationMs ? Math.max(1, Math.round(result.durationMs / 1_000)) : shot.targetSeconds,
      matchReason: "Provider 结果已下载并通过本地视频校验；请先预览，再明确采用。",
    };
  });
}

export function adoptGeneratedShot(shots: StoryboardShot[], shotId: string) {
  return shots.map((shot) => shot.id === shotId && shot.status === "generated_review" && shot.artifactId
    ? { ...shot, status: "generated" as const, assetLabel: `AI 生成已采用 · ${shot.purpose}`, matchReason: "你已预览并采用这份本地 AI 生成素材。" }
    : shot);
}

export function getStoryboardCoverage(shots: StoryboardShot[]) {
  const ready = shots.filter((shot) => shot.status === "matched" || shot.status === "generated").length;
  const missing = shots.filter((shot) => shot.status === "missing" || shot.status === "failed").length;
  const generating = shots.filter((shot) => shot.status === "generating").length;
  const review = shots.filter((shot) => shot.status === "generated_review").length;
  const blocked = shots.filter((shot) => shot.status === "blocked").length;
  return { ready, missing, generating, review, blocked, total: shots.length, complete: shots.length > 0 && ready === shots.length };
}

export function isAssemblyReady(shots: StoryboardShot[]) {
  return shots.length > 0 && shots.every((shot) => !shot.required || shot.status === "matched" || shot.status === "generated");
}
