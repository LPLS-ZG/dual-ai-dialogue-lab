# CHANGELOG v0.10.9

基线：v0.10.8
问题：四轮任务里，第 4 轮 DeepSeek 还在思考/输出，扩展就判定「对话结束」。

## 一、原因

最后一轮的完成判定走 `content.js` 的 `canAcceptAnswerCompletion()`：

```js
!state.generating && !state.continuationPending &&
state.stableFor >= 1800 && state.idleFor >= state.requiredIdleMs &&
(!state.requireFreshPrompt || state.freshPromptConfirmed)
```

其中 `requiredIdleMs = generationWasObserved ? 3000 : 8000`。能让它提前成立的有三点：

1. **DeepSeek 的「思考中 / 停止生成」状态检测不到。** `isGenerating()` 第一段只认带 `aria-label/title/data-testid` 的 stop 按钮，第二段只认 `[role=status]`、`[aria-live]`、`[data-testid*=thinking|generating|streaming]` 容器。DeepSeek 的状态提示往往是一个普通短文本节点，两段都不命中 → `generating=false` → `idleSince` 不再被重置。
2. **门槛太短。** 未能观测到生成状态时只要求 8 秒静默。思考阶段一次网络停顿就够 8 秒。
3. **最后一轮与中间轮用同一门槛。** 但最后一轮提前结束的代价最大——整个任务就此收尾。

## 二、修改（`install/content.js`、`install/sidepanel.js`、`install/manifest.json`）

| 位置 | 修改 | 理由 |
|---|---|---|
| `isGenerating()` | 新增「极短状态文本」探测：可见、`textContent` 去空白后长度 ≤ 20 且**完全等于** `思考中/正在思考/正在生成/生成中/停止生成/正在分析/正在搜索/thinking/generating/analyzing/stop generating` 的节点，即视为生成中 | 覆盖 DeepSeek 不在 status/aria 容器内的状态提示；要求「完全相等 + 极短」以免正文里的「思考」二字误命中 |
| `requiredIdleMs` | `generationWasObserved ? 3000 : 8000` → `Math.max(generationWasObserved ? 3000 : 15000, finalTurn ? 20000 : 0)` | 无法观测生成状态时，15 秒静默才算结束；最后一轮抬到 20 秒 |
| `sendAndWait()` | 增加 `finalTurn` 参数 | 把「是否最后一轮」传进判据 |
| `DUO_WAIT_ANSWER` 入口 | 透传 `!!message.finalTurn` | 同上 |
| `sidepanel.js` | `DUO_WAIT_ANSWER` 增加 `finalTurn: turn === maxTurns` | 由轮次调度侧标记最后一轮 |
| 完成结果 `completion` | 增加 `generatorEvidence`、`requiredIdleMs`、`finalTurn` | 下次若仍提前结束，日志能直接说明是哪条判据满足的 |

## 三、代价

- 中间轮：若无法观测到生成状态，等待时间从 8 秒静默延长到 15 秒（每轮最多多等 7 秒）。
- **最后一轮：固定要求 20 秒静默**，即回答结束后还要再观察 20 秒才收尾。这是有意为之——提前结束会让整轮任务作废，而多等 20 秒只影响体感。
- 回答等待总时长未变（任务模式最后一轮 900 秒、中间轮 600 秒），不会因此触发超时。

## 四、验证

- 新增 `test_v0109.js`：静态断言（极短状态词表、15s/20s 门槛、`finalTurn` 贯通、完成诊断字段）+ **行为断言**（用 `vm` 抽取真实的 `canAcceptAnswerCompletion`，验证 8 项边界：静默不足不得完成、达到门槛可完成、仍在生成不得完成、20 秒门槛、续生成控件、过短候选、未确认提示词）。
- 13 个回归测试全部通过（`test_v095.js` 中原先断言 `8000` 的字面量已更新为 `15000/20000`）。
- 两个包解压后重新验证。

## 五、未验证

**未在真实网页复测。** 本版的三条判据都基于代码逻辑，DeepSeek 当前的「思考中」提示是否真的是一个 ≤20 字符的完全匹配文本节点，需要实测确认：

- 若修复生效：第 4 轮会一直等到回答真正停止更新 20 秒后才收尾；
- 若仍提前结束：说明页面在思考阶段存在「长静默且未被识别为生成中」的窗口，需要看诊断里的 `generatorEvidence` 与 `requiredIdleMs` 两个字段，再决定是补状态词还是补选择器。
