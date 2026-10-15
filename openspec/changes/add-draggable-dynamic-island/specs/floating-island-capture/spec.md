# Spec Delta

## Purpose

通过灵动岛接入现有网页截图与识别工作流，在保持原有结果核对和数据保存方式的同时提供轻量任务反馈。确保截图不包含胶囊、取消与错误可恢复，并将任务状态限定在实际发起采集的页面。

## ADDED Requirements

### Requirement: Four shortcuts reuse existing workflows
灵动岛 SHALL 提供四个快捷入口：“识别 JD”进入当前网页的岗位框选，“识别题目”进入当前网页的题目框选，“投递进度”和“知识库”打开或复用相应扩展页面。显示胶囊本身 MUST NOT 自动截图、读取网页正文或调用模型。

#### Scenario: Open the knowledge library
- **WHEN** 用户点击知识库入口且知识库页面已打开
- **THEN** 扩展复用并聚焦该页面，胶囊中不另建知识库编辑器

#### Scenario: Idle island on a web page
- **WHEN** 用户浏览网页而未点击采集入口
- **THEN** 胶囊保持空闲，不产生截图或模型请求

### Requirement: Capture the initiating visible page
网页入口发起截图时 SHALL 绑定实际发送操作的顶层页面；如截图前用户已切换到其他标签或窗口，系统 SHALL 停止本次截图并提供可重试反馈，禁止将其他页面的内容误送入该任务。

#### Scenario: Switch tabs before capture finishes preparing
- **WHEN** 用户点击识别后立即切换标签，截图尚未发生
- **THEN** 本次采集停止或要求回到发起页重试，不识别新标签内容

### Requirement: Hide island before all extension screenshots
无论通过灵动岛、工具栏、右键还是既有快捷键截图，扩展 SHALL 在截图前隐藏胶囊及其菜单、提示和阴影，截图中不得包含这些 UI；准备失败时 SHALL 不继续截图，失败或取消后按偏好恢复可用状态。

#### Scenario: Capture from a keyboard shortcut
- **WHEN** 普通网页显示胶囊，用户执行原有截图快捷键
- **THEN** 截图不包含胶囊和提示，后续仍进入既有框选／核对流程

#### Scenario: Screenshot API fails
- **WHEN** 胶囊已临时隐藏但截图调用失败
- **THEN** 用户获得明确失败反馈，允许显示的网站恢复胶囊，隐藏状态不永久卡住

### Requirement: Compact page-local processing feedback
框选完成后，当前页面的胶囊 SHALL 显示正在识别的简短状态、进行中动效和取消操作；没有真实百分比时 MUST NOT 显示伪造进度。同页面一次只允许一个采集任务，其他页面不得错误展示此任务进度。

#### Scenario: Process a question capture
- **WHEN** 用户完成题目框选，模型尚未返回结果
- **THEN** 发起页面显示可取消的识别状态，其他网页的胶囊保持各自状态

### Requirement: Cancel without accepting stale results
胶囊取消操作 SHALL 中止与当前页面及任务匹配的识别，并及时反馈取消；已取消任务的迟到结果 MUST NOT 再打开核对页面、改写较新任务状态或自动保存数据。

#### Scenario: A result arrives after cancellation
- **WHEN** 用户取消任务后，模型请求仍返回结果
- **THEN** 胶囊不显示该任务成功，系统不因迟到结果新开知识库核对或保存记录

### Requirement: Preserve review and distinguish recognition from saving
JD 识别成功 SHALL 继续使用现有岗位审阅界面，题目识别成功 SHALL 继续交接至知识库核对；结果提示 SHALL 区分“识别完成／待核对”与“已经保存”，不得以识别成功代替用户保存。

#### Scenario: Recognize a JD without saving
- **WHEN** 模型返回岗位结果但用户尚未点击保存
- **THEN** 岗位审阅界面可编辑，胶囊反馈不宣称投递记录已经保存

### Requirement: Restore or fall back during overlay lifecycle changes
框选和完整核对界面运行时，胶囊 SHALL 避让这些交互；结束后按偏好恢复。网站胶囊关闭时，既有工具栏、右键和快捷键 SHALL 仍可执行采集，识别状态与取消操作 SHALL 由现有界面提供。关闭显示偏好 SHALL 不隐式取消正在运行的识别。

#### Scenario: Use capture on a site with its island disabled
- **WHEN** 用户关闭网站胶囊后使用原有截图快捷键
- **THEN** 采集、识别中取消与核对仍然可用，操作结束后胶囊保持关闭

#### Scenario: Disable visibility during processing
- **WHEN** 用户在识别过程中通过扩展菜单关闭该网站胶囊
- **THEN** 任务继续，原有界面接管状态与取消操作，任务结束后该网站不再显示胶囊

### Requirement: Bounded recovery for missing task feedback
识别超时、页面导航、通信中断或扩展更新时 SHALL 清理临时交互状态或显示可恢复反馈；胶囊不得无限保持“识别中”，位置与网站偏好 SHALL 保留。

#### Scenario: Lost completion message
- **WHEN** 当前任务的结果通知未能送达页面
- **THEN** 在配置超时及反馈宽限结束后，胶囊显示任务中断或重试提示，并回到可操作状态
