# Spec Delta

## Purpose

让用户在招聘进度和设置页选择导入 JSON 备份或 CSV 表格，在本地完成格式解析、字段匹配、数据预览和重复核对，并在明确确认后保存，完整保留企业性质、未投递状态及原因，避免误更新现有记录或伪造投递日期。

## ADDED Requirements

### Requirement: Explicit format selection
系统 SHALL 在招聘进度和设置的记录导入入口提供 JSON 备份与 CSV 表格两种选择，在全屏和侧栏中均可操作；选择错误格式或无效文件 SHALL 显示可恢复的错误，不修改数据。

#### Scenario: Select CSV
- **WHEN** 用户选择 CSV 表格导入
- **THEN** 文件选择器接受 CSV，进入 CSV 核对流程，不再按 JSON 解析

#### Scenario: Retry after wrong format
- **WHEN** 用户选择的文件无法按指定格式解析
- **THEN** 显示错误并允许重新选格式或文件，包括再次选择同一个文件

### Requirement: Local CSV parsing
系统 SHALL 本地解析 UTF-8（含 BOM）的逗号分隔 CSV，支持 CRLF／LF、引号内逗号和换行、双引号转义、空字段及尾部空行。系统 SHALL 提供 UTF-8／GB18030 编码选择，默认 UTF-8，解码失败时提示切换。文件超过 10 MiB 或 10000 条非空数据记录、列数不一致或引号未闭合时 SHALL 拒绝并给出位置或限制说明；空表 SHALL 不允许提交。

#### Scenario: Quoted content
- **WHEN** CSV 的备注包含带引号的逗号、换行和转义双引号
- **THEN** 将其作为同一个字段读取，保留原内容，不错分记录

#### Scenario: File limit or malformed content
- **WHEN** 文件超限、仅有表头或结构不合法
- **THEN** 在写入前报告错误，不部分导入

### Requirement: Field mapping and validation
系统 SHALL 自动匹配插件导出 CSV 的全部业务表头并允许人工映射或忽略列，阻止多个源列映射至同一目标字段。公司列为必需映射，逐行公司为空的记录无效；岗位允许为空。系统 SHALL 展示未匹配列和无效行的位置与原因。状态变更次数 SHALL 只提示为不可恢复的汇总信息，不据此伪造历史。

#### Scenario: Chinese export headers
- **WHEN** 用户导入插件导出的中文表头 CSV
- **THEN** 自动匹配公司、企业性质、岗位、状态、日期、技能、备注及其他业务字段，并提示状态变更次数不恢复为历史

#### Scenario: Company-only record
- **WHEN** 记录提供公司但没有岗位
- **THEN** 该记录可正常预览和导入

#### Scenario: Mapping conflict
- **WHEN** 两列被映射至同一目标或未映射公司
- **THEN** 禁止提交并说明应调整的映射

### Requirement: Preserve status and dates
系统 SHALL 保留 CSV 中非空状态，包括“未投递”和其他自定义状态，且不修改全局状态配置；空状态默认使用当前默认状态并在预览提示。空投递时间 SHALL 保持为空；空记录时间 SHALL 使用本次导入时间并提示。日期 SHALL 接受 YYYY-MM-DD、YYYY/MM/DD 及其带 HH:mm[:ss] 的形式，以浏览器本地时间解释且校验真实日历日期；非空非法日期 SHALL 标为无效行。企业性质 SHALL 使用现有归一化规则，未知值 SHALL 在预览中告知；备注 SHALL 保留。

#### Scenario: Unsubmitted enterprise
- **WHEN** 记录状态为未投递、投递时间为空、备注为访问报错
- **THEN** 保存未投递状态和访问报错备注，不填入投递日期

#### Scenario: Invalid calendar date
- **WHEN** 日期为 2026-02-30
- **THEN** 报告该行错误，不静默滚动为三月日期

### Requirement: Preview and duplicate decisions
系统 SHALL 在保存前展示字段映射结果、待新增、疑似重复和无效行数量，并允许查看每行内容及选择要导入的有效行。CSV 与库内或批内归一化公司加岗位一致时 SHALL 标为疑似重复并默认跳过，允许用户明确选择另存新记录；集团与不同名称的子公司 SHALL 不自动合并。CSV SHALL 不覆盖原有记录。确认前取消或关闭 SHALL 不写入。

#### Scenario: Existing CSV export reimport
- **WHEN** CSV 中有与已有记录同公司同岗位的行
- **THEN** 该行默认跳过，除非用户明确选择另存新记录，已有内容保持不变

#### Scenario: Batch duplicates
- **WHEN** 两条有效行公司和岗位相同
- **THEN** 首条按正常规则处理，后续条默认标记重复，明确另存选择后才新增

#### Scenario: Cancel preview
- **WHEN** 用户在核对阶段取消
- **THEN** 所有存储内容保持原样

### Requirement: Commit consistency and results
系统 SHALL 在确认时以最新存储重新检查 CSV 重复关系；预览后新增的重复 SHALL 返回重新核对，不能静默覆盖。选中的有效行 SHALL 一次提交；无效行需明确排除后才可提交。存储失败 SHALL 不报告成功，保留核对内容供重试；提交期间 SHALL 防止重复点击。成功后 SHALL 显示新增、更新、重复跳过、主动排除及无效行数量，并刷新列表。

#### Scenario: Concurrent new duplicate
- **WHEN** 核对期间另一页面新增了与候选相同公司岗位的记录
- **THEN** 确认时返回更新后的重复提示，要求重新核对后提交

#### Scenario: Failed write
- **WHEN** 存储写入失败
- **THEN** 显示失败且保留核对内容，不展示成功或重复提交

### Requirement: JSON compatibility
系统 SHALL 继续接受记录数组和包含 records 数组的 JSON 备份，保留原有按 ID 更新、按公司岗位去重的合并语义；提交前 SHALL 预览新增、更新、跳过数量并明确提醒同 ID 会更新。JSON 备份中的截图、状态历史及其他原有记录字段 SHALL 不因 CSV 字段白名单而丢失；不会恢复备份中的全局设置。

#### Scenario: Existing backup
- **WHEN** 用户确认导入带同 ID 记录及状态历史的合法旧 JSON 备份
- **THEN** 按原有合并规则更新记录并保留备份历史，其他无关记录不受影响

### Requirement: Private and responsive review
系统 SHALL 不上传导入文件、不调用 AI，不持久化原始文件及未确认候选；全屏和侧栏 SHALL 提供可滚动、可键盘操作的核对界面。在核对未完成时切换显示模式 SHALL 复用现有阻止切换提示，避免丢失候选。

#### Scenario: Pending import mode switch
- **WHEN** 用户正在核对尚未提交的文件并切换全屏或侧栏
- **THEN** 提示先完成或取消导入，候选内容保持可用
