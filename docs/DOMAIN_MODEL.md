# 领域模型与数据设计

## 主要实体

| 实体 | 核心字段 | 不变式 |
|---|---|---|
| Project | id, repoRoot, executionTarget, trustStatus | canonical repoRoot，按项目隔离记忆 |
| ProfileRevision | profileId, revision, runtime, configDirRef, model, target, hash | 不保存 Token，revision 不可变 |
| RoleBinding | projectId, roleId, profileId, permissionsRevision | roleId 只能是四个内置值 |
| WorkflowRevision | workflowId, revision, nodeDefinitions | 不含模型/Profile 覆盖 |
| Task | id, projectId, goal, acceptanceCriteria | 表示用户需求，而不是 CLI 进程 |
| TaskRun | id, taskId, graphRevision, configSnapshotHash, baseSha | 一次完整执行；固定配置快照 |
| TaskNode | id, runId, definitionRevision, roleId, dependencies | 运行定义不可原地改变 |
| Execution | id, runId, nodeId, attempt, phase, sessionId, pidIdentity | 一个进程尝试，允许失败保留证据 |
| Artifact | id, executionId, contentHash, path, kind, candidateSha | 不可变，路径由系统分配 |
| MemoryEntry | id, scope, type, revision, status, evidenceRefs | projectId 必填，写入带 CAS |
| Decision | id, actor, subject, alternatives, rationale, evidence | 不等于权限批准 |
| Approval | id, actionDigest, scope, expiresAt, state, actor | 单次使用，动作变更即失效 |
| ResourceLease | id, executionId, resourceKey, fencingToken, expiresAt | 超时只代表需 reconcile |
| ExecutionEvent | executionId, seq, type, payload, timestamp | 每 Execution seq 唯一、单调 |
| Outbox | id, aggregateId, payload, publishedAt | 事务提交后投递，可重复，接收端幂等 |

Role 是代码内置定义，不是可任意创建的表；RoleBinding 为项目配置。
同一角色可对应多个并发 Execution，但不能在单个节点改用另一个 Profile。

## 唯一性与事务

必要约束：
`UNIQUE(project_id, role_id)`；
`UNIQUE(profile_id, revision)`；
`UNIQUE(run_id, node_id, definition_revision, attempt)`；
`UNIQUE(execution_id, seq)`；
`UNIQUE(operation_type, idempotency_key)`。

执行启动幂等键由 run/node/revision/attempt 构成。
同一节点同一 revision 最多一个有效 writer lease。
集成记录对 input commit set hash 唯一，防止恢复后重复集成。
Approval 用事务 compare-and-swap 从 PENDING 转为 CONSUMED；过期或基线改变不能消费。

## 存储边界

SQLite 保存任务、状态、配置快照、记忆、索引、审批与事件摘要。
大事件 payload、原始 CLI 日志、patch、测试附件保存在文件系统。
高频文本增量可批量存盘；durable 事件包含 seq 与 checksum，以支持重放。
Git 保存代码版本，DB 保存引用，不保存完整工作树。

配置目录是用户机器上的 locator，不是可导出的认证材料。
日志默认经过脱敏；原始未脱敏 transcript 只在用户明确启用的诊断模式保留。

## 文件布局

```text
<user-data>/role-orchestrator/
  orchestrator.db
  profiles/             # metadata only; CLI credentials are not copied here
  runs/<execution-id>/  # events, context manifests, result, diagnostics
  artifacts/<hash>/
  workspaces/<project-id>/<run-id>/<execution-id>/
  backups/
```

目录名使用 ID，不使用模型返回的任意路径。Windows 下使用用户可写目录或用户指定短路径，
不假设 H 盘存在，不把个人绝对路径写入仓库配置。
数据库、任务日志、认证环境不放入被 Agent 直接修改的仓库目录。

## 数据迁移与保留

迁移有版本、向前升级测试和备份步骤。高风险迁移前暂停调度并确认备份完整。
完成且交付的工作树可清理；失败、中断、待审批和含未提交修改的工作树默认不删。
产物引用删除须检查 Memory、Decision、Approval 与 Execution 的关联。
清理期限是用户策略，不以“清理日志”代替不可撤销操作审计。
