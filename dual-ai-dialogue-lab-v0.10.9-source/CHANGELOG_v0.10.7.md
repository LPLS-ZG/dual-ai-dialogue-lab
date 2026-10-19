# CHANGELOG v0.10.7

基线：v0.10.6（源码包 `dual-ai-dialogue-lab-v0.10.6-source.zip`）
本版目标：修复「附件卡片明明还在输入区，扩展却判定 0/N 并中止发送」。

## 一、根因分析

v0.10.6 的验证器只有一个作用域：**以输入框 `getBoundingClientRect()` 为基准、向上 760px / 向下 180px 的矩形**。这个矩形在两种常见情况下会退化为空集：

1. 输入框滚出视口时，`composerRect.bottom` 可能是负数，`yBottom = bottom + 180` 小于 `yTop = 0`，范围变成空集；
2. 页面尚未完成布局（后台标签恢复、SPA 首次渲染）时，`rect` 全为 0，范围同样退化。

一旦退化，所有「局部证据」与「诊断节点」都会被跳过 —— 这精确对应了 v0.10.6 日志里的现象：

- `initialEvidence` 阶段曾匹配 1/1（当时布局正常）；
- 之后 `evidenceByName`、`localEvidenceByName`、`diagnosticNodes` 全部为空；
- 最终 `failureClass=initial-evidence-disappeared`、匹配 0/1。

此外，验证器只有「文件名文本」一条识别通道：卡片把名字截断、名字放在读不到的属性里、或文本节点被拆开时，即使卡片确实存在也会被判为 0/N。

## 二、修改内容

### install/content.js

| 位置 | 修改 | 理由 |
|---|---|---|
| `composerAttachmentEvidence()` | 重写 | 见下 |
| 作用域 | 新增 `scopeBox`：沿 composer 向上最多 6 层祖先取包围盒并集；若并集高度 < 80px 则标记 `degraded` | 替代固定 760/180 偏移，避免滚出视口/未布局时范围退化为空 |
| `inScope(r, pad=320)` | 新增统一判定 | 所有局部证据与诊断节点共用同一范围，退化时退回「全页但只收附件语义节点」 |
| 附件卡片通道 | 新增 `FILE_SEMANTIC` / `REMOVE_SEMANTIC` 语义、尺寸上界（≤760×240）、移除控件检测、最近内层去重 | 只靠文件名文本时，卡片存在也识别不到 |
| 卡片名称匹配 | 新增 `stemOf` / `containsStem`（词干 + 边界 + 必须紧跟扩展名/空白/结尾） | 卡片常把 `A题.pdf` 截断成 `A题.pd…`；同时避免 `A题库` 误命中 `A题.pdf` |
| `cardNameMatches` | 卡片级文件名匹配结果并入 `matched` 判据 | 与整页文本计数、局部证据、原生 FileList 并列，成为第 4 条独立通道 |
| `cardPresentNoName` | 新增：卡片存在但读不出该文件名 | 把「检测器漏检」与「附件真的不在」分开 |
| 诊断采样 | `diagnosticBuckets`：文件名匹配 → 附件卡片 → 上传状态 → 其他，每类 ≤14，总数 ≤40，输出按优先级排序 | 旧实现按 DOM 顺序取前 36 个，侧边栏与历史会话文字会挤占名额 |
| 返回值 | 新增 `attachmentCards`、`cardCount`、`cardNameMatches`、`cardPresentNoName`、`scopeBox` | 供侧栏与诊断使用 |
| `waitForComposerAttachmentEvidence()` | 失败分类细化 | 旧实现只有 `initial-evidence-disappeared`，无法定位环节 |
| `summarize()` | 核验历史增加 `cardCount` / `attachmentCards` / `cardPresentNoName` / `scopeBox`，诊断节点上限 12→14 | 让每次采样都能解释「为什么没识别到」 |

新增失败分类与判定依据：

| 分类 | 判定依据 |
|---|---|
| `page-upload-error` | 输入区范围内出现明确的失败/格式不支持提示 |
| `upload-still-busy` | 输入区范围内仍有上传中/进度条/加载指示 |
| `attachments-vanished-after-upload` | 即时证据曾出现，最终既无匹配也无任何卡片 |
| `initial-evidence-disappeared` | 即时证据曾出现，最终无匹配但仍有卡片 |
| `card-present-name-unreadable` | 卡片数 ≥ 缺失文件数，且每个缺失项都有卡片但名称读不出 |
| `card-present-unmatched` | 有卡片，但卡片上的名称与目标文件不一致 |
| `filename-not-detected` | 没有卡片，也没有文件名证据（`no-evidence-after-transfer` 为提前退出变体） |
| `stability-timeout` | 已匹配但未能在稳定观察期内确认 |

**没有新增任何「无条件放行」路径**：`confirmed` 仍然只由「全部文件都有独立证据 + 无 busy + 无 error」决定。

### install/sidepanel.js

| 位置 | 修改 | 理由 |
|---|---|---|
| `boundedEvidenceJson(evidence, maxTotal=11000)` | 新增 | 替代 `JSON.stringify(...).slice(0,7000)`。结论字段（`failureClass`/`failureDetail`/`matched`/`missing`/`cardCount`/`cardPresentNoName`/`scopeBox`）优先且永不丢弃；明细按剩余预算依次追加；核验历史从最新往回取，保证最后一次采样一定在报告里 |
| `evidenceDiagnostics` 构造 | 增加 `failureClass`/`failureDetail`/`attachmentCards`/`cardCount`/`cardPresentNoName`/`scopeBox`/`matched`/`missing` | 让诊断能解释「漏检还是真失败」 |
| `recordDiagnostic()` | 单条详情上限 1500→12000，合并上限 4600→14000 | 原来即使证据 JSON 完整，也会被这层二次截断，只留下开头 1500 字符 |

### install/manifest.json

- `version` 0.10.6 → 0.10.7
- `description` 更新为本版修复说明

### 测试

- 新增 `test_v0107.js`：静态断言（作用域退化、卡片通道、失败分类、诊断不截断）+ **行为断言**（从 content.js 抽取真实的 `norm`/`filenamePattern`/`containsStem` 执行，验证中文文件名、时间戳别名、重复后缀、词干截断、以及 `A题库` 不得误命中 `A题.pdf`）
- `test_v094/test_v099/test_v0104/test_v0105/test_v0106` 中依赖旧实现字面量的断言更新为等价的 v0.10.7 断言（测试意图不变）
- 所有 `test_v*.js` 的版本断言由「必须等于」改为「不低于」，避免升级即失效

## 三、未改动

- 原始文件内存传输（`commitRawFileTransfer`）与校验和逻辑
- 文件控件探测（`DUO_CDP_PROBE_FILES`）与候选打分
- 人工确认回退（`pauseForManualAttachment`）与「人工目视确认」记录
- 对话接力、回答提取、诊断的其余部分
- 任何「跳过验证直接发送」的捷径（未新增）

## 四、已知限制

1. 若附件卡片位于**关闭的 Shadow DOM**、跨域 iframe 或不可见虚拟节点中，页面脚本仍观察不到 —— 这种情况只能依赖人工目视确认。
2. 卡片若完全不暴露任何文件名文本/属性，`cardPresentNoName` 会命中，仍**不会**自动判定成功（按设计），此时需要人工确认。
3. `composerAttachmentEvidence` 仍是全页遍历（含 composed DOM），长页面下每 650ms 一次有一定 CPU 开销；本版未做遍历优化，以免引入新的判定偏差。
