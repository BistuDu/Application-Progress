# Spec Delta

## Purpose

提供独立的通用八股文知识库，保存可复用的题目与 Markdown 答案，通过技术分类、多标签和全文检索支持日常整理。该题库为项目回答提供参考知识，同时保持自身内容与项目经历的独立性。

## ADDED Requirements

### Requirement: Independent technical question CRUD
系统 SHALL 提供八股文题库入口，支持手动新增、查看、编辑和删除问答；每题 SHALL 有非空题目和一份可为空的 Markdown 答案，不依赖项目或岗位的存在。

#### Scenario: Add a standalone question
- **WHEN** 用户没有创建项目，仍手动保存“数据库索引为什么能加速查询？”及答案
- **THEN** 该问答保存到八股文题库，且不生成项目或投递记录

### Requirement: Categories and multiple tags
用户 SHALL 能创建、改名和删除分类，创建并使用多个标签；每道八股文题 SHALL 可归入一个分类并附加多个标签，未指定分类的题目 SHALL 可在“未分类”中找到。

#### Scenario: Filter by category and tags
- **WHEN** 用户选择“数据库”分类并筛选“性能优化”标签
- **THEN** 仅显示同时符合分类和所选标签的题目，清除筛选后可以查看全部题目

#### Scenario: Remove a category without losing questions
- **WHEN** 用户删除有题目的分类
- **THEN** 系统保留这些问答并将其移入未分类，其他分类与标签保持不变

### Requirement: Search across questions and answers
系统 SHALL 提供题目与答案正文的全文搜索，并允许与分类及标签筛选组合使用。

#### Scenario: Find a term within a code block
- **WHEN** 用户搜索只存在于某答案代码块中的技术词
- **THEN** 对应问答出现在结果中，答案中的代码内容保持完整

### Requirement: Markdown answer preview
系统 SHALL 为八股文答案提供 Markdown 编辑与预览，支持标题、列表和代码块，并禁止执行导入或用户输入的可执行内容。

#### Scenario: Edit and reopen a Markdown answer
- **WHEN** 用户保存带代码块的答案并重新打开该题
- **THEN** 用户能够查看格式化预览，并继续编辑保存的 Markdown 原文

### Requirement: Duplicate review for manual entry
系统 SHALL 在手动添加与已有题目匹配的问答时显示已有内容并要求用户核对；未经用户选择，系统 MUST NOT 自动覆盖或悄悄跳过题目。匹配仅针对八股文题库，不得把项目中的同名题目当作同一条记录。

#### Scenario: Manually add a duplicate question
- **WHEN** 用户手动填写一个已存在的八股文题目并点击保存
- **THEN** 系统展示已有答案和待保存答案，并允许保留已有答案、采用新答案或编辑合并后更新原题

### Requirement: Independent persistent data
系统 SHALL 在当前浏览器持久保存八股文问答、分类、标签和来源；八股文修改或删除 SHALL 不删除项目问答或改变岗位投递记录。

#### Scenario: Delete a question previously referenced by a project
- **WHEN** 用户删除已被项目回答参考的八股文题
- **THEN** 八股文题被删除，已保存的项目答案仍然保留，相关参考项标记为不可用
