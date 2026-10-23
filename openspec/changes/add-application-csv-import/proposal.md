# Proposal

## Why

招聘进度只能导入 JSON 备份，用户整理的 CSV（包括插件自身导出的中文表头 CSV）无法回流。用户已有包含企业性质、已投递和未投递原因的表格，需要在导入前选择格式、核对字段并避免覆盖已有记录。

## What Changes

- 招聘进度“导入备份”调整为“导入”，提供 JSON 备份和 CSV 表格两种格式选择；设置页的记录导入入口复用同一流程。
- CSV 本地解析，自动匹配中文表头并允许人工调整，预览有效、无效和疑似重复行；明确确认前不写入。
- 保留企业性质、自定义状态（含未投递）、备注和空投递日期；支持公司有值而岗位为空的集团级记录。
- CSV 疑似重复默认跳过，可明确选择作为新记录导入；不覆盖旧记录。JSON 保留原有按 ID／公司岗位合并语义，明确提示更新数量。
- 提供逐行错误与结果统计、取消、可再次导入；覆盖全屏和原生侧栏。

## Capabilities

### New Capabilities

- `application-record-import`: 招聘记录格式选择、CSV 解析与映射、预览、重复处理、确认提交，以及既有 JSON 导入兼容性。

### Modified Capabilities

无。当前主规格目录没有已发布能力。

## Impact

- `src/dashboard/dashboard.html`、`dashboard.js` 及样式；`src/options/options.html`、`options.js` 的记录导入入口。
- 新增共享导入解析／规划模块和共享导入界面；`src/lib/store.js`、`src/background.js` 增加经后台重新验证的 CSV 提交路径，保留 JSON 路由。
- 新增解析、数据合并和浏览器流程验证，更新 README。无云端、AI 请求或新增权限；不支持 Excel 工作簿，不导入知识库，不改写用户 CSV 文件。
