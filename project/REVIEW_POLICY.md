# 代码评审政策

审查对象是固定 candidateSha 与其相对 inputSha 的 diff，而不是随时间变化的分支名。
Reviewer 使用新执行上下文；模型相同也要独立 session。
检查正确性、验收范围、异常路径、并发、数据隔离、权限、恢复和测试证据。

权限/认证、执行启动与终止、Git 集成、Memory scope、配置解析、迁移、发布工作流
属于高风险变更，必须增加针对性负向或故障注入测试。
仅有 snapshot test 或模型意见不能替代关键行为测试。

报告必须包含 verdict、candidateSha、findings、severity、file/line 或 evidenceRef、
阻断项与复审条件。没有证据的确定性断言应改为待验证问题。
代码变化后重新审查；不能把旧 verdict 移植到新 SHA。
Reviewer 默认不直接修复代码；通过创建 Developer 修复提案进入有限返工流程。
最终 main 合并和发布由维护者批准。
