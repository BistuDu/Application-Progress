# 灵动岛实现与验收记录

日期：2026-10-15。使用本机 Chromium、正式 manifest 副本、隔离 profile 与本地模型 mock；没有读取用户浏览器数据或使用真实模型凭据。

## 规格对照

| 规格 | 实现 | 证据 |
| --- | --- | --- |
| floating-island-preferences | 独立 schemaVersion 1 容器；默认读取不写；精确 hostname、IPv6、子域独立；串行更新；失败不报成功；只返回偏好和支持状态 | island-selftest 偏好／实际 background 路由断言；浏览器双 hostname、同站多标签、刷新／重启、弹窗与设置恢复 |
| floating-island-ui | 76×38 黑色纯图标胶囊；304px 四入口；自由拖动与全局比例位置；边缘向内展开；窄窗口单列与内部滚动；键盘与 reduced-motion | 真实指针拖动、阈值、pointercancel／blur、拖动期间远端更新、窄窗口锚点；浅／深／复杂页各状态、四角边缘及形变帧 |
| floating-island-capture | 正式 all_urls；绑定发起 tab/window/document；完整宿主隐藏与帧确认；finally 释放；截图 3 秒上限与隐藏 6 秒租约；本页耗时／取消和原界面回退 | 图像像素检查、截图与注入失败、切标签、导航、丢结果、停止 worker、扩展上下文失效、取消后迟到 JD／题目结果 |

## 执行命令

```sh
node scripts/island-selftest.mjs
node scripts/island-e2e.mjs
node scripts/knowledge-selftest.mjs
JDT_API_KEY='' node scripts/selftest.mjs
JDT_API_KEY='' node scripts/knowledge-e2e.mjs
node scripts/e2e-cdp.mjs --mock
openspec validate add-draggable-dynamic-island --strict
```

最终结果与分发文件比对在本文件末尾记录。浏览器截图、result.json 和本轮日志位于仓库 `tmp/island-qa/`，不进入分发包。

## 实际视觉检查

已逐张查看收起、展开、processing、保存终态、截图避让和过渡帧；补充浅色、深色、复杂页面及窄窗口单列截图。胶囊不改变网页布局；图标在形变时留在锚点侧；菜单文字完整，窄窗口可以显示四入口，外部原生按钮 CSS 不进入 Shadow DOM。状态表面显示真实耗时，无虚构百分比。截图中的对应区域没有胶囊、菜单、tooltip 或黑色阴影。

| 状态 | 图片文件（tmp/island-qa） |
| --- | --- |
| 收起 | light-collapsed.png、dark-collapsed.png、dense-collapsed.png |
| 展开 | light-expanded.png、dark-expanded.png、dense-expanded.png |
| 识别中 | processing.png、dark-processing.png、dense-processing.png |
| 实际保存后 | saved.png、dark-saved.png、dense-saved.png |
| 边缘与窄窗口 | right-expanded.png、bottom-left.png、bottom-right.png、narrow-expanded.png、narrow-single-column.png |
| 动效与可访问性 | transition-early.png、transition-mid.png、transition-final.png、reduced-motion.png、tooltip.png |
| 取消与异常 | cancelled.png、disabled-processing.png、missing-key.png |
| 实际截图 | captured-without-island.jpg；其他入口另做同坐标像素断言 |

修订过的细节：默认面板高度不足导致亮色滚动条；SPA 重新挂载后的键盘监听；展开时图标使用目标 left 导致短暂消失；窄视口展开后拖动从记忆点起算造成跳动；保存终态被旧核对面板遮住。现使用足够高度／深色滚动条、每次挂载监听、固定锚点侧、真实按钮矩形作为拖动起点，并在核对界面关闭后显示保存终态。

## 验证范围与限制

- 原生右键／快捷键的注册回调用实际 background 路由离线验证；浏览器逐条检查它们共用的截图函数路径和捕获像素。无头测试未操作浏览器原生右键菜单。
- 网站样例为本地浅色、深色、全局按钮样式复杂页，不能代表所有第三方网站。Chrome 应用商店由正式 content_scripts exclude_matches 和采集 URL 校验排除；浏览器实际检查普通页、iframe、扩展页和 about 页。
- 本轮验证业务流程与错误恢复，未重新评估真实模型答案质量。API Key 使用明确的 mock 字符串，所有模型请求只发往本地测试服务。
- Chrome 限制截图频率，测试按间隔执行；快速重复截图被浏览器拒绝时会显示可重试错误。页面被冻结时计时和看门狗在页面恢复运行后继续执行。
- 更新后无效的扩展上下文在交互／宿主检测时清理；如果浏览器禁止重新注入，刷新网页恢复。已持久位置和网站偏好保留。


## 最终结果

- 胶囊离线：**67/67**，包含真实 background 偏好路由、原生菜单／快捷键注册回调、字段并发与错误输出。
- 胶囊隔离浏览器：**70/70**，正式 manifest，无测试补权；网页入口未先点击扩展工具栏。
- 知识库离线：**155/155**；知识库无 Key 浏览器：**95/95**。
- 岗位离线：**38/38**；岗位本地 mock 浏览器：**81/81**。
- 12 个改动相关 JavaScript 文件语法通过；`git diff --check` 通过；OpenSpec 严格校验通过。
- 分发包 `dist/job-tracker-extension-1.0.0.zip`：**236 个文件，2319413 字节**，manifest／README／src／icons 全量逐字节比对一致，CRC 完整。没有 scripts、tmp、openspec、.agents、.zcode 或 .git；API Key 默认仍为空。
- SHA-256：`0737f4dd607ed6fe69855bb427ff981da6efa4fa0e49af88539fe1f39d06b57c`。

全部 25 项任务完成。未执行 Git 提交或 OpenSpec 归档。
