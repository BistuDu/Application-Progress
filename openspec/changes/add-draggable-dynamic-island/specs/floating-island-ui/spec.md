# Spec Delta

## Purpose

为普通网页提供具有灵动岛观感的轻量胶囊入口，通过跟随系统的磨砂视觉、平滑形变和可拖动布局承载快捷功能。保证收起时简洁，展开时操作清楚，同时保持网页交互、键盘访问和减弱动态效果可用。

## ADDED Requirements

### Requirement: Icon-only system-themed frosted capsule
灵动岛 SHALL 以跟随系统浅深色的半透明磨砂横向胶囊、圆润轮廓、细描边、轻阴影和居中的单个图标呈现收起状态，不显示常驻文字；悬停或键盘聚焦 SHALL 提供可理解的功能提示。

#### Scenario: Initial collapsed appearance
- **WHEN** 用户首次打开允许显示的普通网页
- **THEN** 右上角出现只有图标的磨砂胶囊，网页布局不因其出现而移动

### Requirement: Compact shortcut expansion
点击或键盘激活胶囊 SHALL 从当前锚点展开紧凑横条，包含“识别 JD”“识别题目”“投递进度”“知识库”四个图标快捷入口及末尾「更多」。入口名称 SHALL 通过悬停／聚焦提示与可访问名称提供；横条 SHALL NOT 显示大块按钮背景、标题或常驻说明；点击外部或按 Escape SHALL 收起，悬停本身不得自动展开。

#### Scenario: Open and dismiss shortcuts
- **WHEN** 用户点击胶囊并随后点击面板之外的网页
- **THEN** 四个快捷入口先出现，随后面板收起，网页点击继续按正常行为处理

### Requirement: Cohesive visual transitions
胶囊在收起、展开、识别中和结果提示之间 SHALL 使用同一磨砂表面及协调的圆角、尺寸和内容过渡，避免突然跳位、遮挡文字或残留空白；任务结束后 SHALL 自然返回图标收起状态。

#### Scenario: Transition through a capture task
- **WHEN** 用户从展开面板启动识别，任务结束后返回空闲
- **THEN** 界面在快捷面板、任务胶囊、简短结果提示和图标胶囊之间平滑切换，图标与文字不裁切

### Requirement: Draggable without accidental activation
用户 SHALL 能拖动收起胶囊及展开横条的非按钮拖动区域；拖动和点击 SHALL 可区分，松手不误触展开或快捷操作，操作按钮 SHALL 能正常点击。

#### Scenario: Drag a collapsed capsule
- **WHEN** 用户按住胶囊并明显移动后松手
- **THEN** 胶囊停在新位置，不因松手展开菜单，也不启动识别

#### Scenario: Cancel pointer dragging
- **WHEN** 拖动期间发生指针取消或页面失焦
- **THEN** 拖动状态被清理，胶囊仍在视口中可用，后续点击不被永久拦截

### Requirement: Viewport-safe layout
收起胶囊、展开面板及任务提示 SHALL 保持在可见视口内；窗口缩小、缩放或临近边缘展开时 SHALL 调整临时布局，窄窗口仍能操作全部入口。

#### Scenario: Expand near a screen edge
- **WHEN** 用户将胶囊拖到右侧或底部后展开
- **THEN** 面板向可用空间展开，入口和关闭操作均在屏幕内

### Requirement: Keyboard and reduced motion accessibility
图标与操作 SHALL 具有可访问名称和可见键盘焦点；用户 SHALL 能通过键盘展开、选择操作与收起，进度反馈 SHALL 可被辅助技术读取；减弱动态效果开启时 SHALL 减少形变和持续动效。

#### Scenario: Use shortcuts without a pointer
- **WHEN** 用户通过 Tab 聚焦胶囊、按 Enter 展开并按 Escape 关闭
- **THEN** 面板可操作，焦点返回胶囊；页面其他输入区域的键盘行为不受影响

### Requirement: Page isolation and single instance
同一顶层页面 SHALL 仅有一个灵动岛，网页样式不得改变其核心布局；胶囊区域之外 SHALL 保持正常点击、输入与滚动，页面中嵌入的子框架不得产生重复胶囊。

#### Scenario: Re-inject on a styled page
- **WHEN** 页面有全局按钮样式、嵌入子框架，且扩展重复尝试接入
- **THEN** 只出现一个可用胶囊，其布局和按钮样式保持一致，页面其他区域仍可操作


### Requirement: More menu retains site controls
「更多」 SHALL 展示关闭当前网站与重置全局位置，且保留原扩展弹窗和设置页的恢复控制。菜单 SHALL 具有可访问名称、可见焦点、上下边缘避让和外部点击关闭行为；截图准备 SHALL 同时隐藏横条、菜单、提示与其阴影。

#### Scenario: Close more menu with the keyboard
- **WHEN** 用户聚焦更多并展开菜单，然后按 Escape
- **THEN** 先关闭菜单并返回更多按钮，再按 Escape 收起横条并返回图标

#### Scenario: Change system appearance
- **WHEN** 用户在网页打开期间切换系统浅色／深色
- **THEN** 收起、展开、菜单、提示和识别状态均使用对应磨砂配色，位置和业务数据不变
