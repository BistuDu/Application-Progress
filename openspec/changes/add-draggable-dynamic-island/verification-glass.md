# macOS 磨砂胶囊修订验收

日期：2026-10-15。用户确认交互预览后，将视觉接入正式扩展。采用已有变更的第 8 节修订任务，初版记录保留在 `verification.md`。

## 实现与确认参数

- 收起为 56×36 纯图标胶囊；展开为 212×44 的四功能图标与末尾更多按钮。悬停／聚焦显示名称，更多菜单提供重置位置与当前网站关闭。
- 跟随系统浅深色，24px 模糊、78% 背景不透明度，280ms 锚点形变；本地单色 SVG、细边框、内高光与轻阴影。不支持背景滤镜时使用实色回退，减弱动态效果时停用过渡。
- 粗指针在足够宽度下使用 44×44 点击目标；240px／320px 视口保持横排并避让边缘。菜单按剩余空间在上下方展开。
- 复用既有偏好、截图、取消和任务桥接；没有迁移全局位置，没有新增权限、模型调用或远程图标资源。网页胶囊不读取 API Key 或业务记录。

主要文件：`src/content/island.js`、`src/lib/island-core.js`、`scripts/island-selftest.mjs`、`scripts/island-e2e.mjs`。

## 本轮验证

| 命令 | 结果 | 实际范围 |
| --- | --- | --- |
| `node scripts/island-selftest.mjs` | 80/80 | 几何、菜单避让、偏好并发／错误、真实 background 路由、原生菜单和快捷键注册回调 |
| `node scripts/island-e2e.mjs` | 87/87 | 正式 manifest、隔离 Chromium profile、本地模型 mock；系统主题动态切换、四入口、拖动、菜单键盘、网站开关、截图、取消及故障恢复 |
| `node scripts/knowledge-selftest.mjs` | 155/155 | 知识库数据、导入、导出、AI 提示及取消保护 |
| `node scripts/e2e-cdp.mjs --mock` | 81/81 | 岗位框选／核对／保存／编辑等原业务回归 |
| `JDT_API_KEY='' node scripts/selftest.mjs` | 38/38 | 岗位离线回归，真实模型测试明确跳过 |

日志与胶囊结果位于 `tmp/island-glass-qa/`，不进入分发包。前轮知识库无 Key 浏览器 95/95 保留在原验收记录；本次没有重跑该套浏览器测试，也没有重新评估真实模型质量。

本轮修复的实际浏览器问题：指针捕获影响原生 click 目标；菜单 focusout 竞争导致点击前关闭；滚动条使固定 right/bottom 与 innerWidth 坐标相差 15px；粗指针媒体查询改变后几何未更新。修复后整套 87 项用例通过。

## 实际视觉检查

已查看正式扩展的原始截图及五张联系表，核对尺寸、图标、留白、阴影、浅深色、边缘和展开帧。浅色背景采用轻浮层，深色保持可辨图标；菜单与状态没有文字溢出，240px 仍可显示全部五个按钮，底部菜单向上避让。形变保持同侧锚点，识别与成功反馈复用同一磨砂表面，减弱动态效果仍可操作。

| 样例 | `tmp/island-glass-qa/` 图片 |
| --- | --- |
| 收起与横条 | light／dark／dense 的 collapsed、expanded |
| 更多菜单 | light-more、dark-more、bottom-left-more、bottom-right-more |
| 识别与保存 | processing、saved，及 dark／dense 对应图片 |
| 布局与输入 | right-expanded、narrow-expanded、narrow-compact-row、coarse-pointer、tooltip、reduced-motion |
| 过渡与异常 | transition-early／mid／final、cancelled、missing-key、disabled-processing |
| 截图 | captured-without-island.jpg；各共享截图路径另执行三点有色背景像素断言 |

截图审计在胶囊下放置 RGB(23,92,156) 测试色块，并在更多菜单打开时从实际 captureVisibleTab 返回图像读取三个像素，容差 12；这样能够发现浅色胶囊、菜单或阴影混入。隐藏失败、截图失败、释放消息丢失租约恢复、取消迟到结果、导航、标签切换、worker 中断和上下文失效均有输出断言。

## 范围与限制

测试只使用本地样例网页与 mock 模型，没有读取用户浏览器 profile。网页本身的配色与系统主题独立，胶囊按系统媒体查询选择主题；半透明效果会受底层页面内容和浏览器渲染影响。样例不能代表全部第三方网站。

原生右键／快捷键注册由离线实际路由验证；浏览器检查共用截图路径，没有操纵浏览器原生右键菜单。受保护页面仍按正式 manifest 排除；页面被浏览器冻结时，计时与看门狗在恢复运行后继续。缺 Key 的完整提示保留在辅助信息中，胶囊内长文本以省略号展示。

未执行 Git 提交或 OpenSpec 归档。

## 最终分发核对

- 分发包：`dist/job-tracker-extension-1.0.0.zip`，236 个文件，2321520 字节。
- manifest／README／src／icons 全量逐字节一致，CRC 完整；无 scripts、tmp、openspec、.agents、.zcode、.git，API Key 默认空。
- SHA-256：`a8555cc5a6eb1c5391a57cd2d43009c24a5c235154d1fb6f83130130d215cfa2`。
- 四个本轮修改的 JavaScript 文件语法检查与 `git diff --check` 通过。包审计详见 `tmp/island-glass-qa/package-audit.json`。
- `openspec validate add-draggable-dynamic-island --strict` 通过；六项视觉修订任务完成，变更合计 31/31。
