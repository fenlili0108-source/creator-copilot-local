export type ViewId =
  | "studio"
  | "today"
  | "radar"
  | "ideas"
  | "projects"
  | "assets"
  | "edit"
  | "review"
  | "settings";

export type ProjectStage =
  | "insight"
  | "idea"
  | "script"
  | "shoot"
  | "edit"
  | "publish"
  | "review";

export type CreatorProfile = {
  name: string;
  niche: string;
  audience: string;
  positioning: string;
  pillars: string[];
};

export type ScriptBlock = {
  hook: string;
  body: string[];
  cta: string;
  estimatedSeconds: number;
};

export type ContentProject = {
  id: string;
  title: string;
  angle: string;
  stage: ProjectStage;
  platform: string;
  format: string;
  dueAt: string;
  progress: number;
  nextAction: string;
  assetIds: string[];
  script?: ScriptBlock;
  createdAt: string;
};

export type Idea = {
  id: string;
  title: string;
  premise: string;
  source: "radar" | "assistant" | "manual";
  score: number;
  status: "candidate" | "selected" | "archived";
  tags: string[];
  createdAt: string;
};

export type Asset = {
  id: string;
  fileName: string;
  title: string;
  path: string;
  kind: "video" | "image" | "audio" | "document";
  durationSeconds: number | null;
  sizeBytes: number;
  tags: string[];
  scene: string;
  shotType: string;
  orientation: string;
  transcript: string;
  rights: "owned" | "licensed" | "unknown";
  createdAt: string;
};

export type RadarVideo = {
  id: string;
  title: string;
  shareUrl: string;
  thumbnailUrl: string | null;
  durationSeconds: number | null;
  creator: { name: string; followers: number | null };
  metrics: {
    plays: number | null;
    likes: number | null;
    comments: number | null;
    shares: number | null;
    likeRate: number | null;
  };
  signal: string;
};

export type EditJob = {
  id: string;
  projectId: string;
  status: "planned" | "rendering" | "ready" | "failed";
  style: string;
  outputPath?: string;
  plan: Array<{ assetId: string; start: number; end: number; purpose: string }>;
  createdAt: string;
  error?: string;
};

export type ReviewSnapshot = {
  id: string;
  projectId: string;
  platform: string;
  publishedAt: string;
  views: number;
  likes: number;
  comments: number;
  shares: number;
  saves: number;
  retention3s: number;
  completionRate: number;
  lesson: string;
};

export type Workspace = {
  profile: CreatorProfile;
  projects: ContentProject[];
  ideas: Idea[];
  assets: Asset[];
  editJobs: EditJob[];
  reviews: ReviewSnapshot[];
};

export type IntegrationStatus = {
  tikhub: { configured: boolean; baseUrl: string; maskedKey: string | null };
  ai: { configured: boolean; baseUrl: string; model: string; maskedKey: string | null };
  ffmpeg: { available: boolean; version: string | null };
};
