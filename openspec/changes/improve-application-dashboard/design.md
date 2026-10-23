# Design

## Context

动机与范围见 `proposal.md`。当前投递进度页作为 iframe 运行在 `src/workbench/workbench.html` 中：工作台头部、标签页、框选工具条各占一行；dashboard 自身用 sticky 顶栏、6 张统计卡、4 个图表面板和筛选栏，页面整体纵向滚动。表格列在 `dashboard.html` 中写死，`dashboard.css` 用 `nth-child` 在侧栏隐藏部分列，因此新增或调整列会同时影响结构与样式。

记录模型位于 `src/lib/store.js`，由 `buildRecord` 统一构造，`updateRecord` 合并补丁，`mergeImport` 合并旧备份。设置通过 `chrome.storage.local` 的 `settings` 单对象读写，background 暴露 `LIST_RECORDS`、`UPDATE_RECORD`、`SAVE_SETTINGS` 等消息。识别提示词在 `src/lib/settings.js`，`src/lib/vision.js` 负责把模型 JSON 归一化为记录字段，`src/content/overlay.js` 的 shadow DOM 核对面板负责最终保存。现有页面为原生 ES 模块、无构建步骤、无第三方 UI 依赖，最低 Chrome 116。

## Goals / Non-Goals

**Goals:**

- 以最小兼容成本把 `companyType` 贯穿识别、手动录入、存储、筛选、展示和导出。
- 用列注册表替代写死的表头/单元格，列配置与窄侧栏精简可预测、可持久化。
- 把 dashboard 改成占满 iframe 高度的纵向布局，默认只滚动表格主体。
- 在不改变主色的前提下统一视觉变量、状态呈现和图标语言。
- 旧记录、旧 JSON 备份、现有消息协议和状态词表保持可用。

**Non-Goals:**

- 不让模型根据公司名猜测企业性质；只有截图明确写出时才提取。
- 不引入拖拽库、组件框架、CSS 框架或新的运行权限。
- 不做深色模式、主题换肤或用户自定义主色。
- 不修改知识库与设置页的内部布局；只改共享工作台外壳。
- 不改变记录存储版本、状态历史语义、截图预算和重复检测逻辑。

## Decisions

### 1. 企业性质作为记录的一个可空枚举

记录新增 `companyType: '央企' | '国企' | '私企' | '其他' | ''`。空字符串表示未标注，旧记录不迁移、不写回；读取处统一用 `r.companyType || ''`。`buildRecord` 和 `updateRecord` 都调用 `normalizeCompanyType`，把「中央企业」「国有企业」「民营企业」「外资/合资/事业单位」等别名归一到四个正式值，未知值丢弃为空。`mergeImport` 对导入记录做同样归一化，但保留原始记录的其他字段。

企业性质不进入 `status`、`statusHistory` 或统计漏斗；它是岗位属性，不是流程状态。导出时 CSV/Markdown 将空值写作「未标注」，JSON 保留空字符串，避免备份被展示值污染。

替代方案：把企业性质做成可配置标签系统。分类只有四类且需要稳定颜色与筛选语义，配置化会引入不必要的设置迁移和 UI 复杂度，故不采用。

### 2. 建议逻辑纯函数化，词典保守匹配，手动选择优先

新增 `src/lib/company-type.js`：

```text
COMPANY_TYPES = [
  { value: '央企', label: '央企', tone: 'central' },
  { value: '国企', label: '国企', tone: 'state' },
  { value: '私企', label: '私企', tone: 'private' },
  { value: '其他', label: '其他', tone: 'other' },
]

normalizeCompanyType(value) -> '' | 央企 | 国企 | 私企 | 其他
suggestCompanyType({ company, explicitType }) -> { value, reason }
bindCompanyTypeField({ companyInput, select, hint, initialType, explicitType })
```

建议优先级：

1. `explicitType` 非空：直接采用，`reason = 'explicit'`。它来自识别提示词新增的 `company_type` 字段，提示词明确要求「只有截图明确写出企业性质时才填，不得根据公司名猜测」。
2. 公司名归一化后命中内置央企名单/别名：建议央企。
3. 命中常见私企名单：建议私企。
4. 命中地方国资关键词（城投、交投、建投、水务、燃气、公交、地铁、轨道交通、国资、国有资本等）：建议国企。
5. 其余返回空，`reason = ''`，不做「默认私企」。

公司名归一化会去掉空格、括号内容和「股份有限公司/有限责任公司/有限公司/集团/分公司」等后缀，再与别名做包含匹配。词典只收录高置信名称，宁可漏判也不误判；用户始终可以在下拉框里改。

交互上，`bindCompanyTypeField` 维护一个 `touched` 标记：首次渲染时，若存在 `initialType` 或 `explicitType`，标记为已确定；用户手动改变 select 也标记为已确定。公司输入框的 `input` 和 `blur` 只在未确定时更新建议，并显示建议来源提示（「来自截图」「根据公司名建议」「未识别，可手动选择」）。这样既满足自动建议，又不会覆盖用户选择。

替代方案：直接在自由文本里搜索「国企/央企」关键词。JD 常出现「国企改革」「非国有企业」等噪声，误判率高；改为只信任提示词结构化提取的 `company_type`。

### 3. 行内标签、筛选与导出共用同一枚举

表格不新增「企业性质」列，而是在公司名后渲染 `<span class="type-badge type-{tone}">`。公司列固定存在，所以标签不会因用户隐藏列而消失。未标注不渲染标签，详情抽屉里显示「未标注」并允许补选。

筛选栏新增 `#f-company-type`，选项为全部性质、央企、国企、私企、其他、未标注。未标注用内部值 `__unset__` 表示，避免与空字符串「全部」混淆。筛选与关键词、状态、来源、时间、未标注组合时按 AND 语义处理，搜索 haystack 增加 `r.companyType`。

CSV 在「公司」后增加「企业性质」列；Markdown 表格增加同名列，岗位详情标题追加 `· 央企` 等类型；JSON 由记录整体序列化自动携带。导入旧 JSON 时字段缺失按空处理，不阻断导入。

### 4. 列注册表驱动表头与行渲染

在 dashboard 内定义列注册表，固定列与可选列分开：

```text
FIXED = [check, company, actions]
OPTIONAL = {
  基础: createdAt, location, salary
  流程: status, appliedAt, nextAction, statusChanges
  岗位: jobType, education, experience, headcount, deadline, skills, summary
  类型来源: companyType, source, contact, sourceUrl, pageTitle, notes, updatedAt, aiModel
}
DEFAULT_VISIBLE = [createdAt, location, salary, status, appliedAt, source, nextAction]
DEFAULT_HIDDEN  = 其余扩展列
```

公司列固定在勾选框之后、可选列之前；操作列固定在最后。默认顺序基本沿用现有顺序，只把「下一步」从公司单元格移到独立列，其余扩展列默认隐藏，保持首屏清爽。用户可拖拽可选列，也可用上移/下移按钮做键盘替代操作。隐藏列保留在原顺序中的位置，重新显示时回到原位置。打开企业性质列时行内企业性质标签隐藏；打开岗位类型列时公司单元格里的岗位类型后缀隐藏，避免重复信息。

`renderTableHead()` 和 `renderTable()` 都只遍历同一个 `visibleColumns` 数组，空状态与错误行的 `colspan` 由固定列数 + 可见可选列数计算，避免隐藏列后错位。事件绑定继续使用 `data-act`，但 `status` 和 `appliedAt` 的监听器只在对应列存在时绑定。

替代方案：继续用 CSS `nth-child` 隐藏列。列顺序和数量变化后选择器不可维护，也无法持久化，故改为注册表 + class 驱动。

### 5. 列配置的数据形状与回退

设置新增：

```text
dashboardColumns: {
  order: [全部 22 个可选列 ID],
  hidden: [扩展列默认隐藏]
}
dashboardColumnWidths: {
  createdAt: 108, location: 104, salary: 96, status: 118,
  appliedAt: 116, source: 92, nextAction: 150, companyType: 90,
  jobType: 100, education: 100, experience: 100, headcount: 80,
  deadline: 110, contact: 130, skills: 180, summary: 200,
  notes: 180, updatedAt: 108, statusChanges: 90, sourceUrl: 140,
  pageTitle: 180, aiModel: 120,
  company?: 260 // 仅在用户拖拽公司列后出现；缺省表示自动填充
}
dashboardOverviewExpanded: false
```

`settings.js` 提供 `normalizeDashboardColumns(value)`：过滤未知 ID、去重、把缺失的默认列追加到末尾、只保留已知 ID 的 hidden 项；老配置里没有出现过的扩展列自动加入 hidden，保证升级后原有七列仍可见、新列默认隐藏。`normalizeDashboardColumnWidths(value)` 把每列宽度限制在 70–600px（公司列 160–600px），非法值回退默认。`getSettings()` 在合并默认值后调用两个归一化函数；dashboard 通过 `SAVE_SETTINGS` 同时保存列配置和列宽。

列设置浮层可从表头最右侧的图标按钮或筛选栏的「列设置」按钮打开，使用 `position: fixed` 按触发按钮矩形定位，避免被表格滚动容器裁剪。浮层内包含按名称搜索、拖拽手柄、复选标签、当前列宽、上移/下移按钮，以及「全部显示」和「恢复默认」；按 Escape 或点击外部关闭，关闭后焦点回到触发按钮。使用原生 HTML5 drag and drop，不引入依赖。

### 6. 侧栏精简由媒体查询控制，不改写配置

dashboard iframe 的视口宽度就是侧栏/全屏内容宽度。使用 `matchMedia('(max-width: 700px)')` 切换 `compact-table` 类；宽度变化只改类，不重新渲染，避免输入框和滚动位置丢失。

`compact-table` 下通过 class 隐藏 `c-time`、`c-loc`、`c-salary`、`c-applied`、`c-source`、`c-next`，保留勾选框、公司/岗位、状态（若启用）和操作。隐藏只发生在渲染层，`dashboardColumns` 设置不变；回到全屏后所有已启用列按原顺序出现。表格使用 `table-layout: fixed`，公司列占剩余宽度，其余列使用注册表宽度。

### 7. Dashboard 改为列表优先的全高 flex 布局

页面结构改为：

```text
body (display:flex; flex-direction:column; height:100%; overflow:hidden)
  .topbar (flex:none)
  .overview (flex:none)
    .overview-summary   <- 总记录 / 本周 / 进行中 / 面试及以后 / Offer / 拒绝
    .overview-body      <- 原来的 cards + panels，默认 hidden
  .filters (flex:none)
  .table-wrap (flex:1; min-height:220px; display:flex; flex-direction:column)
    .batch (flex:none)
    .table-scroll (flex:1; overflow:auto; min-height:0)
      table thead (sticky)
      table tbody
      .empty
```

默认折叠时页面没有纵向滚动，只有 `.table-scroll` 滚动；筛选栏常驻，表头 `position: sticky; top: 0`。展开概览时 `.overview-body` 自身限制最大高度并内部滚动（约 `min(38vh, 320px)`），表格仍保留至少 220px；极矮视口允许页面滚动作为兜底，但不作为默认体验。

顶部预算目标（1080p 全屏）：工作台外壳约 48–82px，dashboard 顶栏约 48px，摘要行约 40px，筛选约 44px；收起概览后表格可用高度约 780px。按 42–48px 行高计算，同屏约 15–18 行。

替代方案：把统计区做成单独的「分析」页面。用户仍希望快速看到关键数字，单行摘要 + 可展开概览比跳页更轻。

### 8. 概览状态存设置，替换 show-insights 特例

新增 `dashboardOverviewExpanded` 设置，默认 `false`。dashboard 加载时读取该值并应用；点击「数据概览」时立即写入设置并更新 `aria-expanded`，保存失败则回滚 UI 并提示。这样侧栏与全屏切换、页面刷新后状态一致。

移除现有只在侧栏注入的「统计分析」按钮和 `show-insights` 类。`registerViewState` 不再捕获 `insights` 状态，只保留编辑中的抽屉/弹窗、筛选和选择集；概览状态由设置持久化，不依赖跨 surface 快照。

### 9. 工作台外壳合并为可换行的单头部

保留现有 DOM 选择器和事件绑定，把 `.workspace-tabs`、`.capture-actions`、`.workspace-controls` 移入同一个 `header.workspace-head`，用 `flex-wrap` 控制布局：

- 宽屏（>900px）：品牌、标签页、框选入口、显示模式/关闭在同一行。
- 侧栏（≤900px）：品牌 + 显示控制第一行，标签页 + 框选入口第二行。
- 窄屏（≤700px）：框选按钮只显示图标，通过 `aria-label` 和 `title` 区分；`mode-label` 隐藏。
- 标签页改为浅灰分段控件，激活项白底 + 轻阴影，减少一块独立白色横条。

不复制框选按钮到菜单，避免出现多个相同的 `[data-capture]` 元素和测试歧义。`workbench.js` 的 `[data-view]`、`[data-capture]` 绑定保持不变。

### 10. 视觉 token、状态胶囊与 SVG 图标

dashboard 的 `:root` 统一为蓝灰体系：页面背景 `#F6F8FB`、卡片 `#FFFFFF`、主色 `#2563EB`（hover `#1D4ED8`）、正文 `#0F172A`、次级 `#475569`、弱化 `#94A3B8`、分割 `#E2E8F0`、危险 `#DC2626`；圆角卡片 12px、控件 8px、标签 5px；阴影只保留 `0 1px 2px rgba(15,23,42,.04)` 和浮层阴影。字体保持系统字体，基准 13px，表格元数据 12px，日期和计数使用 `tabular-nums`。

状态列改为 `.status-pill`：外层浅色边框胶囊，内部彩色圆点 + 原生 select（透明背景、无边框、文字用正文色）。状态变化时只更新外层 CSS 变量 `--status-color`，保持下拉可编辑。这样颜色不再是唯一信息通道。

企业性质标签使用浅底深字：

```text
央企  #92400E / #FFFBEB / border #FDE68A
国企  #1D4ED8 / #EFF6FF / border #BFDBFE
私企  #047857 / #ECFDF5 / border #A7F3D0
其他  #475569 / #F1F5F9 / border #E2E8F0
```

新增 `src/lib/icons.js`，集中提供 `search`、`eye`、`trash`、`settings`、`columns`、`chevron`、`plus`、`download`、`upload`、`close` 等线性 SVG path。dashboard 的 emoji 图标全部替换；workbench 的关闭/展开按钮可用同一套图标或保留文字符号。SVG 默认 `aria-hidden="true"`、`focusable="false"`，可交互按钮必须有 `title`/`aria-label`。

行高控制在 42–48px：单元格纵向 padding 7px，公司/岗位最多两行，地点单行截断，下一步独立列单行截断，日期输入和状态胶囊压缩到 30px 高。`thead th` 使用 11.5px、600 字重、`#F8FAFC` 背景和底部边框；行悬停 `#F8FAFC`，选中 `#EFF6FF`。

替代方案：直接换成暖色或深色主题会与知识库、设置页现有蓝色语言冲突，也会扩大回归范围；本次只精修蓝色体系。

### 11. 列宽拖拽与完整列目录

每个数据列表头内部放一个绝对定位的 `.col-resizer`（公司列也包含）。`pointerdown` 后记录起始宽度，在 window 上监听 `pointermove` 实时把宽度写入当前 `<th>` 的 `style.width`，`pointerup`/`pointercancel` 时通过 `SAVE_SETTINGS` 保存 `dashboardColumnWidths`。可选列限制 70–600px，公司列限制 160–600px；双击手柄恢复默认（公司列回到自动填充），手柄支持 `tabindex`、左右方向键 8px 微调、Shift 加速和 Home 复位。

表格继续使用 `table-layout: fixed`，公司列没有显式宽度时自动吸收剩余空间；用户显式调整公司宽度后记录数值。`updateTableMinWidth()` 按可见列宽度 + 固定列宽度设置 `table.style.minWidth`，空间不足时让 `.table-scroll` 横向滚动，而不是压缩列内容。侧栏精简模式不渲染宽度手柄、不写内联宽度，由 CSS 的紧凑列宽接管；切回全屏重新渲染并恢复用户列宽。媒体查询变化时强制重渲染表头，避免旧的 inline width 覆盖紧凑样式。

完整列目录由 `DASHBOARD_COLUMN_IDS` 和 dashboard 的列注册表共同维护；扩展列默认进入 `DEFAULT_HIDDEN_DASHBOARD_COLUMNS`。老配置归一化时，未在 `order` 中出现过的扩展列自动隐藏，已保存的新配置则完全尊重 `hidden`。列设置搜索只过滤清单，不修改配置；「全部显示」清空 hidden；「恢复默认」同时重置可见性、顺序和宽度。企业性质列与行内标签、岗位类型列与公司单元格后缀互斥显示，避免同一信息出现两次。

替代方案：让所有列宽都精确像素化需要额外的 filler 列或动态计算公司列宽度；当前保留公司列自动填充，既能让数据列按用户宽度显示，又能在宽屏下铺满整行。

## Risks / Trade-offs

- **公司名词典误判或漏判** → 只收录高置信名称，匹配不到保持未标注；建议来源明示且可一键修改；绝不批量回写旧记录。
- **提示词新增字段增加输出 token** → 只增加一个短枚举字段，并要求未明确时留空；不影响现有字段解析，`vision.js` 对缺失字段保持空值兼容。
- **动态列渲染遗漏事件或 colspan** → 用单一列注册表和统一 `visibleColumns` 计算；扩展 selftest 覆盖隐藏、重排、空状态和批量选择。
- **全高 flex 在小视口产生双滚动条** → `html/body height:100%`、所有中间容器 `min-height:0`、只有 `.table-scroll` 设置 `overflow:auto`；在 400×800 侧栏和 1450×950 全屏分别验证页面 `scrollHeight <= clientHeight`。
- **sticky 表头与圆角/overflow 冲突** → 外框负责圆角和边框，滚动容器不裁剪表头；表头用 `border-collapse: separate` 或 box-shadow 画分隔线，避免滚动时边框消失。
- **列设置浮层被表格滚动容器裁剪** → 浮层作为 body 子元素用 `position: fixed` 定位，打开时读取按钮矩形；表格滚动或窗口尺寸变化时关闭浮层。
- **移除 `show-insights` 影响侧栏/全屏切换** → 概览状态改存设置；`capturePage/restorePage` 删除该字段，并补充 surface 切换测试。
- **企业性质标签与状态颜色混淆** → 性质标签只出现在公司名旁且使用浅底小字号，状态胶囊保留圆点 + 文字；颜色不是唯一识别方式。
- **视觉改动影响现有断言** → 保留关键 ID、`data-act`、`[data-capture]`、`[data-view]` 和 `#btn-knowledge`；只替换图标与样式，测试按行为选择器而非 emoji 文本断言。
- **列宽拖拽与表格滚动/紧凑模式冲突** → 拖拽期间在 window 上监听指针事件并禁止选中文本；紧凑模式不渲染手柄、不写内联宽度；媒体查询变化时重渲染表头。
- **完整列目录导致表格过宽** → 扩展列默认隐藏，全部显示时由 `.table-scroll` 横向滚动；侧栏仍只保留精简列；提供搜索和恢复默认，避免用户找不到或无法回退。
- **老配置升级后新列意外全部出现** → 归一化时只把「从未出现在 order 中」的扩展列加入 hidden；已保存的新配置完全尊重 hidden，不会反复隐藏用户主动打开的列。
- **列设置清单过长难以查找** → 浮层内滚动列表 + 名称搜索 + 当前宽度显示 + 已显示计数；表头和筛选栏双入口提高可发现性。

## Migration Plan

1. 先落地纯逻辑：`company-type.js`、`settings.js` 默认值/归一化、`store.js` 字段与导出、`vision.js` 映射。旧记录无需迁移，读取时按空处理。
2. 再改 dashboard 数据与列渲染：先实现列注册表、列设置和筛选，再改布局与样式；每一步保持现有 ID 和消息协议。
3. 最后压缩工作台外壳并替换图标，运行离线 selftest 与 workbench/CDP e2e；截图检查 400px 侧栏与 1450px 全屏。
4. 回滚策略：新字段与新设置均是增量；旧代码会忽略 `companyType`、`dashboardColumns`、`dashboardColumnWidths`、`dashboardOverviewExpanded`。如需回滚，恢复旧版扩展文件即可，不需要数据回写。
5. 交付前更新 README 截图与说明；如项目继续分发 `dist/job-tracker-extension-1.0.0.zip`，重新打包并确认 zip 内含新模块。
