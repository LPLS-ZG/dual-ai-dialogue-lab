# 双 AI 对话实验室 v0.10.1 测试报告

日期：2026-10-19

## 测试结论

本报告仅确认源码静态检查、既有自动化回归、附件别名规则与 DOM 扫描路径检查通过。**没有执行真实登录态 ChatGPT / DeepSeek 端到端测试**，因此不宣称真实网页误判已彻底消失。

## 本次自动检查

- `node --check`：background.js、content.js、sidepanel.js、materials.js 及测试脚本语法检查。
- `node test_v094.js`、`test_v095.js`、`test_v096.js`、`test_v097.js`、`test_v098.js`、`test_v099.js`：回归测试。
- `manifest.json` 版本与 JSON 格式检查。
- 安装包和源码包 `unzip -t` 完整性检查。

## 主要修复

v0.9.9 实测出现 `匹配 0/3`。v0.10.1 遍历 open shadow roots / slotted elements，移除局部证据扫描对单个元素尺寸的过严限制，并在回退诊断中输出 counts、baselineCounts、evidenceByName、localEvidenceByName、composerRect 与 evidenceScope。

## 尚未证明

- 当前 ChatGPT 页面真实附件卡片是否位于可访问的 open shadow DOM 或普通 DOM。
- 是否还存在闭合 shadow root、canvas、跨框架/隔离渲染等无法从 content script 读取的 UI。
- 真实附件上传成功后是否稳定通过核验。

## 建议验收

用原来的 `A题.pdf`、`附件1.xlsx`、`附件2.xlsx` 重测。如仍失败，诊断里新增的 `核验证据` 将用于判断计数为 0 的原因。若 `counts` 与 `localEvidenceByName` 都为空，需进一步检查页面是否将附件卡片渲染在不可访问的 DOM/iframe 中；若 counts 有值但 baseline 相同，则应继续修正基线抵消逻辑。
