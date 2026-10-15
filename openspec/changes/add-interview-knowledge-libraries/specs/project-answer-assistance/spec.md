# Spec Delta

## Purpose

在用户主动请求项目回答草稿时，从八股文题库寻找相关知识并允许人工调整参考项。结合已核对的项目资料组织回答，明确参考来源与待补充事实，帮助完善当前答案而不替代用户对真实经历的判断。

## ADDED Requirements

### Requirement: Automatic reference matching
用户主动启动项目答案辅助后，系统 SHALL 根据项目概况、个人职责与当前题目自动检索八股文题库，展示相关题目、可查看的答案及匹配依据；空答案题 SHALL 不作为默认回答依据。

#### Scenario: Match indexing knowledge to a project question
- **WHEN** 用户在包含数据库查询优化描述的项目中对“为什么使用这个索引方案？”请求辅助
- **THEN** 系统列出相关索引或查询优化题作为候选参考，让用户在生成前查看

### Requirement: Manual reference adjustment before generation
系统 SHALL 允许用户从自动候选中删除参考项，也允许搜索整个八股文题库并添加参考项；生成请求 SHALL 仅使用用户最终选定的参考内容。

#### Scenario: Replace an automatic reference
- **WHEN** 用户移除一条自动匹配题，并搜索添加另一条题后点击生成
- **THEN** 新参考题用于生成，被移除题不作为生成依据

#### Scenario: No matching questions
- **WHEN** 题库为空或未匹配到参考题
- **THEN** 系统明确显示无参考，允许用户手动搜索，或明确选择只根据项目资料生成草稿

### Requirement: Draft grounded in project facts
生成的草稿 SHALL 结合项目资料、个人职责、当前问题及选中的八股文问答，以 Markdown 返回；系统 MUST NOT 把通用知识当作用户已实施的事实，缺失的技术选型、指标或个人贡献 SHALL 标为待补充信息。

#### Scenario: Missing project measurements
- **WHEN** 项目资料未提供优化前后的耗时，参考题中包含示例性能数据
- **THEN** 草稿不声称这些示例数据属于该项目，而是标出需用户补充的指标

### Requirement: Explicit draft acceptance and one saved answer
AI 输出 SHALL 先显示为可编辑草稿，并与已有答案区分；只有用户点击保存采用草稿时才能更新当前答案。取消或生成失败 MUST NOT 修改已保存答案。

#### Scenario: Discard an AI draft
- **WHEN** 用户生成草稿后取消
- **THEN** 原答案保持不变，系统不保存第二份答案或隐含版本

#### Scenario: Accept an edited draft
- **WHEN** 用户修改草稿并选择保存
- **THEN** 当前题目更新为这一份答案，并记录本次使用的参考题来源

### Requirement: Visible reference provenance and stale reference handling
保存 AI 辅助答案后，系统 SHALL 提供本次所用八股文题的可定位参考信息；参考题后来删除或修改时，已有项目答案 SHALL 保留，并标明来源不可用或已更新，不自动重写项目答案。

#### Scenario: A reference is changed after generation
- **WHEN** 用户更新一条已被项目答案引用的八股文题
- **THEN** 项目答案内容保持不变，查看参考信息时提示参考题已更新

### Requirement: Controllable requests and concurrent edits
生成任务 SHALL 可取消，并处理超时、接口权限与错误反馈；用户修改题目、项目资料、参考选择，或其他页面更新该答案后，旧任务结果 MUST NOT 自动覆盖较新内容。

#### Scenario: Edit while generation is running
- **WHEN** 用户启动生成后修改了题目或答案，而先前请求随后返回
- **THEN** 返回内容只能作为待核对草稿，系统说明输入已变化并阻止无核对覆盖
