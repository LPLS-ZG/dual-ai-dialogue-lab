# 双 AI 对话实验室 v0.10.2 变更记录

基础版本：v0.10.1

## 针对 v0.10.1 仍出现匹配 0/3 的修复

- 新增独立于页面可见文本/DOM 的原生文件控件 `input.files` 证据通道。部分网页即使已接收文件，也可能没有把附件名暴露给 `innerText` 或 ARIA 文本。
- 上传前记录原生文件列表签名（文件名、大小、MIME），核验时只把本轮新增的 FileList 项作为证据，避免旧文件残留造成误判。
- 文件名仍使用已有归一化与时间戳/数字重名后缀兼容规则。
- 失败诊断增加 `inputFileEvidenceByName`、`nativeFileInputState` 和 `inputFileSignatures`，并扩大诊断截取长度，方便判断网页是否仍保留本轮文件。
- 保留 Shadow DOM 扫描、既有人工确认后继续流程、上传忙碌/错误检查和不创建 Downloads 临时副本的行为。

## 限制

原生 FileList 只能证明浏览器文件输入控件仍持有对应文件；代码同时检查可见 DOM 的上传忙碌/错误状态，但这仍不等同于 AI 已成功解析文件内容。本版本尚未完成真实登录态 ChatGPT/DeepSeek 端到端测试。
