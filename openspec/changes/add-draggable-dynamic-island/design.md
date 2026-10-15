# Design

## Context

范围与动机见 `proposal.md`。本次是权限、页面常驻 UI、截图与状态反馈的跨模块变更，因此创建技术设计。

- 扩展是原生 MV3，最低 Chrome 116；manifest 当前没有 `content_scripts`，只有模型域名 host 权限、可选 HTTP／HTTPS 权限及 activeTab。
- `ensureOverlay` 在用户采集后注入 `src/content/overlay.js`。overlay 使用幂等 IIFE 与 Shadow DOM，宿主为 `jdt-overlay-host`；框选、中心识别卡片、右侧 JD 核对共用此宿主，`unmount` 将其移除。
- `startCapture` 先读取当前活动标签、截图，再注入选择器；同一函数供工具栏、右键、快捷键和重新截图使用。新增常驻胶囊必须在此公共路径处理截图避让。
- overlay 已有 idle／selecting／processing／review／done 状态、requestId 与取消；JD 结果交给原审阅抽屉，题目结果经 session 交接至知识库页面。
- background 已有 OPEN_DASHBOARD、OPEN_KNOWLEDGE 和按任务 ID 的识别路由，但 START_CAPTURE 当前未采用消息发送页面的 tabId。
- 既有 `scripts/selftest.mjs`、`knowledge-selftest.mjs` 和隔离 CDP 测试可复用。既有浏览器脚本在扩展副本中添加权限，因此本次不能仅靠副本补权来证明正式网页入口可用。

## Goals / Non-Goals

**Goals:**
- 让常驻 UI 与临时截图／核对 UI 有独立生命周期，共享既有业务操作。
- 把美观落实为视觉参数、状态过渡和真实页面的视觉验收，而不只完成按钮功能。
- 保持一个全局拖动锚点，网站开关和拖动位置均可持久化与跨页面更新。
- 将页内按钮、截图权限、截图隐藏和取消状态组成可验证的完整链路。

**Non-Goals:**
- 不改岗位或知识库的数据模型，不把用户数据、Key 或完整资料送入常驻胶囊。
- 不模拟桌面系统窗口、额外安装 Mac 应用或使用 Apple 品牌素材。
- 不引入动画框架、远程脚本、全局模型任务看板或网页正文自动分析。

## Decisions

### 1. 独立常驻脚本和业务浮层

新增 `src/content/island.js`，独立宿主 `jdt-island-host`、Shadow DOM、单实例标记及销毁逻辑。初始化只读取胶囊偏好与必要的操作状态；不调用包含记录与完整设置的 GET_STATE。宿主固定定位、脱离文档流，只有胶囊和展开面板接收 pointer 事件。

采用经典 IIFE，与动态注入的 overlay 位于同一个扩展 isolated world。新增纯逻辑 `src/lib/island-core.js` 作为可同时在 content script 与 Node 中加载的经典脚本，提供几何、拖动阈值与状态归约；不依赖 DOM、存储或网络。manifest 将它放在 island.js 之前。background 的偏好存储模块为 ES module `src/lib/island-preferences.js`。

island 暴露最小内部桥接对象给 overlay，提供可见性查询、状态更新、隐藏原因集合及取消回调。桥接只在 isolated world 使用，不向网页建立 postMessage 控制通道。相比把胶囊塞进 overlay 的 mount／unmount，独立宿主保证关闭核对不会移除常驻入口，也无需重写岗位表单。

### 2. 普通网页自动接入与权限选择

manifest 增加 required `host_permissions: ["<all_urls>"]`，保留 activeTab 兼容既有入口；静态 content_scripts 只匹配 `http://*/*` 和 `https://*/*`，在 `document_idle`、顶层 frame、isolated world 中加载核心及胶囊脚本。应用商店显式排除，脚本也校验顶层和协议；扩展页、内置页、file／data／blob 页面不属于本次“普通网页”。

权限选择的依据：captureVisibleTab 要求 activeTab 或 `<all_urls>`，而网页内点击自定义胶囊不是 Chrome 所列的 activeTab 授权手势。为了使全站常驻与页内直接截图成立，使用 required 全网站权限，由浏览器在安装／升级时处理授权。[截图 API 文档](https://developer.chrome.com/docs/extensions/reference/api/tabs#method-captureVisibleTab)、[activeTab 授权手势](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab)、[content scripts](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts)。

可选站点权限加动态注册的方案需要额外首次授权才覆盖所有网站，且需处理权限注册恢复；与本次默认全站显示及页内直接截图的目标相比，required 权限更直接。原有模型域名授权代码保持接口兼容，扩大的网站权限会使其已获准检查正常通过。

安装／更新或用户恢复网站显示时，background 对已经打开的普通顶层页面执行幂等接入；关闭、限制权限或不支持注入的标签跳过，不在每次任务中循环重新注入。浏览器权限不足与网站偏好关闭作为两种状态分别展示，说明浏览器站点访问或重新启用扩展的操作，不绕过浏览器限制。

### 3. 视觉参数与交互基线

用户确认的磨砂交互预览取代初版深色两行面板。实现继续使用本地 Shadow DOM／SVG，不引入远程库，最低 Chrome 116 保持不变。

| 元素 | 当前确认参数 |
| --- | --- |
| 收起胶囊 | 56 × 36 CSS px，18px 圆角，19px 单色图标，默认顶／右 16px |
| 表面 | 系统浅色为乳白磨砂、深色为烟灰磨砂；约78%不透明度、24px blur、轻阴影和细内高光。CSS 媒体查询独立跟随系统，不跟随网页配色；不支持滤镜时回退同色实底 |
| 展开 | 约212 × 44px 单行，四功能图标＋分隔线＋末尾「更多」；不展示标题、按钮文字或底部说明。仅悬停／聚焦显示入口名，aria-label 始终可用 |
| 更多菜单 | 独立磨砂小菜单，关闭此网站、重置位置；按当前锚点择侧和上下避让；外部点击关闭，Escape 优先关闭菜单并返回「更多」，再次 Escape 收起横条并返回图标 |
| 动效 | 尺寸与圆角280ms，轻柔快速稳定；内容约140ms淡入、延迟80ms。使用稳定的左右锚点与上下锚点，不将当前形变的像素尺寸作为新的持久位置 |
| 状态 | 识别中约220 × 44px，成功约200 × 40px，错误约240 × 40px；同样磨砂、真实耗时、取消；终态1800ms后回到单图标 |

窄视口保留横向入口并压缩间隙／按钮，不退回大面板；菜单按可用空间限制尺寸并允许必要滚动。偏好仍以现有归一化坐标保存，尺寸变更不触发存储迁移或重写。粗指针按可用宽度增加目标尺寸。

按钮具有 aria-label、aria-expanded、键盘焦点与 tooltip；Tab／Enter／Space 操作菜单，Escape 收起并返回焦点，非胶囊焦点时不拦截页面输入。状态使用节制的 aria-live，不按每个计时 tick 播报。`prefers-reduced-motion` 时缩短或去除形变／旋转，保留清晰静态状态。默认空闲不运行持续 JS 动画。

替代方案是圆形悬浮按钮或直接显示工具条，前者缺少用户要求的横向胶囊，后者常驻面积较大。当前方案兼顾纯图标收起与任务状态伸缩。

### 4. 全局锚点、拖动与视口调整

独立本地键 `islandPreferences`：

```text
schemaVersion: 1
position: { x: 1, y: 0 }   // 可用胶囊区域内的归一化坐标；默认右上
disabledHosts: []          // 小写 hostname，精确匹配
```

位置映射基于收起胶囊尺寸及安全边距。相同视口得到相同位置，不同窗口按比例映射，并用当前展示尺寸做临时 clamp。展开、任务反馈、页面缩放或视口变小的 clamp 不写回偏好，避免用户在窄窗口操作后全站位置改变。重置只更新 position，不清空 disabledHosts。

收起胶囊本体和横条的非按钮间隙可拖动。使用 Pointer Events、pointer capture 与约 6 CSS px 的移动阈值，超过阈值后抑制该次点击。拖动期间停止形变、用 transform 跟随，pointerup 后保存归一化锚点；pointercancel／blur 清理拖动并取消这次点击，不发起业务操作。默认自由拖动、不强制吸附边缘，用户没有要求吸边。

位置更新在松手后单次提交，跨页面通过 storage change 更新；正在拖动的页面暂缓远端位置，用户完成拖动后以最后完成的拖动为准。resize 与 visual viewport 改变只重算布局。

### 5. 网站开关与偏好写入

横条末尾「更多」提供“在此网站关闭”和“重置位置”；popup 提供当前网站状态、开启／关闭和“位置重置”。hostname 精确匹配是默认解释：同 hostname 的 HTTP／HTTPS、不同路径及端口一起生效，不自动影响其他子域或父域。设置页可查看已关闭 hostname 并恢复，便于找到此前关闭的网站。

新增 ISLAND_GET_STATE、ISLAND_SET_POSITION、ISLAND_SET_SITE、ISLAND_RESET_POSITION 等小范围路由；网页来源由 sender 的顶层 tab URL 推导，popup／options 请求的目标经扩展页来源和当前标签验证，不能仅信任网页消息中的任意 hostname／tabId。返回内容限偏好、当前可用性与必要配置摘要，不包含 Key 或完整业务记录。

background 使用独立串行队列，按字段更新，防止一个页面拖动覆盖另一个页面的网站关闭列表。失败保留临时位置但明确显示“未保存”，网站关闭失败不隐藏成已持久关闭。偏好不并入岗位或知识库 JSON 备份，避免改变已完成变更的备份格式。

关闭网站只改变显示偏好，不中止已有识别。overlay 的 processing 渲染根据胶囊是否可见在胶囊和原中心状态界面间切换，原始 startedAt／requestId／cancel 回调保持相同，不重新调用模型。重新开启同网站时同步恢复并采用全局位置。

### 6. 截图准备与恢复的公共握手

所有采集入口仍走 startCapture／RECAPTURE 公共逻辑。网页发起时采用经验证的 sender.tab.id 与 frameId；popup、右键、快捷键保留当前活动标签的取法。captureVisibleTab 实际截取 window 的活动标签，因此在准备前与调用前确认该标签仍活动、URL／文档未变化；发生切换就停止，不悄悄转去识别另一网页。

捕获过程：

```text
resolve initiating tab
  --> verify capturable and configured
  --> island prepare-hide acknowledgement
  --> verify initiating tab still active
  --> captureVisibleTab
  --> show existing region selector
  --> finally release capture-hide reason
```

准备消息在隐藏整个宿主（包括阴影、菜单和 tooltip）并完成绘制确认后回应；确认超时或原页面已导航时终止本次采集。没有胶囊实例的页面继续旧流程；已接入的页面需明确回应“可见／已隐藏／网站关闭”。hide 使用原因集合 capture、selecting、review、site-disabled，finally 只释放当前原因，不把用户已关闭网站强制显示。

选择器出现时 overlay 保持 selecting 隐藏原因，框选结束后 processing 可重新显示胶囊。JD review 暂时隐藏胶囊以避让右侧抽屉和关闭按钮，抽屉保存或关闭后恢复；题库交接由现有页面完成。截图 API 错误、注入错误和取消都执行恢复清理。

有限绘制确认使用带超时的帧／计时握手，不能只用无上限 requestAnimationFrame 等待；此前 PDF 后台标签渲染问题说明页面可能暂停帧回调。静态声明注入与更新时的重复接入均需幂等，现有标签可能没有胶囊时先 ping 判断，再决定是否需要等待隐藏。

### 7. 页面任务状态与 overlay 协作

胶囊 UI 状态是 collapsed、expanded、processing、success、error；hidden reasons 与 dragging 是独立维度，避免关闭网站、截图与任务进度互相重写。

overlay 在任务进入 processing 后向桥接发送 requestId、target、startedAt、超时和取消回调；可见胶囊接管状态时不渲染原中心遮罩，网页其他区域可继续操作。胶囊不可用时保留中心状态界面及现有取消。idle、done、unmount、Escape 和 abort 路径均通知桥接释放临时状态。

每个顶层页面只接受本页当前 requestId 的状态；正在处理时禁止再发起第二个采集。取消先标记当前任务已终止，再调用现有 ANALYZE_ABORT，防止迟到成功事件影响 UI。background 的 JD／题目识别也在结果投递、session 写入和 openKnowledge 前验证任务未取消，尤其修正取消后仍交接核对的可能路径。通知不包含原始截图或完整 JD／问答正文。

进度来自现有非流式调用，仅显示“正在识别”与真实经过时间，不生成伪百分比。识别完成显示“已识别，待核对”或交接提示；保存成功才可显示“已保存”。识别成功继续原审阅或知识库交接，UI 不承担正式落库。

以配置 timeoutMs 加有限宽限设置页面看门狗；结果丢失或 worker 中断会进入可恢复错误状态，不无限转圈。新的 requestId 和任务结束取消旧 timer。页面导航／扩展更新清理实例、回调和临时状态；必要时说明刷新恢复，已持久偏好保留。

### 8. 分发、兼容与验证

原工具栏、右键和快捷键保持功能；关闭网站胶囊不会禁用业务。新代码不修改记录、知识库、默认状态词表或模型提示词。设置页只新增胶囊偏好管理，扩展分发继续包含 manifest、README、src 和 icons。

新增离线验证覆盖偏好归一化、并发字段更新、位置映射、边界夹取、拖动阈值和状态过期。新增 `scripts/island-e2e.mjs` 复用 CDP 隔离 profile 和本机测试页，使用正式 manifest；不得临时加 `<all_urls>` 或先点击工具栏来掩盖页内采集权限问题。模型使用可控延迟／错误 mock，避免视觉与取消验证依赖真实接口速度。

浏览器验证包括两个 hostname、多个标签与小／大视口、重复注入、网站关闭恢复、跨网站位置记忆、拖动后不展开、四入口、无 Key、截图错误、准备超时、取消后迟到结果、关闭网站时的处理界面接管。带特征色背景的截图样例确认 captured dataURL 无胶囊及阴影，覆盖岛内、工具栏、右键、快捷键、重新截图入口。已有 JD 与知识库测试进行必要回归。

美观须单独验收：保存浅色／深色／复杂导航网页上的收起、展开、识别中、结果提示、小窗口和边缘展开截图，以及展开／收起的短录屏或逐帧样例；实际查看比例、文字裁切、阴影、间距、状态衔接和跳位。单靠“按钮可点”不算视觉验收完成。报告存于临时验证目录，必要的参数修订记录在交付说明中。

## Risks / Trade-offs

- [新增全网站权限可能触发浏览器升级授权] → 安装说明明确权限用于常驻入口和主动截图，未授权时区分权限状态与网站关闭，保留既有入口。
- [胶囊会覆盖网站右上角的按钮] → 提供拖动、网站关闭与位置重置；小面积纯图标收起，完整核对时主动避让。
- [截图隐藏或页面状态消息丢失] → 带超时的准备确认、finally 释放、页面看门狗及任务 ID 校验，不接受可能包含胶囊或错误标签的截图。
- [页面全局样式或 SPA 重建影响宿主] → Shadow DOM 与宿主样式重置，置于顶层稳定节点，采用有限的宿主移除检查并保持幂等，不轮询网页正文。
- [两类 UI 的任务／隐藏状态互相覆盖] → 独立隐藏原因集合和单页任务状态机，取消／切站点／核对结束均有专门回归。
- [灵动岛“美观”依赖细节和真实页面环境] → 固定视觉基线并做多背景、多视口、过渡状态的人工视觉 QA，允许调整细节但不改确认的交互范围。
- [跨窗口尺寸不同不能保持完全相同像素位置] → 使用单一归一化锚点；同尺寸一致，不同尺寸按比例映射并边界避让，不保存每站位置。

## Migration Plan

1. 缺少 `islandPreferences` 时按默认右上位置和无禁用网站渲染；实际首次偏好修改才写独立键。现有业务数据不迁移。
2. 增加正式 manifest 权限及 content_scripts，安装／升级获准后默认全站接入，并补充已打开网页的幂等注入。
3. 完成离线、正式权限浏览器验证、截图内容审计与视觉 QA，更新 README 并重打分发包，逐文件核对包与工作区一致。
4. 回退时移除常驻脚本、偏好路由与截图／overlay 协作并恢复原 manifest；旧版本不会读取胶囊偏好，岗位与知识库数据保持可用。打开网页刷新后移除旧内容脚本实例。


## 2026-10-15 已确认视觉修订

批准依据：用户确认半透明 macOS 磨砂、紧凑横条、跟随系统、末尾更多菜单，并认可交互预览后同意接入插件。预览参数为 blur24／opacity78／duration280。原25项记录首次功能完成；8.x跟踪本轮替代样式、菜单与回归。截图避让、API路由、存储结构和任务桥接仍为同一实现边界。
