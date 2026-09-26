# Definition of Done

需求：Issue 有目标、验收 ID、依赖和范围；实现符合冻结基线。
代码：修改局限于授权范围；关键契约有 schema/类型；没有不必要耦合。
证据：相关 unit/contract/integration/E2E 实际通过，未执行项明确标注。
安全：权限不扩大、凭据不泄露、未知能力不默认为允许、越界负向测试通过。
恢复：涉及副作用的改动有幂等、崩溃窗口和回滚方案。
数据：迁移、兼容、保留和上下文来源有说明；没有跨项目隐性共享。
文档：行为、示例、配置 schema、ADR 与用户说明同步。
评审：Reviewer 核验 candidateSha，维护者批准；无未处理 release-blocking 缺陷。
交付：产物可追溯到 commit/test/context hash；不以模型的“完成”文字代替验证。

未满足任一必需项的任务保持未完成；不能把 TODO 注释当成完成交付。
