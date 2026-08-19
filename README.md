# Creator Copilot Local

本地优先的内容创作助手，首个工作流聚焦老板、个体户和小微门店的真人短视频：先建立老板资料与实拍素材库，再由资料驱动脚本、分镜匹配、素材补全和成片拼合。

当前仓库处于 V0–V8 逐步施工中：已提供 React UI、Electron main/preload 安全边界、SQLite catalog、本地媒体管线、AI 粗剪、TikHub 研究、交换格式、发布包和复盘页面。新版“创作流水线”已实现可点击的本地交互原型；付费生成 Provider、持久化和最终 MP4 拼合仍以实施计划为准，不把交互 smoke 当成生产能力或跨平台发布完成。

## 本地运行

```bash
npm install
npm run dev:web
```

桌面端入口和 renderer 已迁入 `apps/desktop`；root Vite 仍是过渡构建器，Express 仅保留为历史 scaffold。迁移中的 workspace 入口也可使用 pnpm；当前包级命令只是兼容 wrapper，真实逻辑仍由 root scripts 负责：

```bash
pnpm --filter @creator-copilot/desktop typecheck
pnpm --filter @creator-copilot/desktop build
```

打开 `http://127.0.0.1:4316` 可以预览 UI。Electron 壳需要先完成 Electron 二进制安装后运行：

```bash
npm run dev:desktop
```

云端能力默认关闭。将 `.env.example` 复制为本地 `.env` 后可配置 TikHub/APIMart；密钥只由 Electron main 和受控联调脚本读取。`AI_EDIT_PROVIDER=apimart` 会启用 AI SDK 结构化剪辑/脚本提案，`AI_EDIT_PROVIDER=local-fallback` 保持完全离线。脚本提案使用独立的 `AI_SCRIPT_MODEL`，默认是经过 smoke 验证的 `gpt-4.1-mini`。

## 文档入口

- [产品边界与持久约束](PRODUCT.md)
- [视觉设计系统](DESIGN.md)
- [老板资料驱动创作流水线 PRD v0.3](docs/PRD-v0.2-Workflow-and-Scope.md)
- [产品架构交互蓝图](docs/Owner-Creator-Workflow-Architecture-v0.3.html)
- [产品架构源数据](docs/Owner-Creator-Workflow-Architecture-v0.3.json)
- [本轮实施计划](docs/plan/2026-08-19-owner-creator-workflow-v0.3.md)
- [技术实施计划](docs/Implementation-Plan-v0.2.md)
- [用户旅途坏路径测试](docs/User-Journey-Failure-Test-Cases-v0.1.md)
- [Agent 技术栈 CTO 评审](docs/Agent-Stack-CTO-Review-v0.1.md)
- [数据库选型 ADR](docs/Database-Decision-ADR-v0.1.md)
- [Provider 官方接入与小额联调记录](docs/Provider-Official-Integration-Research-v0.1.md)
- [Provider 小额真实联调规则（以后测试按此执行）](docs/Provider-Live-Test-Policy-v0.1.md)
- [本地 ASR/OCR 官方接入调研](docs/Local-Analysis-Official-Integration-Research-v0.1.md)
- [本地分析事实与素材检索施工记录](docs/plan/2026-08-14-v6-local-analysis-search.md)
- [脚本 AI 提案与拍摄包衔接施工记录](docs/plan/2026-08-14-v5-script-proposal.md)
- [选题雷达垂直切片施工记录](docs/plan/2026-08-14-v7-topic-radar.md)

## 验证

```bash
npm run typecheck
npm test
npm run build

# macOS arm64 目录打包 + preload/SQLite 启动 smoke
npm run test:desktop:package

# 打包应用真实用户旅途：创作项目 → 拍摄包 → 三个 Take → 本地分析 → AI 剪辑提案 → 导出
npm run test:desktop:ui

# 设置页、原生路径校验和本地分析配置重启恢复 smoke
npm run test:desktop:settings

# 只对明确提供的本地素材做 observational calibration；不调用云端、不写绝对路径
ANALYSIS_QUALITY_INPUT=/path/to/source.mp4 \
ANALYSIS_QUALITY_REFERENCE=/path/to/aligned.json \
ANALYSIS_QUALITY_EXPECTED_SHA256=... \
ANALYSIS_QUALITY_RUN_ASR=0 ANALYSIS_QUALITY_RUN_OCR=1 \
npm run test:analysis:quality:calibration

# 默认跳过；显式打开时只执行 1 条 APIMart 脚本结构化请求
AGENT_SCRIPT_LIVE=1 npm run test:script:live
```

打包产物位于 `release/`，仅为本地未签名目录产物。
