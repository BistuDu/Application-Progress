# Spec Delta

## Purpose

把简历、网页框选、图片和已有题库文件转换为可核对的结构化项目或问答，减少人工转录。通过保存前预览、逐条重复核对和来源记录保证用户控制入库内容，并只保存整理结果及来源元数据。

## ADDED Requirements

### Requirement: Resume project extraction
系统 SHALL 接受 PDF 和现代 Word（DOCX）简历，提取多个项目的名称、简介和个人职责，允许用户选择、修改后保存到独立项目库；简历提取 MUST NOT 自动创建问答、补写项目事实或保存未选中的项目。

#### Scenario: Select projects from a resume
- **WHEN** 简历识别出三个项目，用户修改其中一个项目并只选择两个保存
- **THEN** 项目库新增这两个核对后的项目，不自动生成面试题或第三个项目

### Requirement: Web region and image question extraction
系统 SHALL 支持从普通网页框选区域提取八股文问答，并支持上传或用户主动粘贴图片；一张图中的多道题 SHALL 可拆为多条可编辑问答，缺失的答案 SHALL 留空，不自动编写。

#### Scenario: Capture multiple questions on a web page
- **WHEN** 用户在网页上框选包含三道题的区域并启动八股文识别
- **THEN** 系统展示三条候选问答并带有网页来源，用户核对后选择保存，不创建 JD 记录

#### Scenario: Upload or paste an existing screenshot
- **WHEN** 用户上传图片或将剪贴板图片粘贴到题库的图片录入区域
- **THEN** 系统提供与网页框选相同的问答预览和核对操作

#### Scenario: Image contains only a question
- **WHEN** 识别图片中的问题没有对应答案
- **THEN** 候选答案为空，用户可以先保存该题并稍后补充

### Requirement: Bulk document question import
系统 SHALL 接受 Markdown、PDF、DOCX 题库文件，提取多条题目和答案并尽可能保留代码和段落结构；PDF SHALL 支持文本页及扫描页的提取，无法可靠拆分的内容 SHALL 标记为待核对而非直接入库。

#### Scenario: Import a Markdown question collection
- **WHEN** 用户导入包含题目标题、答案列表和围栏代码的 Markdown 文件
- **THEN** 预览中按题目展示候选问答，答案保留 Markdown 和代码块，用户可调整题目与答案边界

#### Scenario: Extract scanned PDF pages
- **WHEN** 用户导入没有可提取文字的 PDF 页
- **THEN** 系统使用页面图像识别生成候选问答，记录可确定的页码，并要求核对后保存

### Requirement: Review before persistence
所有提取流程 SHALL 在写入正式项目库或题库前展示候选结果；用户 SHALL 能修改、删除候选项并选择保存，取消、提取失败或关闭预览 MUST NOT 修改正式库。

#### Scenario: Cancel an extraction review
- **WHEN** 用户在文件提取完成后关闭核对界面而没有保存
- **THEN** 两个知识库的正式内容保持原样

#### Scenario: Edit extracted question boundaries
- **WHEN** 用户发现候选题目混入了一段答案
- **THEN** 用户能修改题目和答案字段，并仅将核对后的内容保存

### Requirement: Per-question duplicate reconciliation
截图和批量导入 SHALL 对已有八股文题以及当前导入批次内的重复题逐条显示冲突；用户 SHALL 能保留已有答案、采用新答案或整理合并后保存。未处理的冲突 MUST NOT 自动替换原答案。

#### Scenario: Compare an imported duplicate
- **WHEN** 导入题目与已有题目匹配，但答案不同
- **THEN** 系统并排或可切换展示两份答案，用户的选择更新原题的一份答案，保留原题身份和必要来源

#### Scenario: Duplicate within the same batch
- **WHEN** 同一导入批次包含两条匹配题目
- **THEN** 两条候选进入逐条核对流程，不静默创建两条相同题目

### Requirement: Source metadata without original attachments
系统 SHALL 保存可确定的来源类型、网页链接及标题，或文件名和可确定的页码，并允许用户补充来源；原始图片、原始文件和文档二进制 MUST NOT 写入持久存储或备份。纯图片上传或粘贴的未知页码 SHALL 留空。

#### Scenario: Save a PDF-derived question
- **WHEN** 用户保存来自 PDF 第五页的候选问答
- **THEN** 正式记录保存题目、答案、分类标签与文件名和页码，不包含原始 PDF 或页面图片

### Requirement: Actionable extraction failures and task cancellation
系统 SHALL 为不支持的格式、损坏或加密文件、识别失败、缺少 API 配置、权限不足与超出处理限制提供可理解的反馈；长任务 SHALL 能取消，取消后的结果不得自动保存。旧 `.doc` 文件 SHALL 提示转换为 DOCX 或 PDF 后重试。

#### Scenario: Cancel a long PDF extraction
- **WHEN** 用户在多页 PDF 识别过程中取消
- **THEN** 后续提取停止，已保存的问答保持不变，未核对结果不入库

#### Scenario: Unsupported legacy Word document
- **WHEN** 用户选择旧 `.doc` 文件
- **THEN** 系统说明支持 DOCX／PDF 并给出转换建议，不把文件误判为成功导入

#### Scenario: JD capture remains available
- **WHEN** 用户使用原有 JD 框选入口或快捷键
- **THEN** 原有 JD 识别与岗位审阅流程继续运行，不被八股文识别目标替代
