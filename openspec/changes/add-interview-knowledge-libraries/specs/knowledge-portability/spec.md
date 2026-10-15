# Spec Delta

## Purpose

让用户能够完整备份并恢复当前浏览器中的项目与八股文知识库，同时将问答导出为便于阅读的 Markdown。保存两库关系、分类标签和来源，确保迁移与恢复不依赖原始附件或模型配置。

## ADDED Requirements

### Requirement: Complete versioned knowledge backup
系统 SHALL 导出带格式标识、版本和导出时间的 JSON，完整包含项目概况、项目问答、八股文问答、分类、标签、来源与 AI 参考关系；备份 MUST NOT 包含 API Key、原始文档、原始截图或临时草稿。

#### Scenario: Export both libraries
- **WHEN** 用户选择完整备份
- **THEN** 下载的 JSON 覆盖两个知识库，保留实体身份和引用关系，并可用于后续恢复

### Requirement: Validated and confirmed restore
系统 SHALL 在恢复前验证格式版本、必要字段及项目归属等关系，并展示将恢复的内容数量；用户确认后 SHALL 恢复备份中的两个知识库，替换当前知识库内容。格式无效、版本不支持、用户取消或写入失败 MUST NOT 部分改变当前知识库。

#### Scenario: Restore a valid backup
- **WHEN** 用户选择有效备份并确认恢复
- **THEN** 两个知识库恢复为备份中的项目、问答、分类、标签与来源状态，实体和参考关系保留

#### Scenario: Reject an invalid backup
- **WHEN** JSON 中包含不存在项目的项目问答，或格式版本不受支持
- **THEN** 系统说明具体问题并拒绝恢复，当前知识库保持不变

#### Scenario: Cancel replacement
- **WHEN** 用户查看恢复预览后取消
- **THEN** 当前知识库内容保持原样

### Requirement: Readable Markdown export
系统 SHALL 能将项目库按项目、八股文题库按分类导出 Markdown，保留题目、答案的标题列表与代码块，以及标签和可用来源信息；用户 SHALL 能选择导出一个知识库或两个知识库。

#### Scenario: Export a project and its answers
- **WHEN** 用户导出项目库 Markdown
- **THEN** 文件包含项目名称、简介和职责，以及所属题目、当前答案和参考来源

#### Scenario: Export the technical question bank
- **WHEN** 用户导出八股文题库 Markdown
- **THEN** 文件按分类组织问答，包含标签和来源，代码围栏与正文不被破坏

### Requirement: Isolation from existing job data portability
知识库备份、恢复和 Markdown 导出 SHALL 与现有岗位记录的数据操作区分；知识库恢复不得覆盖岗位记录、状态词表或模型设置，原有岗位 JSON／CSV／Markdown 操作 SHALL 继续可用。

#### Scenario: Restore knowledge alongside job records
- **WHEN** 浏览器已有岗位记录和 API 设置，用户恢复知识库备份
- **THEN** 岗位记录、其截图与状态、API 设置保持原样，仅知识库内容按确认的备份恢复
