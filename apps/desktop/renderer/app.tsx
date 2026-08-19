import { useEffect, useMemo, useState } from "react";
import {
  ArrowUpRight,
  BarChart3,
  Clapperboard,
  FileText,
  FolderOpen,
  LayoutDashboard,
  Lightbulb,
  Library,
  ListChecks,
  Plus,
  Search,
  Settings2,
  Sparkles,
  Target,
  Upload,
  Workflow,
} from "lucide-react";
import { demoWorkspace } from "./lib/demo-workspace";
import type { ViewId } from "./types";
import { CreationWorkbench } from "./components/creation-workbench";
import { AiEditWorkbench } from "./components/ai-edit-workbench";
import { AssetLibraryWorkbench } from "./components/asset-library-workbench";
import { AccountRadarWorkbench } from "./components/account-radar-workbench";
import { ReviewWorkbench } from "./components/review-workbench";
import { TopicRadarWorkbench } from "./components/topic-radar-workbench";
import { SettingsWorkbench } from "./components/settings-workbench";
import { OwnerCreatorWorkbench } from "./components/owner-creator-workbench";

const navItems: Array<{ id: ViewId; label: string; icon: typeof LayoutDashboard }> = [
  { id: "studio", label: "创作流水线", icon: Workflow },
  { id: "today", label: "今天", icon: LayoutDashboard },
  { id: "radar", label: "账号雷达", icon: Target },
  { id: "ideas", label: "选题库", icon: Lightbulb },
  { id: "projects", label: "创作项目", icon: ListChecks },
  { id: "assets", label: "素材库", icon: Library },
  { id: "edit", label: "AI 剪辑", icon: Clapperboard },
  { id: "review", label: "发布复盘", icon: BarChart3 },
];

function stageLabel(stage: string) {
  return {
    insight: "研究",
    idea: "选题",
    script: "脚本",
    shoot: "拍摄",
    edit: "剪辑",
    publish: "发布",
    review: "复盘",
  }[stage] ?? stage;
}

export function App() {
  const [activeView, setActiveView] = useState<ViewId>("studio");
  const [query, setQuery] = useState("");
  const [workspacePath, setWorkspacePath] = useState<string | null>(null);
  const [mediaImport, setMediaImport] = useState<ImportMediaResult | null>(null);
  const [mediaImporting, setMediaImporting] = useState(false);
  const [captureWorkflow, setCaptureWorkflow] = useState<CaptureWorkflowResult | null>(null);
  useEffect(() => {
    let active = true;
    if (!window.desktop) return () => { active = false; };
    void window.desktop.getInfo().then((info) => {
      if (active && info.workspacePath) setWorkspacePath(info.workspacePath);
    });
    return () => { active = false; };
  }, []);
  const visibleProjects = useMemo(
    () =>
      demoWorkspace.projects.filter((project) =>
        `${project.title} ${project.angle}`.toLowerCase().includes(query.toLowerCase()),
      ),
    [query],
  );

  async function chooseWorkspace() {
    const desktop = window.desktop;
    if (!desktop) return;
    const result = await desktop.chooseWorkspace();
    if (!result.canceled) setWorkspacePath(result.path);
  }

  async function importMedia() {
    const desktop = window.desktop;
    if (!desktop || mediaImporting) return;
    setMediaImporting(true);
    try {
      setMediaImport(await desktop.importMedia());
    } finally {
      setMediaImporting(false);
    }
  }

  function formatDuration(durationMs?: number | null) {
    if (!durationMs) return "时长未知";
    const totalSeconds = Math.round(durationMs / 1000);
    return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, "0")}`;
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-lockup">
          <div className="brand-mark">原</div>
          <div>
            <div className="brand-name">原点</div>
            <div className="brand-caption">CREATOR COPILOT</div>
          </div>
        </div>
        <div className="workspace-switcher" onClick={chooseWorkspace} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); void chooseWorkspace(); } }} role="button" tabIndex={0} aria-label="选择本地工作区">
          <span className="workspace-dot" />
          <span className="workspace-name">{workspacePath ? "本地工作区" : "演示工作区"}</span>
          <ArrowUpRight size={14} />
        </div>
        <nav className="nav-list" aria-label="主导航">
          <div className="nav-section-label">工作台</div>
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <button
                className={`nav-item ${activeView === item.id ? "active" : ""}`}
                key={item.id}
                onClick={() => setActiveView(item.id)}
                aria-current={activeView === item.id ? "page" : undefined}
              >
                <Icon size={17} strokeWidth={1.8} />
                <span>{item.label}</span>
                {item.id === "ideas" && <span className="nav-count">12</span>}
              </button>
            );
          })}
          <div className="nav-section-label nav-section-label-spaced">系统</div>
          <button className="nav-item" onClick={chooseWorkspace}>
            <FolderOpen size={17} strokeWidth={1.8} />
            <span>工作区</span>
          </button>
          <button className="nav-item" onClick={() => setActiveView("settings")}>
            <Settings2 size={17} strokeWidth={1.8} />
            <span>设置</span>
          </button>
        </nav>
        <div className="sidebar-footer">
          <div className="local-badge"><span /> 本地优先 · 预览壳</div>
          <div className="profile-mini"><div className="avatar">创</div><div><strong>{demoWorkspace.profile.name}</strong><small>{demoWorkspace.profile.niche}</small></div></div>
        </div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <div className="breadcrumb"><span>工作台</span><b>/</b><strong>{navItems.find((item) => item.id === activeView)?.label ?? "设置"}</strong></div>
          <div className="topbar-actions"><div className="search-box"><Search size={16} /><input aria-label="搜索项目、选题或素材" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索项目、选题或素材" /></div><button className="icon-button" aria-label="打开快捷操作" title="快捷操作"><Sparkles size={17} /></button><button className="avatar top-avatar" aria-label="打开老板资料" onClick={() => setActiveView("studio")}>创</button></div>
        </header>

        <div className="page-content">
          {activeView === "studio" ? (
            <OwnerCreatorWorkbench openLegacyProjects={() => setActiveView("projects")} openEdit={() => setActiveView("edit")} />
          ) : activeView === "today" ? (
            <>
              <section className="hero-row"><div><div className="eyebrow">THURSDAY · AUG 14</div><h1>今天，先把一个观点讲清楚。</h1><p className="hero-copy">从研究、脚本到分镜和素材，原点把下一步放在你面前。</p></div><div className="hero-actions"><button className="secondary-button" onClick={importMedia} disabled={mediaImporting}><Upload size={16} /> {mediaImporting ? "处理中…" : "导入素材"}</button><button className="primary-button"><Plus size={17} /> 新建创作项目</button></div></section>
              {mediaImport && <section className={`media-feedback ${mediaImport.ok ? "success" : "error"}`}><div className="media-feedback-icon"><Upload size={16} /></div><div className="media-feedback-copy"><strong>{mediaImport.ok ? `已导入 ${mediaImport.sourceName}` : mediaImport.message}</strong>{mediaImport.ok ? <p>{formatDuration(mediaImport.durationMs)} · {mediaImport.artifacts?.length ?? 0} 个本地产物已生成，可进入素材库继续整理。</p> : <p>请检查工作区和视频文件后重试。</p>}</div>{mediaImport.ok && <span className="media-feedback-status">本地完成</span>}</section>}
              <section className="signal-strip"><div className="signal-icon"><Sparkles size={17} /></div><div><strong>今日创作提示</strong><p>你的两个待选题都在“表达结构”这个支柱上，可以先完成一条，再把经验回流到下一条。</p></div><button className="text-button" onClick={() => setActiveView("ideas")}>查看选题 <ArrowUpRight size={14} /></button></section>
              <div className="section-heading"><div><div className="eyebrow">IN PROGRESS</div><h2>正在推进</h2></div><button className="text-button" onClick={() => setActiveView("projects")}>查看全部 <ArrowUpRight size={14} /></button></div>
              <section className="project-grid">{visibleProjects.map((project) => <article className="project-card" key={project.id}><div className="card-topline"><span className={`stage-chip stage-${project.stage}`}>{stageLabel(project.stage)}</span><span className="due-label">{project.dueAt}</span></div><h3>{project.title}</h3><p>{project.angle}</p><div className="progress-row"><span>完成度</span><strong>{project.progress}%</strong></div><div className="progress-track"><span style={{ width: `${project.progress}%` }} /></div><div className="next-action"><span className="action-dot" />{project.nextAction}<ArrowUpRight size={14} /></div></article>)}<button className="new-card"><Plus size={20} /><span>从一个新选题开始</span></button></section>
              <div className="lower-grid"><section className="panel"><div className="panel-heading"><div><div className="eyebrow">NEXT UP</div><h2>下一步动作</h2></div><FileText size={19} /></div><div className="task-row"><span className="task-index">01</span><div><strong>完成脚本第二版</strong><p>越努力越没记忆点？</p></div><span className="task-time">25 min</span></div><div className="task-row"><span className="task-index">02</span><div><strong>补拍一个“反例”镜头</strong><p>为分镜 04 准备 B-roll</p></div><span className="task-time">15 min</span></div></section><section className="panel insight-panel"><div className="panel-heading"><div><div className="eyebrow">CREATOR MEMORY</div><h2>最近沉淀</h2></div><Lightbulb size={19} /></div><blockquote>“不要从结论开始，先把那个让你改变想法的瞬间讲出来。”</blockquote><span className="memory-source">来自 3 次复盘 · 表达结构</span></section></div>
            </>
          ) : activeView === "projects" ? (
            <CreationWorkbench workspaceReady={Boolean(workspacePath)} chooseWorkspace={chooseWorkspace} onWorkflowReady={setCaptureWorkflow} openEdit={() => setActiveView("edit")} />
          ) : activeView === "edit" ? (
            <AiEditWorkbench workflow={captureWorkflow} openProjects={() => setActiveView("projects")} />
          ) : activeView === "assets" ? (
            <AssetLibraryWorkbench workspaceReady={Boolean(workspacePath)} importMedia={importMedia} />
          ) : activeView === "radar" ? (
            <AccountRadarWorkbench workspaceReady={Boolean(workspacePath)} />
          ) : activeView === "ideas" ? (
            <TopicRadarWorkbench workspacePath={workspacePath} />
          ) : activeView === "review" ? (
            <ReviewWorkbench workspaceReady={Boolean(workspacePath)} />
          ) : activeView === "settings" ? (
            <SettingsWorkbench />
          ) : (
            <section className="empty-view"><div className="empty-icon"><Sparkles size={24} /></div><div className="eyebrow">WORKSPACE</div><h1>工作区</h1><p>这个工作区正在从可运行的本地壳开始建设。下一阶段会接入真实项目、素材、命令和任务状态。</p><button className="primary-button" onClick={() => setActiveView("today")}>回到今天</button></section>
          )}
        </div>
      </main>
    </div>
  );
}
