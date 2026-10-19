# 双 AI 对话实验室 v0.10.1 变更记录

基础版本：v0.9.9

## 针对本次 0/3 误判的修复

- 将附件证据扫描扩展到 composed DOM：递归读取页面可访问的 open shadow roots，并处理 slot 分配元素；普通 `document.querySelectorAll('body *')` 无法遍历这些节点。
- 不再因为附件卡片所在的可见行/容器宽度或高度较大，就跳过其中的文件名标签；仍要求元素可见且位于输入区附近。
- 将短的可见节点文本纳入文件名计数，覆盖不出现在 `document.body.innerText` 中的 Web Component 附件标签。
- 自动核验失败时，诊断报告记录 counts、baselineCounts、evidenceByName、localEvidenceByName、composerRect、evidenceScope 和上传忙碌/错误状态，方便区分“没扫到节点”“扫描到但基线抵消”和“网页仍在处理”。
- 保留原有文件名时间戳/重名别名、人工确认后继续、上传状态检查及不创建 Downloads 临时副本等行为。

## 限制

本次仍未在真实登录态网页完成端到端测试。自动测试只能验证代码路径与回归规则，不能证明当前 ChatGPT 的实际附件卡片一定会被 DOM 暴露或扫描命中。
