# Spec Delta

## Purpose

改善项目库与八股文题库中长问答的阅读和新增操作，使用户在内容任意滚动位置都能方便添加题目，并以醒目的题目及可折叠答案快速浏览，同时保持原始 Markdown、核对流程和编辑内容安全。

## ADDED Requirements

### Requirement: Persistent contextual question creation
系统 SHALL 在项目库及八股文题库的普通浏览界面右下角提供固定“＋新建问答”，不随问答正文滚动消失；新增题目 SHALL 进入当前项目或八股题库既有新增与重复核对流程。未选择项目时 SHALL 明确提示需要先选择项目；入口 MUST NOT 遮挡底部内容、模态操作或每日复习按钮。

#### Scenario: Add after reading long answers
- **WHEN** 用户在有两条长答案的项目中展开答案并滚动到内容底部
- **THEN** 固定新建入口仍可见可点击，新增问答归属当前项目，无需向上滚动

#### Scenario: Technical bank and missing project
- **WHEN** 用户切到八股题库，或切到没有选择项目的项目库
- **THEN** 前者可通过固定入口新增独立八股问答，后者明确提示先选择项目，不误创建八股题或岗位

### Requirement: Question and answer visual hierarchy
题目 SHALL 使用强调色及大于答案正文的字号；答案内部标题 SHALL 保持层级但不大于题目，长题目 SHALL 可换行。系统 SHALL 保留答案 Markdown 原文和安全预览能力。

#### Scenario: Read an answer with headings and code
- **WHEN** 用户打开包含多级标题、列表及长代码块的答案
- **THEN** 题目保持视觉主层级，答案结构与代码完整且不执行不可信脚本，横向代码滚动不撑破页面

### Requirement: Collapsed answers and scoped bulk controls
两库阅读答案 SHALL 默认折叠，用户 SHALL 能通过点击题目或键盘展开／收起，也能对当前筛选范围全部展开／折叠。折叠 SHALL 不修改已保存内容、不隐藏必要编辑／删除操作，搜索 SHALL 仍匹配答案全文；同一浏览上下文内的普通重渲染 SHALL 保留题目展开状态。

#### Scenario: Browse and expand selectively
- **WHEN** 用户进入某项目，展开一题并保存另一条修改
- **THEN** 初次进入时答案折叠，用户主动展开的题目在同一上下文重渲染后仍保持展开

#### Scenario: Filter and expand all
- **WHEN** 用户按答案关键词筛选，再选择全部展开
- **THEN** 答案命中题仍出现在结果中，当前结果范围展开，未匹配题目的展开状态不被批量改变

#### Scenario: Preserve active edits
- **WHEN** 用户正在编辑未保存的 Markdown 并使用浏览控制或尝试新建另一题
- **THEN** 系统不将未保存输入替换或丢弃，完成原有离开编辑确认后才切换，折叠切换可由键盘操作并具有准确展开状态
