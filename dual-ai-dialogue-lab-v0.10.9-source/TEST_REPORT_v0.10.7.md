# TEST_REPORT v0.10.7

生成方式：本机 Node.js 静态/行为测试。**未在任何已登录的 ChatGPT/DeepSeek 网页上做真机验证**（本环境无浏览器登录态），下文逐项区分「已测」与「未测」。

## 一、测试环境

| 项 | 值 |
|---|---|
| 运行环境 | Windows + Node.js（`node --check` / `node test_*.js`） |
| 被测源码 | `dual-ai-dialogue-lab-v0.10.6-source.zip` 解压后修改而来的 v0.10.7 |
| 浏览器 | 未启动 |
| 真机网页 | 未访问（无登录态） |

## 二、静态检查

| 检查 | 结果 |
|---|---|
| `node --check install/content.js` | 通过 |
| `node --check install/sidepanel.js` | 通过 |
| `node --check install/background.js` | 通过（未修改，基线检查） |
| `install/manifest.json` JSON 解析 | 通过 |
| `manifest.version` | `0.10.7` |
| 权限 / host_permissions 未变更 | 确认 |

## 三、回归测试（`node test_*.js`）

12 个脚本全部通过：

```
PASS  test_v094.js      （任务完成状态解析、诊断字段、UI 绑定）
PASS  test_v095.js      （提交证据双锚点）
PASS  test_v096.js      （回答提取通道）
PASS  test_v097.js      （污染回答拒绝）
PASS  test_v098.js      （会话隔离）
PASS  test_v099.js      （附件局部证据：作用域断言已更新为 scopeBox）
PASS  test_v0102.js     （附件核验基线）
PASS  test_v0103.js     （即时证据与等待策略）
PASS  test_v0104.js     （evidenceHistory 与无证据宽限）
PASS  test_v0105.js     （超时文案与人工确认回退）
PASS  test_v0106.js     （诊断字段；7000 字符截断断言已反转为必须不存在）
PASS  test_v0107.js     （本版新增，见下）
```

说明：`test_v094/v099/v0104/v0105/v0106` 中原有若干断言依赖 v0.10.6 的实现字面量（如 `composerRect.top - 760`、`const diagnosticNodes = []`、`JSON.stringify(...).slice(0, 7000)`）。这些断言已更新为**等价的 v0.10.7 断言**，测试意图（作用域必须覆盖输入区附近、诊断必须保留关键字段、失败必须可分类）保持不变；所有版本断言由「必须等于」改为「不低于」。

## 四、v0.10.7 新增测试（`test_v0107.js`）

### 4.1 静态断言

- 不再存在固定 `composerRect.top - 760` / `composerRect.bottom + 180` 的局部范围；
- 存在 `scopeBox` 祖先包围盒与 `degraded` 退化分支、统一的 `inScope(r, pad=320)`；
- 存在附件卡片语义正则、移除控件语义、`attachmentCards` / `cardNameMatches` / `cardPresentNoName` 输出；
- 8 个失败分类全部存在：`page-upload-error`、`upload-still-busy`、`attachments-vanished-after-upload`、`initial-evidence-disappeared`、`card-present-name-unreadable`、`card-present-unmatched`、`filename-not-detected`、`no-evidence-after-transfer`；
- 诊断按 `diagnosticBuckets` 优先级排序，文件名匹配节点最先输出；
- `sidepanel.js` 不再使用 `JSON.stringify(evidenceDiagnostics).slice(0, 7000)`，改为 `boundedEvidenceJson(evidenceDiagnostics)`；
- `recordDiagnostic` 的详情上限已放宽（1500→12000、4600→14000）。

### 4.2 行为断言（抽取生产代码执行，不是复制实现）

从 `install/content.js` 抽取 `norm` / `escapeRegex` / `filenamePattern` / `containsFilename` / `stemOf` / `containsStem`，在 `vm` 中执行：

| 用例 | 期望 | 结果 |
|---|---|---|
| `A题.pdf`、`附件1.xlsx`、`附件2.xlsx` 自匹配 | true | 通过 |
| `A题（20261019 044718）.pdf`（全角括号 + 时间戳） | true | 通过 |
| `A题.pdf (4)`（重复后缀） | true | 通过 |
| `文件：附件1.xlsx 540.4 KB`（行内） | true | 通过 |
| `B题.pdf` vs 目标 `A题.pdf` | false | 通过 |
| `附件1.xlsxa` vs 目标 `附件1.xlsx` | false | 通过 |
| 卡片截断名 `A题.pd` 通过词干匹配 | true | 通过 |
| `A题库` 词干匹配 `A题.pdf` | false（必须不误命中） | 通过 |

从 `install/sidepanel.js` 抽取 `boundedEvidenceJson`，喂入「2 KB 的中文 failureDetail + 12 张卡片 + 40 条诊断节点 + 40 条核验历史」的超长证据：

| 断言 | 结果 |
|---|---|
| 输出长度 ≤ 11000 | 通过 |
| 输出是合法 JSON（`JSON.parse` 成功） | 通过（**该断言在此前版本失败过，暴露了「截断字符串导致 JSON 非法」的真实缺陷，已修复为按条目裁剪**） |
| 含 `failureClass=card-present-name-unreadable` | 通过 |
| 含缺失文件名 `附件1.xlsx` | 通过 |
| 含 `verificationHistory`（最近 10 条） | 通过 |

## 五、验收标准逐条对照

| # | 验收项 | 状态 | 依据 |
|---|---|---|---|
| 1 | 单个 PDF 成功上传能被识别 | **未真机验证** | 逻辑上由 4 条独立通道任一命中即 `matched`：整页文本增量、输入区局部文本、原生 FileList、附件卡片名称匹配 |
| 2 | 多文件分别识别，不能只凭一张卡片通过 | **未真机验证** | `matched` 按 `names` 逐项计算，`cardNameMatches[name]` 按名匹配；不存在「一张卡片满足全部」的路径 |
| 3 | FileList 为空但卡片存在时不得直接报失败 | **未真机验证** | 新增卡片通道；FileList 为空不再单独构成失败依据，失败分类会落到 `card-present-name-unreadable` / `card-present-unmatched` |
| 4 | 网页明确失败时给出对应错误类别 | **未真机验证** | `page-upload-error`，触发条件为输入区范围内匹配上传失败/格式不支持文案 |
| 5 | 上传中与失败区分 | **未真机验证** | `busy`（上传中/进度条/aria-busy）与 `error` 分别采集，分类 `upload-still-busy` |
| 6 | 文件名不匹配且无法确认时报告「无法确认」 | **未真机验证** | `card-present-unmatched`（卡片名称不一致）/ `card-present-name-unreadable`（卡片存在但读不出名字），两者都不会自动判定成功 |
| 7 | 漏检时诊断可追溯 | **部分验证** | 诊断节点按优先级（文件名 > 卡片 > 状态 > 其他）采样并附 `matchReason`；有界 JSON 保证结论字段不被丢弃（已用行为测试验证） |
| 8 | 超长诊断不得丢失最终判定 | **已验证** | §4.2 的 `boundedEvidenceJson` 行为测试 |
| 9 | ChatGPT 与 DeepSeek 分别检查 | **未真机验证** | 代码中两家站点共用同一套逻辑，但等待预算与 `noEvidenceGrace` 保留站点差异（45s/35s、15s/12s）；本版未针对 DeepSeek 单独调整识别规则 |
| 10 | 原有功能不无故丢失 | **已验证（静态）** | 12 个历史回归测试全部通过；`background.js`、`materials.js`、接力与回答提取逻辑未修改 |

结论：**代码层面已按验收标准实现，但第 1/2/3/4/5/6/9 条需要真实网页复测才能确认**。不做真机验证就无法声称这些用例通过。

## 六、用户复测步骤

### 准备
1. 解压 `dual-ai-dialogue-lab-v0.10.7.zip`，在 `chrome://extensions`（或 `edge://extensions`）删除旧版，加载新目录。
2. **刷新 ChatGPT 与 DeepSeek 两个网页**（内容脚本不会热更新）。
3. 打开扩展侧栏，确认「自动诊断」可用。

### ChatGPT 复测（重点）
1. 勾选「每次新任务新建对话」与附件投递，选择 `A题.pdf`（540 KB）。
2. 开始一个两轮短任务，观察侧栏「附件投递进度」的时间线。
3. 期望：出现 `阶段=verify-confirmed；匹配 1/1`，随后正常进入第 1 轮发送。
4. 若失败，复制诊断中第一条 `阶段=verify-unconfirmed` 的详情，重点看：
   - `failureClass`
   - `failureDetail` 里的「卡片数=…；缺失=…；卡片存在但名称不可读=…」
   - `attachmentCards`（卡片文本/属性/坐标）
   - `scopeBox`（是否 `degraded:true`）
   - `diagnosticNodes` 前几条的 `matchReason`

### DeepSeek 复测
同样步骤，使用 `附件1.xlsx` + `附件2.xlsx` 两个文件，确认「匹配 2/2」。DeepSeek 的卡片结构与本版新增的卡片识别是否吻合，本次无法预判，需实测。

### 需要收集的日志
- 失败时：`阶段=verify-unconfirmed` 的完整详情（现在上限 12000 字符，不会只剩开头）。
- 若仍卡在人工确认：确认是否已勾选侧栏的「人工目视确认」并点击，以及该条记录是否写入诊断。

## 七、本次未做的测试（明确声明）

- 未在任何真实登录页面执行附件上传。
- 未验证 ChatGPT 与 DeepSeek 当前的附件卡片 DOM 是否能被本版新增的语义/几何规则命中。
- 未做性能测量；`composerAttachmentEvidence` 仍是全页 composed DOM 遍历，长对话下每 650ms 一次有一定开销。
- 未测试关闭的 Shadow DOM、跨域 iframe 中的卡片（设计上仍观察不到）。
