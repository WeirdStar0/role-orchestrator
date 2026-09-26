# 共享记忆与上下文

## 1. 共享的是受控产物，不是整份聊天记录

每个 Execution 输入按顺序装配：
安全与项目规则 -> 角色职责 -> 当前任务目标/验收 ->
依赖产物 -> 相关项目事实与决策 -> 固定 SHA 的文件片段 -> 本执行恢复摘要。

Project Memory 在系统存储层维护；Agent 不直接打开可写共享 memory 目录。
可向 Agent 提供只读快照和 scoped bridge。原生 CLI 会话只保留在对应 Profile，
共享层不复制 session JSON、认证文件或未经筛选的原始 transcript。

## 2. 记忆类型与权限

API 的规范类型为 temporary / fact / discovery / decision / project_rule；下表复数表示集合名称。

| 类型 | 可提交者 | 发布规则 |
|---|---|---|
| temporary | 四角色 | 执行范围，过期清理，不自动进入项目事实 |
| facts | Developer/Architect/Reviewer/Coordinator | 必须引用文件、SHA、测试或命令证据；冲突转 proposed |
| discoveries | 四角色 | 先作为 observation/proposed，后续验证才能当事实 |
| decisions | Architect，Coordinator 可提出流程决定 | 技术决定保存 alternatives；重大/不可逆项仍需用户审批 |
| project_rules | Coordinator 可提案，用户确认 | 只有用户可以提升为 active 规则；不得授权自己提权 |

“可以写”指系统接受符合权限与证据要求的写请求，不是可以覆写数据库。
所有更新增加 revision，保留旧值与 superseded 关系。
并发更新使用 expectedRevision；不采用静默 last-write-wins。

## 3. 数据字段

MemoryEntry 包含 id、projectId、scope、type、content、status、
authorExecutionId、sourceArtifacts、sourceCommit、confidenceLabel、
createdAt、expiresAt、supersedes、revision。
confidenceLabel 是状态标签，不把模型自报的百分比当成校准概率。

状态为 proposed / verified / disputed / superseded / expired。
projectId 与授权 scope 在查询和写入时都检查，不能仅靠 UI 过滤。
新项目默认看不到任何其他项目记忆；复制需用户显式选择并清除不适用证据。

## 4. 抽取与污染防护

Agent 返回 memoryProposals，Context Engine 校验类型权限、长度、证据和敏感字段。
仓库文本、外部网页、工具输出都被标记为非可信数据来源；
其中“忽略政策”“修改模型”“批准命令”等语句不能改变系统策略。
失败或未通过审查的代码可保存 observations，但不能自动成为已采纳架构规则。

初期不增加第五个 Memory Extractor 角色。使用当前角色结构化结果 + 确定性规则，
必要时由既有 Coordinator 处理提案，并计入 Execution 预算。

## 5. 检索和上下文预算

先基于 project/task/type/tags/dependency filter 与 SQLite 文本索引检索；
向量检索属于后续优化，不是启动版必需依赖。
优先保留规则、验收标准、审批范围、关键依赖和源代码证据。
先截断低优先级日志；不能为了缩短上下文丢掉安全限制。

模型上下文窗口未知时使用保守字符/字节预算并标记估计；
真实 tokenizer/窗口信息已验证时才使用 token 精算。
保存 contextManifest：片段顺序、来源、版本、内容 hash、删减原因和估算方式。
用户可以查看“这个 Agent 看到了什么”，但诊断视图仍不得展示凭据。

## 6. 过期与更新

基线 SHA 改变时，引用旧文件位置的记忆标记可能过期，按需重新验证。
用户撤销规则后新 TaskRun 不再注入；历史 TaskRun 保留原输入记录。
删除敏感记忆时检查摘要、日志、缓存和 artifacts 的派生副本；
CLI 自己保存的历史有独立保留政策，产品不能保证替第三方清理所有历史。
