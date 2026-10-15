# Spec Delta

## Purpose

为用户提供独立于岗位投递的简历项目问答库，围绕项目概况与个人职责积累面试追问。支持人工维护单份 Markdown 答案与检索，使同一项目的准备内容能够在不同公司的面试中反复使用。

## ADDED Requirements

### Requirement: Independent project management
系统 SHALL 提供独立项目库入口，允许创建、查看、修改和删除项目；每个项目 SHALL 包含名称、简介和个人职责，且无需关联岗位投递记录。

#### Scenario: Create a reusable project
- **WHEN** 用户填写项目名称、简介和职责并保存，且没有选择任何岗位
- **THEN** 项目出现在项目库中，并可独立添加面试问答

#### Scenario: Delete a project with questions
- **WHEN** 用户删除包含问答的项目
- **THEN** 系统先说明将同时删除的问答数量，确认后删除该项目及其问答，其他项目、八股文和岗位记录保持不变

### Requirement: Manual project question maintenance
系统 SHALL 允许在指定项目中手动新增、编辑和删除题目；题目不能为空，答案 SHALL 允许留空，并 SHALL 为每道题保存且仅保存一份当前答案。

#### Scenario: Save a question before writing its answer
- **WHEN** 用户在项目中保存非空题目并将答案留空
- **THEN** 系统保存该题目，允许稍后补充答案

#### Scenario: Replace the current answer
- **WHEN** 用户修改已有答案并保存
- **THEN** 同一道题显示更新后的一份答案，重新打开项目仍能读取该答案

### Requirement: Markdown editing and preview
系统 SHALL 以 Markdown 保存项目答案，并提供标题、列表和围栏代码块的预览；预览 SHALL 禁止执行内容中的脚本、事件处理器或危险链接。

#### Scenario: Preview a technical explanation
- **WHEN** 用户输入带标题、列表和代码块的 Markdown 答案并打开预览
- **THEN** 预览呈现相应结构，切回编辑时原始 Markdown 和代码内容保留

#### Scenario: Render untrusted content safely
- **WHEN** 答案包含 HTML 脚本或可执行链接
- **THEN** 预览不执行这些内容，普通标题、列表和代码块仍然可读

### Requirement: Project browsing and search
系统 SHALL 支持选择项目浏览其问答，并按题目和答案正文搜索；空结果 SHALL 明确显示，且搜索 SHALL 不修改数据。

#### Scenario: Find an answer by a technical term
- **WHEN** 用户在所选项目中搜索只出现在答案里的关键词
- **THEN** 系统返回对应问答，并保持该题所属项目不变

### Requirement: Local persistence and stale edit protection
项目与问答 SHALL 保存在当前浏览器，并在页面重开或浏览器重启后可读取；保存失败或其他页面已修改同一内容时，系统 SHALL 保留编辑内容并说明失败或冲突，禁止悄悄覆盖较新内容。

#### Scenario: Concurrent edits
- **WHEN** 两个页面打开同一道题，第一个页面保存后第二个页面提交旧内容
- **THEN** 第二个页面提示内容已更新，保留尚未保存的编辑，并允许重新核对

#### Scenario: Storage failure
- **WHEN** 浏览器存储写入失败
- **THEN** 系统不显示保存成功，编辑内容仍可复制或重试
