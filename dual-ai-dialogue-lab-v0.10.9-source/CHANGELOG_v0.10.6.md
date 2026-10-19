# 双 AI 对话实验室 v0.10.6 更新记录

## 本次目标
加强附件自动核验失败时的诊断信息，帮助下一次报错定位是网页明确报错、仍在上传、初始上传证据消失，还是文件名检测不到。

## 修改内容
- 在消息输入区附近采集有上限的可见 DOM 诊断节点样本：标签、短文本、ARIA/title/test-id/class 描述、矩形位置；不采集对话正文或文件内容。
- 每次核验历史摘要增加原生文件控件状态、输入区附近候选节点、输入区位置和证据范围。
- 自动核验失败时新增 `failureClass` 分类：`page-upload-error`、`upload-still-busy`、`initial-evidence-disappeared`、`filename-not-detected`、`stability-timeout` 等。
- 将最终失败诊断证据上限从 2600 字符提高到 7000 字符，保留更多定位上下文。
- 继续区分自动核验和人工目视确认，不会因无法识别附件就伪报自动成功。

## 验证范围
- `node --check install/content.js` 通过。
- `node --check install/sidepanel.js` 通过。
- `node test_v0106.js` 静态回归检查通过。
- 未在用户登录的 Edge/ChatGPT 环境执行实机上传；DOM 诊断是否能捕获到具体网页卡片，需要用户下一次运行日志验证。
