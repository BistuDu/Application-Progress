# Spec Delta

## Purpose

控制灵动岛在普通网页上的自动出现、按网站隐藏和恢复，并以一个本地位置供所有网站复用。使用户拖动一次即可形成稳定使用习惯，同时在浏览器重启、跨页面更新及访问权限变化时保留明确行为。

## ADDED Requirements

### Requirement: Default display on accessible ordinary pages
获得浏览器所需网站访问权限后，灵动岛 SHALL 默认出现在所有普通 HTTP／HTTPS 顶层网页，包括与招聘无关的网页；不支持注入的浏览器页面、扩展页面和应用商店 SHALL 不显示，也不反复报错。

#### Scenario: Visit an unrelated ordinary website
- **WHEN** 用户在已授权环境打开普通学习网站
- **THEN** 无需先点扩展工具栏，网页即出现图标胶囊

#### Scenario: Restricted page
- **WHEN** 用户打开浏览器设置页或扩展应用商店
- **THEN** 页面不注入胶囊，扩展菜单仍可打开已有管理页面

### Requirement: Persistent per-website visibility
用户 SHALL 能关闭当前网站的灵动岛，设置按 hostname 保存，对该 hostname 的不同路径、HTTP／HTTPS 和端口生效；该网站关闭后 SHALL 在当前及其他已打开的同网站页面隐藏，并在再次访问和重启后继续隐藏。

#### Scenario: Disable one site
- **WHEN** 用户关闭 `example.com` 上的灵动岛后访问该网站另一条路径
- **THEN** 胶囊保持隐藏，而其他 hostname 的网站仍然显示

### Requirement: Restore a hidden site through extension controls
扩展菜单 SHALL 展示当前网站的显示状态，并允许重新开启；重新开启 SHALL 恢复现有页面的胶囊而无需依赖已经隐藏的网页入口，不支持的页面 SHALL 给出明确状态。

#### Scenario: Re-enable without a visible island
- **WHEN** 用户在已关闭的网站打开扩展菜单并开启灵动岛
- **THEN** 当前网站页面重新显示胶囊，并使用全站记忆位置

### Requirement: One persistent global position
拖动后的位置 SHALL 存在当前浏览器本地，并由所有网站共用，不创建按网站独立的位置；刷新、切换网站及浏览器重启后 SHALL 使用同一记忆位置。

#### Scenario: Move and switch sites
- **WHEN** 用户在网站 A 移动胶囊后打开网站 B
- **THEN** 两个网页采用同一记忆位置；同尺寸视口中的位置一致

### Requirement: Resize does not overwrite the preferred position
视口变化引起的边界调整 SHALL 只影响当前显示，不自动重写全站记忆位置；窗口恢复后 SHALL 能回到记忆位置。扩展菜单 SHALL 提供重置为默认右上角的位置操作。

#### Scenario: Shrink and restore the viewport
- **WHEN** 用户缩小窗口导致胶囊需要避让，随后恢复窗口大小
- **THEN** 胶囊先保持可见，再恢复记忆位置，其他页面的位置偏好未被覆盖

### Requirement: Visible persistence failures and safe preference updates
位置和网站开关的更新 SHALL 不影响 API 设置、岗位记录或知识库；写入失败 SHALL 显示未保存反馈，不宣称偏好已持久化；来自多个页面的不同偏好更新 SHALL 不互相丢失。

#### Scenario: Position and visibility updated concurrently
- **WHEN** 一个页面保存拖动位置，同时另一个页面关闭某网站
- **THEN** 两项更新均保留，关闭的网站不因位置更新重新开启

### Requirement: Permission-aware availability
网站访问权限尚未获准或被浏览器限制时，扩展 SHALL 明确说明胶囊不可自动显示的原因，并提供适用的浏览器操作指引；不得把未显示误报为该网站已被用户关闭。

#### Scenario: Browser access is unavailable
- **WHEN** 浏览器未允许扩展访问当前普通网站
- **THEN** 扩展菜单区分权限不足与网站关闭，原有可用入口继续显示
