# Spec Delta

## Purpose

为八股文题库提供每日回想、揭晓答案、自评和间隔复习，通过可恢复的当日计划及学习历史支持快速复习，并以今日进度、连续天数与日历呈现实际完成情况，所有学习数据保留在当前浏览器且可以完整备份。

## ADDED Requirements

### Requirement: Daily review entry and settings
系统 SHALL 在八股题库内提供“每日复习”与返回普通浏览的入口，展示今日进度、连续天数和打卡日历；默认题量 SHALL 为 10，可设置 1–100 的整数、一个分类及多个同时匹配的标签。系统 SHALL 保存设置并明确当天计划生成后的调整在下一天生效，MUST NOT 改变已经生成的当天计划。

#### Scenario: Configure and start a day
- **WHEN** 用户设置数据库分类、两个标签与每日 5 题并开始复习
- **THEN** 计划只从同时符合这些条件的八股题生成，重新打开页面可读取设置与同一计划，项目问答不参与

#### Scenario: Change settings after starting
- **WHEN** 用户已生成今日计划后将每日题量改为 20
- **THEN** 系统说明明日生效，今天的题目和完成目标保持不变

### Requirement: Prioritized unique daily question selection
系统 SHALL 只从仍存在、答案非空且匹配设置的八股题中选题，到期“需复习”题优先，之后为其他到期题，再从其余候选随机补充；同一计划题目 MUST NOT 重复。题量不足 SHALL 使用实际候选数并解释差额，零候选 SHALL 显示空态且不能打卡。同日首次生成的计划 SHALL 在刷新和多个页面之间保持一致。

#### Scenario: Prefer weak due questions
- **WHEN** 匹配范围内有次日到期的薄弱题和其他候选，用户开始次日复习
- **THEN** 系统先纳入到期薄弱题，再按规则补足实际题量，计划内题 ID 唯一

#### Scenario: Insufficient or empty candidates
- **WHEN** 目标为 10 题但只有 3 道非空答案题，或完全没有有效题
- **THEN** 前者生成 3 题并以 3 为完成目标；后者不生成可完成的零题打卡

#### Scenario: Concurrent start
- **WHEN** 两个页面同时首次开始当天复习
- **THEN** 两个页面读取同一份已保存计划，不产生两套随机题目或覆盖已有学习进度

### Requirement: Recall reveal and self evaluation
每道未完成题 SHALL 先显示题目，允许用户默想或输入可选临时回答；揭晓之后 SHALL 展示当前保存答案并允许选择“记住了／需复习”。系统 MUST NOT 在揭晓前接受自评，也 MUST NOT 将临时回答持久化、导出、写日志或发送给模型。只有自评保存成功后 SHALL 更新进度并进入下一题。

#### Scenario: Recall without typing
- **WHEN** 用户直接默想、揭晓答案并选择需复习
- **THEN** 系统保存该题自评并进入下一题，无需填写回答，也不触发 AI 请求

#### Scenario: Temporary text and failed save
- **WHEN** 用户输入临时回答并揭晓，而自评写入失败
- **THEN** 当前页面保留答案、临时输入和可重试操作，不显示完成；刷新或离开当前题后临时回答消失，持久数据中没有该文本

### Requirement: Explainable spaced review schedule
系统 SHALL 根据成功保存的自评更新后续安排：“需复习”重置间隔并安排次日优先；连续“记住了”依次安排实际评分日之后的 1、3、7、14、30 天，到达末级继续使用 30 天。日期 SHALL 按本地日历加天计算，同日对同题重复提交 MUST NOT 重复增加间隔或计数。

#### Scenario: Remember and lapse
- **WHEN** 用户首次记住某题，之后连续记住一次，再标记需复习
- **THEN** 三次评分后分别安排评分日加 1、加 3、加 1 天，最后一次重置记忆阶段

#### Scenario: Retry or duplicate rating
- **WHEN** 保存成功后因响应丢失重试相同自评，或另一页面再次提交同题自评
- **THEN** 已保存的当天结果保持唯一，间隔、完成题数和打卡天数不重复增加，过期页面得到当前状态或明确冲突

### Requirement: Resume and local day rollover
系统 SHALL 自动保存计划及逐题成功自评，刷新、关闭重开和浏览器重启后恢复当天首个未完成题，答案重新隐藏。跨天 SHALL 留存旧计划未完成记录，为新日期按规则生成新计划；系统 MUST NOT 接受旧日期页面补写打卡或将旧日期自评误算到新一天。

#### Scenario: Resume within a day
- **WHEN** 用户完成 10 题中的 4 题后关闭并重新打开页面
- **THEN** 今日仍显示 4/10，从剩余题继续，已完成自评和计划顺序保持一致

#### Scenario: Midnight on an open page
- **WHEN** 页面跨过本地午夜，用户继续操作昨天未完成的题
- **THEN** 系统切换到今天并要求重新开始或继续今天的计划，昨天保留未完成状态且不补签

### Requirement: Question changes preserve meaningful history
系统 SHALL 保留历史中的当时题目标题及自评，原题删除后仍能查看并标注不可用。未评分题被删除或答案清空 SHALL 从当天有效目标排除并说明原因；全部失效且没有已评分题 MUST NOT 生成打卡。评分前题答更新 SHALL 要求用户重新查看并揭晓新内容，禁止直接提交旧内容的自评。

#### Scenario: Delete a planned question
- **WHEN** 当天计划某未评分题被删除
- **THEN** 该题标为不可用，不因等待已不存在的题目而卡死；其余有效题仍可完成，历史不伪造该题自评

#### Scenario: Edit while another page studies
- **WHEN** 另一个页面修改当前题的答案，学习页随后尝试提交自评
- **THEN** 学习页提示内容变化并刷新题答，重新揭晓后才允许评分；以前已完成记录不被改写

### Requirement: Automatic check in and history calendar
系统 SHALL 在当天有效目标大于零且所有有效题均成功自评后自动打卡，“需复习” SHALL 计为完成学习。系统 SHALL 记录日期、题目、自评与完成状态，提供可切月日历及日期详情；未完成日期 SHALL 展示进度而非已打卡。连续天数 SHALL 基于相邻本地日期，今天未打卡时以昨天为终点计算；重复提交、零题与未完成日期 MUST NOT 增加连续天数。

#### Scenario: Complete including weak answers
- **WHEN** 用户完成实际计划的全部题，其中部分标记需复习
- **THEN** 今天自动打卡且日历点亮，详情显示每题自评，后续间隔仍遵循各题结果

#### Scenario: Streak across today and a gap
- **WHEN** 昨天已有连续记录而今天尚未完成，或昨天没有完成且今天完成
- **THEN** 前者保留截至昨天的连续天数，后者新的连续天数为 1；历史未完成日不能冒充连续打卡

### Requirement: Local consistency and portable learning records
学习设置、间隔进度、计划和历史 SHALL 在当前浏览器持久保存并纳入完整知识库 JSON 备份；新版 SHALL 兼容旧 v1 备份，恢复 v1 时明确学习记录将初始化为空。新版备份 SHALL 保持两库实体及其关系，Markdown 导出 SHALL 继续只导出知识正文。备份 MUST NOT 包含临时作答、原始附件、API Key 或模型配置。

#### Scenario: Backup and restore learning progress
- **WHEN** 用户导出新版完整备份并确认恢复
- **THEN** 两库和学习数据一起恢复，今日进度、历史和间隔保留，删除题的历史仍可阅读，临时回答不出现

#### Scenario: Restore an older backup
- **WHEN** 用户选择有效 v1 知识库备份
- **THEN** 预览明确将替换两库并清空当前学习记录，确认后以空学习状态恢复，取消则完全不变

#### Scenario: Concurrent change during restore
- **WHEN** 恢复预览后另一页面成功提交自评，用户随后确认旧预览
- **THEN** 恢复因版本冲突被拒绝，刚保存进度不被覆盖；格式无效、未知版本或存储失败也不产生部分恢复
