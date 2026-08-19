---
name: 原点 Creator Copilot
description: 给老板和个体户使用的温暖、可信、本地优先创作工作台
colors:
  primary: "#2f3b2c"
  primary-hover: "#42533e"
  primary-soft: "#e3eadf"
  generation-accent: "#5a4b68"
  paper: "#f4f0e8"
  surface: "#fbf9f4"
  surface-raised: "#fffdf8"
  surface-muted: "#ece7dc"
  border: "#ddd5c9"
  ink: "#312d27"
  text-muted: "#655e55"
  danger: "#8c5146"
typography:
  display:
    fontFamily: "Georgia, Songti SC, serif"
    fontSize: "clamp(2rem, 4vw, 3.25rem)"
    fontWeight: 500
    lineHeight: 1.12
    letterSpacing: "-0.035em"
  headline:
    fontFamily: "Georgia, Songti SC, serif"
    fontSize: "clamp(1.5625rem, 2.7vw, 2.125rem)"
    fontWeight: 500
    lineHeight: 1.22
    letterSpacing: "-0.025em"
  body:
    fontFamily: "ui-sans-serif, system-ui, PingFang SC, Microsoft YaHei, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.7
  label:
    fontFamily: "ui-sans-serif, system-ui, PingFang SC, Microsoft YaHei, sans-serif"
    fontSize: "0.6875rem"
    fontWeight: 600
    lineHeight: 1.5
rounded:
  sm: "8px"
  md: "10px"
  lg: "13px"
  xl: "16px"
  pill: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "18px"
  xl: "28px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.surface}"
    rounded: "{rounded.md}"
    padding: "10px 15px"
    height: "42px"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text-muted}"
    rounded: "{rounded.sm}"
    padding: "9px 11px"
  input-default:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "10px 11px"
    height: "42px"
  panel:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.xl}"
    padding: "28px"
---

# Design System: 原点 Creator Copilot

## Overview

**Creative North Star: "老板的本地创作台账"**

原点像一本放在柜台手边的创作台账：务实、有温度，每条资料、每个素材状态和每次生成都有清楚出处。界面不追求炫技，而是让不熟悉编导和剪辑术语的老板能快速判断“现在到哪一步、下一步做什么、哪些内容是真的”。

视觉保持暖中性、克制、可信和可操作。绿色承担主操作、安全与就绪状态；少量紫灰只标记生成类动作。大标题提供人情味，正文保持高可读密度，原型能力必须以视觉和文案明确区别于已经上线的生产能力。

**Key Characteristics:**

- 暖纸张底色与低饱和状态色
- 标题有温度，正文清楚直接
- 边框和轻环境阴影建立层级
- 操作名称与真实行为一致
- 桌面高效、窄屏仍可完整操作

## Colors

主色是沉稳的账本绿，配合米纸背景、奶白表面和暖灰文字。紫灰仅用于“生成”这一特殊动作，危险状态使用低饱和砖红。

### Primary

- **账本绿**：主按钮、当前步骤、安全和就绪状态；其稀缺性帮助用户识别关键动作。
- **账本绿悬停**：只在可点击的主操作悬停时出现。
- **安全浅绿**：用于本地优先、授权确认和流程完成提示，不用于装饰。

### Secondary

- **生成紫灰**：只标记 AI 生成或批量补齐素材，不能与普通导航竞争。

### Neutral

- **暖纸**：应用和页面底色。
- **奶白表面**：表单、面板和卡片的主要承载面。
- **暖灰面**：进度、清单和次级分区。
- **柔和边线**：卡片、字段、导航分段和分隔线。
- **墨色**：标题和主要正文。
- **暖灰正文**：解释性文字；必须保持可读对比度。
- **克制砖红**：错误、阻断和撤回授权等真正需要处理的状态。

**The One Accent Rule.** 每个操作区只允许一个主绿色动作；紫灰只属于生成语义，不能成为第二个通用主色。

## Typography

**Display Font:** Georgia（中文回退 Songti SC）

**Body Font:** 系统无衬线（中文回退 PingFang SC / Microsoft YaHei）

**Character:** 标题像一本经营手记，稳重但不古板；正文像清楚的工作说明，避免营销腔和技术黑话。

### Hierarchy

- **Display**：页面主命题，只在一屏出现一次，使用平衡换行。
- **Headline**：阶段标题和关键结果标题。
- **Title**：卡片标题、模板名称和清单标题。
- **Body**：说明、脚本和匹配理由；长文保持舒适行距。
- **Label**：字段标签、状态和来源信息；窄屏辅助信息不得低于可读底线。

**The Readable Ledger Rule.** 不用 8–10px 低对比文字塞信息；辅助内容至少采用已定义的标签字号，并以足够深的暖灰呈现。

## Layout

桌面端以固定侧栏和最大宽度内容区组成，创作任务在单一主列中推进。关键阶段使用五段导航，面板内部采用两列资料表单、主次内容分栏和逐镜清单；容器间距遵循 8–28px 的紧凑节奏。

在 1000px 以下，模板上下文和拼合清单改为单列；在 900px 以下，侧栏变为横向可滚动导航；在 700px 以下，表单、主操作和分镜信息全部改单列。窄屏不得出现页面级横向滚动，主操作保持完整文字和可触达高度。

## Elevation & Depth

系统以色块、边线和间距为主，阴影只提供轻微环境分离。普通卡片保持接近平面；主面板使用极轻的暖灰阴影，主要按钮使用短而柔和的绿色阴影，悬停时只做 1px 上移和轻微增强。

**The Flat-by-Default Rule.** 层级首先来自底色和边线；阴影只用于主面板、主操作和暂时浮起的交互状态。

## Shapes

字段、按钮和普通卡片使用 8–10px 圆角；重点面板使用 13–16px 圆角；头像、步骤编号和状态标签可使用圆形或胶囊。边框保持 1px，避免粗侧边强调线和装饰性切角。

## Components

### Buttons

- **Primary:** 深绿实底、奶白文字、明确动词，最小高度 42px。
- **Secondary:** 奶白或暖纸底、细边框，用于返回、改方向和次级入口。
- **Hover / Focus:** 悬停只轻微上移；键盘焦点使用清晰绿色轮廓，不只依赖颜色变化。
- **Disabled:** 保留动作名称并降低强调，鼠标样式说明不可执行原因。

### Cards / Containers

- **Corner Style:** 普通卡片轻圆角，阶段面板使用更大的圆角。
- **Background:** 奶白表面承载任务，暖灰或浅绿只用于分组和状态。
- **Shadow Strategy:** 静态卡片优先用边框；主面板允许轻环境阴影。
- **Internal Padding:** 面板使用宽松内边距，窄屏收紧但不压缩文字。

### Inputs / Fields

- **Style:** 奶白背景、暖灰边线、深墨文字；说明文字紧随字段。
- **Focus:** 边框变绿并出现低透明焦点环。
- **Error / Disabled:** 错误使用浅砖红底和明确问题说明，不只改变边框颜色。

### Navigation

阶段导航以分段账本条呈现，当前步骤使用奶白底和绿色编号，完成步骤显示勾选。移动端保留编号与简短步骤名，主导航允许横向滚动但页面主体不得溢出。

### Status and Material Rows

每个分镜同时显示状态、素材名称、匹配理由和真实下一步。状态色必须配文字；“回资料页上传”“生成全部缺口”等名称必须准确描述点击结果。

## Do's and Don'ts

### Do:

- **Do** 让每个阶段只有一个最明确的主操作。
- **Do** 用资料来源、授权状态和匹配理由建立信任。
- **Do** 在桌面与 390px 窄屏同时检查文字对比、换行和横向溢出。
- **Do** 用“本地交互原型”“不会输出 MP4”等直接文案标清能力边界。

### Don't:

- **Don't** 使用高饱和渐变、霓虹色或纯装饰性大色块。
- **Don't** 用 8–10px、低对比文字隐藏重要说明和免责声明。
- **Don't** 创建名称与真实行为不一致的按钮或无响应控件。
- **Don't** 把演示资料、模拟授权或生成提案描述成真实生产结果。
- **Don't** 用粗侧边框、过度阴影或持续动画制造层级。
