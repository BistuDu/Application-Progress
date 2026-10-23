# Tasks

## 1. 企业性质数据与纯逻辑

- [x] 1.1 新增 `src/lib/company-type.js`：定义四类枚举与 tone、`normalizeCompanyType`（含「中央企业／国有企业／民营企业／外资／合资」等别名）、保守的央企/私企词典、地方国资关键词、`suggestCompanyType({company, explicitType})` 和 `bindCompanyTypeField`；用离线用例验证「中国石化→央企」「作业帮→私企」「西藏德众→空」「明确国企优先于词典」「用户选择后不被覆盖」。
- [x] 1.2 修改 `src/lib/store.js`：`buildRecord`、`updateRecord`、`mergeImport` 统一归一化 `companyType`；CSV 在「公司」后增加「企业性质」列（空值写「未标注」），Markdown 表格和岗位详情标题加入企业性质；用离线样例验证新旧记录、空值、别名和 JSON 往返不丢字段。
- [x] 1.3 修改 `src/lib/settings.js`：在 `DEFAULT_PROMPT` 增加 `company_type` 字段和「仅截图明确写出时填写、不得猜测」规则；增加 `dashboardColumns` 默认值与 `normalizeDashboardColumns`（过滤未知 ID、去重、补齐默认列），增加 `dashboardOverviewExpanded: false`；用 `getSettings` 验证缺省、损坏和部分配置都能得到合法结构。
- [x] 1.4 修改 `src/lib/vision.js`：映射 `company_type`/`companyType` 到归一化企业性质，并纳入 `rawFields`；用固定模型 JSON 验证明确写出时得到类型，缺失或非法值得到空字符串，其他字段解析不变。

## 2. 识别、手动添加与详情编辑

- [x] 2.1 修改 `src/content/overlay.js` 核对面板：在企业性质位置增加下拉框、建议来源提示和标签预览，接入 `bindCompanyTypeField`，保存时写入 `companyType`；在 mock 识别结果中分别验证词典建议、截图明确类型、未匹配留空和手动修改后保存。
- [x] 2.2 修改 `src/dashboard/dashboard.html/js` 手动添加弹窗：增加企业性质下拉，公司名输入时在用户未手动选择的前提下自动建议，提交时携带 `companyType`；验证新增记录后列表标签和重新打开详情一致。
- [x] 2.3 修改详情抽屉：增加企业性质下拉和「未标注」状态，保存时更新记录；验证改为央企/私企/其他/未标注后，列表标签、筛选结果和导出内容同步变化。
- [x] 2.4 在表格公司名后渲染 `type-badge`，未标注不渲染标签，标签带 `title` 与可读文字；验证四种类型颜色不同、长公司名仍截断、隐藏其他列后标签仍显示。

## 3. 企业性质筛选与导出

- [x] 3.1 在筛选栏增加 `#f-company-type`，提供全部、央企、国企、私企、其他、未标注（内部值 `__unset__`）；验证单个筛选、与关键词/状态/来源/时间组合、计数更新和空结果。
- [x] 3.2 把企业性质加入搜索 haystack，验证搜索「央企」能命中已标注记录，搜索公司名不受影响；验证批量选择、全选和删除在筛选后仍只作用于当前结果。
- [x] 3.3 在 dashboard 导出入口验证 CSV、Markdown、JSON：CSV/Markdown 有企业性质列且空值为「未标注」，JSON 保留空字符串，旧 JSON 导入后性质为空且不报错。

## 4. 列注册表与配置持久化

- [x] 4.1 在 `src/dashboard/dashboard.js` 建立固定列（勾选、公司/岗位、操作）与可选列注册表（记录时间、地点、薪资、状态、投递日期、来源、下一步），用统一 `visibleColumns` 渲染表头和行，动态计算空状态/错误行 `colspan`；验证默认顺序、公司列固定、隐藏任意列后表头与单元格仍对齐。
- [x] 4.2 在 `dashboard.html` 用动态 `<thead>` 替换写死表头，保留 `table`、`.table-wrap`、`#tbody`、`#check-all`、`#count`、`#f-sort` 等现有选择器；验证旧 e2e 选择器仍能定位表格和筛选控件。
- [x] 4.3 接入 `dashboardColumns` 设置：加载时归一化并应用，修改列显示/顺序时通过 `SAVE_SETTINGS` 保存；验证刷新、扩展重开、侧栏/全屏切换后配置一致，损坏配置回退默认。
- [x] 4.4 实现表头「列设置」浮层：复选显示列、拖拽排序、上移/下移键盘操作、恢复默认、Escape/外部点击关闭、关闭后焦点回到按钮；验证浮层不被表格滚动容器裁剪，侧栏宽度下不溢出。
- [x] 4.5 实现 `compact-table` 模式：用 `matchMedia('(max-width: 700px)')` 切换类，侧栏只保留勾选、公司/岗位、状态和操作，隐藏低优先级列；验证侧栏无水平滚动、切回全屏恢复配置、精简不修改已保存配置。
- [x] 4.6 扩展完整列目录：新增企业性质、岗位类型、学历、经验、人数、截止时间、投递方式、技能、摘要、备注、最后修改、状态变更、来源链接、页面标题和识别模型列；扩展列默认隐藏，打开企业性质/岗位类型列时隐藏公司名旁的重复信息；验证老配置升级后仍只显示原有七列、全部显示后 22 个可选列都能渲染。
- [x] 4.7 实现表头列宽拖拽：每个数据列（含公司列）右边缘提供手柄，拖拽实时调整并限制在 70–600px（公司列 160–600px）；双击复位、左右方向键微调和 Home 复位；列宽写入 `dashboardColumnWidths`，重载和侧栏/全屏切换后保持，紧凑模式隐藏手柄并使用紧凑列宽。
- [x] 4.8 增强列设置浮层：按名称搜索、显示当前列宽、已显示/总列数、「全部显示」和包含列宽的「恢复默认」；表头与筛选栏双入口打开浮层，验证搜索只过滤清单、不修改配置。

## 5. 动态列下的表格交互

- [x] 5.1 调整状态与投递日期的事件绑定，使对应列隐藏时不报错、显示时可编辑；验证状态修改写入 `statusHistory`、日期修改后重新加载仍保留。
- [x] 5.2 验证查看详情、删除、行选择、全选、批量改状态/删除在任意列组合下正常；验证空结果和空库的 `colspan` 与空状态提示正确。
- [x] 5.3 把「下一步」从公司单元格移到独立列，公司/岗位最多两行，下一步单行截断；验证长下一步不撑高行，隐藏该列后公司单元格仍正常。

## 6. Dashboard 全高布局

- [x] 6.1 重构 `dashboard.html`：把顶部统计卡片和图表包进 `.overview`，增加常驻 `.overview-summary` 和「数据概览」切换按钮；把表格包进 `.table-scroll`，保留 `#batch`、`#empty`、`#table` 等现有节点。
- [x] 6.2 修改 `dashboard.css` 为 `html/body height:100%` 的纵向 flex 布局，`.table-wrap` 占满剩余高度，只有 `.table-scroll` 纵向滚动；验证默认收起概览时页面无纵向滚动、筛选栏常驻、表头吸顶、空状态可见。
- [x] 6.3 实现概览摘要渲染（总记录、本周新增、进行中、面试及以后、Offer、拒绝/结束）和展开/收起逻辑，状态写入 `dashboardOverviewExpanded` 并记住；验证新增/改状态/删除后摘要与展开图表同步，保存失败时 UI 回滚并提示。
- [x] 6.4 移除只在侧栏注入的「统计分析」按钮和 `show-insights` 类，更新 `registerViewState` 的 capture/restore 字段；验证侧栏/全屏切换后概览状态、筛选、选中集和编辑中的抽屉不丢失。
- [x] 6.5 压缩 dashboard 顶栏与筛选栏：隐藏/缩小模型副标题，按钮改为紧凑尺寸，状态 chips 在窄屏横向滚动，筛选控件可换行；验证 400px 侧栏和 1450px 全屏都无横向溢出。
- [x] 6.6 实现地点单行摘要（如「青岛 等 6 地」）与完整值提示，压缩行内边距、日期输入和状态下拉高度；验证默认字号下行高在 42–48px，长地点不增加行高。

## 7. 工作台外壳压缩

- [x] 7.1 重构 `src/workbench/workbench.html`：把 `.workspace-tabs`、`.capture-actions`、`.workspace-controls` 收进同一个 `header.workspace-head`，保留所有 `[data-view]`、`[data-capture]`、`#display-mode`、`#close`、`#mode-label`、`#feedback`、`#pages` 选择器。
- [x] 7.2 修改 `src/workbench/workbench.css`：宽屏单行、侧栏两行、窄屏框选按钮只显示图标，标签页改为浅灰分段控件；验证 400px 下头部不超过两行、无横向滚动、按钮仍可点击。
- [x] 7.3 更新 `src/workbench/workbench.js` 与 `navigation.css`（如需要）：确认框选、标签切换、全屏/侧栏切换、关闭确认和独立 dashboard 导航仍工作；验证没有重复的 `[data-capture]` 元素导致点击歧义。

## 8. 视觉精修

- [x] 8.1 新增 `src/lib/icons.js`，提供 search、eye、trash、settings、columns、chevron、plus、download、upload、close 等线性 SVG；替换 dashboard 与工作台中的 emoji 图标，所有图标按钮补 `title`/`aria-label`，验证 SVG 不抢焦点且按钮可被辅助技术识别。
- [x] 8.2 在 `dashboard.css` 统一蓝灰 token、圆角、阴影、字号和间距；实现企业性质浅底标签、状态「圆点 + 文字」胶囊、按钮/输入框/卡片/图表的悬停、按下、焦点和禁用态；验证正文对比度达到 4.5:1，键盘焦点清晰。
- [x] 8.3 按 1280/900/700/400px 断点验证响应式：概览多列/单列、筛选换行、状态 chips 横向滚动、侧栏表格精简、无内容裁切；在 360px 宽度下确认页面无横向溢出。
- [x] 8.4 检查 `prefers-reduced-motion`、滚动条、选中/悬停/焦点差异，避免动画和阴影造成干扰；用截图对比改版前后的首屏表格行数。

## 9. 验证与交付

- [x] 9.1 扩展 `scripts/selftest.mjs` 的离线用例：企业性质归一化/建议、`normalizeDashboardColumns`、`normalizeDashboardColumnWidths`、老配置扩展列默认隐藏、地点摘要、CSV/Markdown/JSON 新列、旧 JSON 导入；运行脚本确认离线部分通过。
- [x] 9.2 扩展 `scripts/workbench-e2e.mjs`：覆盖侧栏默认折叠概览、页面无纵向滚动、列设置隐藏/恢复、侧栏精简、企业性质标签与筛选、手动添加和识别保存的性质；运行并检查 `tmp/workbench-qa` 截图。
- [x] 9.3 扩展 `scripts/e2e-cdp.mjs --mock`：覆盖全屏工作台头部单行、概览展开/收起、列设置上下移动、按名称搜索、全部显示/恢复默认、表头拖拽列宽与重载保持、筛选栏列设置入口、导出内容、列配置持久化；运行并确认原有识别、保存和统计断言不回归。
- [x] 9.4 在真实 Chrome 中加载扩展，按 400×800 侧栏和 1450×950 全屏各走一遍新增/筛选/改状态/切列/展开概览，记录同屏行数与截图；确认知识库、设置页和胶囊入口未被工作台外壳改动破坏。
- [x] 9.5 更新 README 的投递进度页说明、企业性质和列设置用法、布局截图；重新生成 `dist/job-tracker-extension-1.0.0.zip` 并确认新模块已包含。
