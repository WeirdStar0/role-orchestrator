# API、事件与契约

本文件为设计接口，不代表本包已实现 HTTP 服务。
公共接口统一为 `/api/v1`，契约由 TypeScript/Zod 派生并验证 JSON Schema。
请求中的未知字段默认拒绝，特别是 profileId/model 覆盖与权限扩展字段。

## API 草案

| 方法与路径 | 行为 | 关键约束 |
|---|---|---|
| POST /projects | 添加本地 Git 项目 | canonical path、target、用户信任确认 |
| GET /profiles | 返回脱敏 Profile 摘要 | 不返回 token/env values |
| POST /profiles | 创建 Profile revision | 本机操作，配置目录不上传 |
| POST /profiles/:id/probe | 显式能力探测 | 可能调用 CLI，需用户触发并计入资源 |
| PUT /projects/:id/role-bindings | 更新四角色绑定 | If-Match/expectedRevision；只影响新 run |
| POST /projects/:id/tasks | 创建目标与验收 | 不接受模型/Profile 字段 |
| POST /tasks/:id/runs | 创建冻结配置 TaskRun | Idempotency-Key |
| GET /runs/:id | 查看状态和结果 | 项目隔离 |
| PATCH /runs/:id/graph | 更新 DAG revision | expectedGraphRevision；检查无环与已运行节点 |
| POST /runs/:id/pause | 暂停新调度或请求安全停止 | 不伪称进程被冻结 |
| POST /runs/:id/cancel | 取消 | 验证进程树退出，保留未提交改动 |
| POST /nodes/:id/retry | 请求新尝试 | 不绕过重试上限与副作用核对 |
| POST /executions/:id/recover | Resume/Retry/Abort | 使用 recovery assessment 与有效确认 |
| GET /executions/:id/context | 脱敏 context manifest | 不暴露凭据 |
| GET /runs/:id/artifacts | 查看受管产物 | 受控文件 ID，不接受任意路径读取 |
| POST /approvals/:id/decision | 接受/拒绝 | 校验 digest、过期、actor 与单次消费 |
| POST /memory/proposals | 提交记忆提案 | 执行级授权 token，分类权限检查 |
| GET /events | 持久化事件查询 | after cursor、limit、授权范围 |
| WS /events/live | 实时事件订阅 | 同源鉴权、cursor 补发、背压 |

## 幂等与错误

写操作要求 Idempotency-Key，与 payload hash 一起保存；
同 key 不同 payload 返回 409，不默默复用旧请求。
常见错误：CONFIG_OVERRIDE_FORBIDDEN、PROFILE_UNVERIFIED、GRAPH_CYCLE、
GRAPH_REVISION_CONFLICT、APPROVAL_STALE、CAPABILITY_UNSUPPORTED、
RECOVERY_REQUIRED、BUDGET_EXCEEDED、WORKSPACE_CONFLICT。
面向用户的错误包含可操作原因，不回传完整命令环境或凭据。

## 事件信封

```json
{
  "schemaVersion": 1,
  "eventId": "evt_example",
  "projectId": "project_example",
  "runId": "run_example",
  "executionId": "execution_example",
  "seq": 12,
  "type": "execution.tool_completed",
  "occurredAt": "2026-09-21T00:00:00Z",
  "payload": {
    "toolCallId": "call_example",
    "summary": "Test command completed",
    "exitCode": 0,
    "evidenceRef": "artifact_example"
  }
}
```

示例时间和 ID 为占位数据，不代表真实执行。
每 execution seq 单调；跨 execution 订阅另用 serverCursor，
不能用全局时间戳推导严格先后顺序。
重放允许至少一次投递，客户端按 eventId 去重。
大型内容走 artifacts，事件仅保存引用/hash/摘要。
