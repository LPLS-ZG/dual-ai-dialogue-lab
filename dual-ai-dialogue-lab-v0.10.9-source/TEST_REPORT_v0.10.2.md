# v0.10.2 测试报告

## 修复目标

v0.10.1 实测报告出现 `counts=0`、`evidenceByName={}`、`localEvidenceByName={}`，三个文件都没有通过 DOM 文本扫描。仅继续扩展 DOM 扫描无法解决“网页持有文件但文件名不出现在可访问文本中”的情况。

## 本次验证

- `node --check install/content.js`：通过。
- `node --check install/sidepanel.js`：通过。
- `node test_v094.js` 至 `node test_v099.js`：回归测试通过。
- `node test_v0102.js`：通过，覆盖原生 FileList 证据通道、上传前签名排除、时间戳别名与 XLSX 文件名匹配。
- 安装包和源码包 ZIP 完整性检查：通过。

## 验收边界

未在真实登录态 ChatGPT/DeepSeek 网页完成端到端测试。原生 FileList 证据能证明文件仍在文件控件中，但不能单独证明服务端已完成上传；核验器仍同时检查网页可见上传中/失败状态。实测时请关注 `inputFileEvidenceByName` 和 `nativeFileInputState`：若 FileList 有三份文件但 DOM 文本计数为 0，说明本次识别成功依赖新的原生文件列表证据通道；若 FileList 也为空，则说明网站事件处理清空了控件，后续需要针对网页附件卡片的实际 DOM 继续定位。
