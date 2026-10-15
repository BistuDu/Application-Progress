# Proposal

## Why

项目问答的长答案使新建入口远离当前阅读位置，题目与答案缺乏层级，也难以快速扫题。八股文题库已有问答、分类和标签，但缺少每日回想、自评、间隔复习与打卡记录，无法形成可持续的复习流程。

## What Changes

- 项目库与八股文题库增加右下角固定“＋新建问答”，复用现有人工新增、重复核对与单份答案流程。
- 两库题目使用更大字号与强调色；答案默认折叠，点击题目展开，提供全部展开／折叠，保留 Markdown、安全预览与编辑操作。
- 八股题库内增加“每日复习”：默认每日 10 题，可调整题量、分类与标签；到期薄弱题优先，其余随机补充，不重复凑数。
- 逐题看题、默想或填写临时回答、揭晓原答案、自评“记住了／需复习”。临时回答不持久化，也不调用 AI 评分。
- 薄弱题次日优先；记住的题按建议的 1、3、7、14、30 天间隔安排。当天自动保存进度，跨天留存未完成记录并生成新计划。
- 完成实际计划内全部有效题并自评后自动打卡；展示今日进度、连续天数、月历及日期下的题目和自评。
- 完整 JSON 备份纳入学习设置、进度、计划和历史，兼容现有 v1 备份；Markdown 继续导出知识正文，临时回答不进入任何导出。

## Capabilities

### New Capabilities

- `knowledge-question-reading`: 两库固定新增入口、题答视觉层级、默认折叠、批量展开及编辑状态保护。
- `daily-technical-review`: 八股每日计划、间隔安排、回想揭晓自评、进度持久化、打卡日历与版本化备份兼容。

### Modified Capabilities

无已发布主规格需要修改。`openspec list --specs` 当前为空；已有两库与可携带性契约仍位于已实现、未归档的 `add-interview-knowledge-libraries` 变更中。本提案在该实现之上增量添加能力，不重复声明其 CRUD／Markdown／AI 基础契约，不修改或归档前一变更。

## Impact

- 页面：`src/knowledge/knowledge.html`、`knowledge.js`、`knowledge.css`、`api.js`、`io.js`；拆出独立复习视图以控制主文件复杂度。
- 数据与通信：`src/lib/knowledge-store.js`、`knowledge-export.js`、`src/background.js`；增加纯复习逻辑模块，沿用 background 串行写入队列。
- 验证：扩展 `scripts/knowledge-selftest.mjs` 与 `knowledge-e2e.mjs`，覆盖本地日期、随机选题、并发、备份、长答案与实际交互；更新 README 和分发包。
- 不增加运行权限、外部服务或第三方依赖；岗位流程、胶囊、识别导入和项目 AI 参考保持兼容。知识容器与备份升级至 v2，新版读取 v1；旧版扩展不能读取 v2 备份，恢复预览须明确版本与替换范围。
