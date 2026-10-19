# 双 AI 对话实验室 v0.9.9 测试报告

日期：2026-10-19

## 自动测试结果

| 检查项 | 结果 | 说明 |
|---|---|---|
| `node --check install/content.js` | 通过 | 内容脚本语法 |
| `node --check install/sidepanel.js` | 通过 | 侧栏脚本语法 |
| `node --check install/background.js` | 通过 | 后台脚本语法 |
| `node --check install/materials.js` | 通过 | 原始文件模块语法 |
| `node test_v094.js` | 通过 | 继承状态、发送安全与回归检查 |
| `node test_v095.js` | 通过 | 完成门槛回归 |
| `node test_v096.js` | 通过 | 识别器回归 |
| `node test_v097.js` | 通过 | 分阶段诊断与超时回归 |
| `node test_v098.js` | 通过 | 文件名时间戳别名与基线差分 |
| `node test_v099.js` | 通过 | 局部附件证据路径与文件名别名 |
| ZIP 完整性 | 通过 | 安装包、源码包均通过 `unzip -t` |

## 修复范围

v0.9.8 在真实任务中仍出现 `匹配 2/3；缺失 A题.pdf`。本版新增输入框附近可见 DOM 证据扫描：如果附件卡片在输入区周围可见，即使全页 `innerText` 计数没有增加，也可作为本轮附件证据。诊断会附带 `localEvidenceByName`，记录命中的元素描述和位置，方便进一步核查。

文件名匹配仍允许受限形式，例如 `A题.pdf` 与 `A题（20261019 044718）.pdf`。不同主文件名不会匹配。仍检查网页显示的上传忙碌状态和错误状态。

## 未验证范围

**没有在真实登录态 ChatGPT / DeepSeek 网页执行端到端测试。** 本报告只证明语法、源码级测试和打包完整性通过，不能保证 ChatGPT 页面当前 DOM 一定会被局部扫描命中。若仍失败，新版诊断中的 `localEvidenceByName`、`counts`、`baselineCounts` 可用于继续定位。
