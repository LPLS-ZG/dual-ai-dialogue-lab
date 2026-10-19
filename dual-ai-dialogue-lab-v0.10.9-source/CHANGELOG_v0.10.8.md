# CHANGELOG v0.10.8

基线：v0.10.7（本版是在 v0.10.7 真机复测反馈上继续修复）
目标：附件卡片**已被识别、文件名也已读到**，却仍被判 0/N。

## 一、真实诊断证据（用户提供）

v0.10.7 的 `阶段=verify-unconfirmed` 记录里出现了决定性的一行：

```json
{
  "tag": "button",
  "text": "A题(20261019-123948).pdf",
  "descriptor": "A题(20261019-123948).pdf composer-attachment-surface absolute inset-0 cursor-interaction rounded-2xl ...",
  "rect": { "x": 455, "y": 345, "width": 160, "height": 122 },
  "matchedName": "",
  "stemOnly": false,
  "hasRemoveControl": false
}
```

同一条记录里：

```json
"counts": { "A题.pdf": 0 },
"evidenceByName": {},
"localEvidenceByName": {},
"inputFileEvidenceByName": {},
"cardCount": 4,
"cardPresentNoName": ["A题.pdf"],
"failureClass": "initial-evidence-disappeared",
"scopeBox": { "left": 443, "top": 477, "right": 1211, "bottom": 570, "degraded": false }
```

结论很直接：

- 作用域没有退化（`degraded:false`），v0.10.7 修的那条路是好的；
- 卡片被识别到了，**文件名就在 `text` 里**；
- 但 `matchedName` 是空 —— 说明**文件名匹配函数没认出这个名称**。

## 二、根因：别名后缀只认空格分隔的时间戳

`composerAttachmentEvidence` 里的 `filenamePattern`：

```js
const generatedSuffix = '(?:\\(\\s*(?:\\d{8}\\s+\\d{6}|\\d+)\\s*\\))?';
```

只接受两种别名：

- `\d{8}\s+\d{6}` → `A题(20261019 123948).pdf`（**空格**分隔）
- `\d+` → `A题(4).pdf`（纯数字重复后缀）

而 ChatGPT 实际生成的是 **`A题(20261019-123948).pdf`**（**连字符**分隔）。它既不是空格分隔（`\s+` 不匹配 `-`），也不是纯数字（含 `-`），因此整条正则失配 → `counts=0`、`matchedName=""` → 0/N。

## 三、修改

### install/content.js

| 位置 | 修改 | 理由 |
|---|---|---|
| `filenamePattern` 的 `generatedSuffix` | 改为 `(?:\(\s*(?:\d{8}(?:[\s_-]*\d{4,6})?|\d{4,6}|\d{1,3})\s*\))?` | 覆盖 `20261019-123948` / `20261019 123948` / `20261019_123948` / `20261019123948` / `20261019` / `123948` / `4` 全部形式 |
| 卡片识别循环 | 跳过 `nav, aside, [role="navigation"], [data-testid*=sidebar], [aria-label*=侧栏]` 内的元素 | v0.10.7 实测 `cardCount=4`，其中「上传项目到GitHub」（侧边栏历史会话项，带删除按钮）被误判成卡片 |
| 卡片识别循环 | 无文件名匹配时跳过「添加文件/附加文件/上传文件/add files/attach files」类按钮 | 「添加文件等内容」按钮同样被误算成卡片 |
| `containsStem` 的边界 | `(?=\s*\.|\s|$)` → `(?=\s*\.|\s|$|\s*\()` | 覆盖「带别名 + 扩展名被截断」的卡片名，如 `A题(20261019-123948).pd` |

### install/manifest.json

- `version` 0.10.7 → 0.10.8
- `description` 更新为本版修复说明

### 测试

- `test_v0107.js` 增加 7 条别名行为用例：连字符、空格、下划线、无分隔、只带日期、带别名的截断名；以及 2 条负例（不同文件不得互相匹配、扩展名粘连不得匹配）
- `test_v0107.js` 增加静态断言：侧边栏区域排除、上传按钮排除、别名正则形态
- `test_v098.js` 的旧断言（要求字面量 `\d{8}\s+\d{6}|\d+`）更新为等价的 v0.10.8 断言

## 四、预期效果

修复后，同一张卡片：

| 字段 | 修复前 | 修复后 |
|---|---|---|
| `counts["A题.pdf"]` | 0 | 1（整页文本能匹配到别名形式） |
| `attachmentCards[…].matchedName` | `""` | `A题.pdf` |
| `cardNameMatches` | 空 | `{ "A题.pdf": { source: "attachment-card-name-match" } }` |
| `matched` | `[]` | `["A题.pdf"]` |
| `confirmed` | false → 人工确认 | true（若 `busy=false`、`pageError=''`） |
| `cardCount` | 4（含 2 个误报） | 1（只算真实卡片） |

## 五、未改动

- 原始文件内存传输与校验和
- 文件控件探测与候选打分
- 人工确认回退与「人工目视确认」记录
- 对话接力、回答提取、其余诊断逻辑
- 仍未新增任何「跳过验证直接发送」的路径

## 六、已知限制

1. 本次修复的依据是用户提供的真实 DOM 文本，置信度高；但**仍未在真机上复测**，需用户再跑一次确认。
2. 若站点改用「无括号、直接拼在文件名后」的时间戳（如 `A题-20261019-123948.pdf`），当前正则只接受**括号内**的别名，届时需要再放宽。
3. 侧边栏排除依赖 `nav/aside/[role=navigation]/[data-testid*=sidebar]`；若 ChatGPT 改成纯 div 结构，误报可能回来（但只会让 `cardCount` 偏大，不会造成误判成功）。
