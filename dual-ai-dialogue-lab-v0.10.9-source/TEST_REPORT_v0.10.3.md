# v0.10.3 测试报告

## 自动检查

- `node --check install/content.js`：通过。
- `node --check install/sidepanel.js`：通过。
- `node test_v0103.js`：通过，检查即时证据采集、文件控件身份诊断及故障报告透传。
- `node test_v094.js` 至 `node test_v099.js`：回归通过。
- ZIP 完整性与清单版本检查：通过。

## 实测状态

未在真实登录态 ChatGPT/DeepSeek 网页完成端到端验证。v0.10.3 的目标是让下一次失败报告能够回答：事件派发后 120ms 时原生控件是否已清空、控件是否被网页替换、即时附件界面是否出现证据。它不把“已交给文件控件”误报为“网站上传成功”，也不放宽发送保护。
