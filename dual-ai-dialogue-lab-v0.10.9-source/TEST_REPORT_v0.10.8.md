# TEST_REPORT v0.10.8

基线 v0.10.7。本版是**基于用户提供的真实诊断记录**做的定点修复，不是推测。

## 一、修复依据（真实数据）

用户提供的 `阶段=verify-unconfirmed` 记录中，卡片节点的真实内容为：

```
tag=button  text="A题(20261019-123948).pdf"  matchedName=""  rect=(455,345,160,122)
counts={"A题.pdf":0}  cardCount=4  scopeBox.degraded=false
```

这同时否定了 v0.10.6 的两个旧猜想（作用域退化、卡片未被识别）——作用域正常、卡片也被采到了，**唯一失败点是文件名匹配**。

## 二、静态检查

| 检查 | 结果 |
|---|---|
| `node --check install/content.js` | 通过 |
| `node --check install/sidepanel.js` | 通过 |
| `node --check install/background.js` | 通过（未修改） |
| `manifest.json` 解析与版本 | 通过，`0.10.8` |

## 三、回归测试

12 个脚本全部通过：

```
PASS test_v094  test_v095  test_v096  test_v097  test_v098  test_v099
PASS test_v0102 test_v0103 test_v0104 test_v0105 test_v0106 test_v0107
```

## 四、行为测试（抽取生产代码执行）

从 `install/content.js` 抽取真实的 `norm` / `escapeRegex` / `filenamePattern` / `containsFilename` / `stemOf` / `containsStem`，在 `vm` 中运行：

| 输入卡片文本 | 目标文件 | 期望 | 结果 |
|---|---|---|---|
| `A题(20261019-123948).pdf` | `A题.pdf` | 匹配 | 通过（**本版核心修复点**） |
| `A题(20261019 123948).pdf` | `A题.pdf` | 匹配 | 通过 |
| `A题(20261019_123948).pdf` | `A题.pdf` | 匹配 | 通过 |
| `A题(20261019123948).pdf` | `A题.pdf` | 匹配 | 通过 |
| `A题（20261019-123948）.pdf`（全角括号） | `A题.pdf` | 匹配 | 通过 |
| `A题(20261019).pdf`（只带日期） | `A题.pdf` | 匹配 | 通过 |
| `A题.pdf (4)` | `A题.pdf` | 匹配 | 通过 |
| `附件1(20261019-123948).xlsx` | `附件1.xlsx` | 匹配 | 通过 |
| `B题(20261019-123948).pdf` | `A题.pdf` | **不**匹配 | 通过 |
| `A题(20261019-123948).pdfx` | `A题.pdf` | **不**匹配 | 通过 |
| `A题(20261019-123948).pd`（截断） | `A题.pdf` | 词干匹配 | 通过 |
| `A题库` | `A题.pdf` | **不**匹配 | 通过 |

另外保留 v0.10.7 引入的 `boundedEvidenceJson` 行为测试（超长证据 → 长度 ≤11000、结论字段保留、输出是合法 JSON）。

## 五、验收标准对照（相对 v0.10.7 的更新）

| # | 验收项 | 状态 |
|---|---|---|
| 1 | 单个 PDF 成功上传能被识别 | **待真机复测**；本版修复了实测中唯一失配环节（别名），预期 `counts` 0→1、`matchedName` 空→`A题.pdf` |
| 2 | 多文件分别识别 | **待真机复测**；逐名匹配逻辑未变 |
| 3 | FileList 为空但卡片存在时不得报失败 | **待真机复测**；v0.10.7 已不再把 FileList 当唯一依据 |
| 4 | 明确失败时给出对应错误类别 | **待真机复测** |
| 5 | 上传中与失败区分 | **待真机复测** |
| 6 | 无法确认时报告「无法确认」 | **已验证（分类存在）**；`card-present-name-unreadable` / `card-present-unmatched` |
| 7 | 漏检时诊断可追溯 | **已验证**；本次正是靠 `attachmentCards` 的 `text` 与 `matchedName` 定位到根因 |
| 8 | 超长诊断不丢失最终判定 | **已验证**（行为测试） |
| 9 | ChatGPT 与 DeepSeek 分别检查 | **仅 ChatGPT 有真实数据**；DeepSeek 未复测 |
| 10 | 原有功能不丢失 | **已验证**；12 个回归测试全绿，`background.js` / `materials.js` 未改 |

## 六、用户复测步骤

1. 解压 `dual-ai-dialogue-lab-v0.10.8.zip`，扩展页删除旧版后加载新目录。
2. **刷新 ChatGPT 与 DeepSeek 页面。**
3. ChatGPT：选 `A题.pdf`，勾选新建对话 + 附件投递，跑两轮任务。
4. 期望日志：
   - `阶段=verify-confirmed；匹配 1/1`（不再是 `verify-unconfirmed`）
   - 若仍失败，看 `counts` 与 `attachmentCards[].matchedName`：这两个值现在应当非 0 / 非空；若仍为 0，说明卡片文本形式又变了，把该条记录贴回来。
5. DeepSeek：用 `附件1.xlsx` + `附件2.xlsx`，期望 `匹配 2/2`。

## 七、仍未做的测试

- 未在任何真实登录页面执行（本环境无浏览器登录态）。
- 未验证 DeepSeek 的附件卡片是否也会加别名后缀；如果它用的是别的形式，需要再做一次针对性适配。
- 未做性能测量；`composerAttachmentEvidence` 仍是全页 composed DOM 遍历。
