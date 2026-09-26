# @role-orchestrator/cli-events

CLI 事件流的健壮解析与规范化。行为契约来自 `docs/CLI_ADAPTERS.md`「事件规范」，
规范化事件类型直接复用 `@role-orchestrator/contracts` 的 `NormalizedEventType`
（12 种），业务 schema 复用冻结的 `ExecutionResultSchema`，本包不重复定义。

## 分层 API

| 模块 | 职责 |
|---|---|
| `JsonlByteLineSplitter` | 字节级 JSONL 行重组：分片行、跨块多字节 UTF-8、单行/总量限制 |
| `buildNormalizedEvents` | 方言（claude/codex）→ 12 种规范化事件，`sourceType` 保留原始类型 |
| `EventStreamPipeline` | stdout/stderr 双端口、空行跳过、重复行去重、统计、协议错误 |
| `evaluateOutcome` | 失败关闭（fail-closed）的业务 outcome 判定 |
| `redact` | A36 脱敏的单一事实来源（自 M1-04 从 local-api 迁入）：`Bearer <token>`、`token=`/`api-key=`/`password:` 等秘密形态 → `[REDACTED]` 占位符。`redactText` 逐文本、`redactJsonValue` 深度遍历 JSON（只改字符串值，不改结构）；模式清单可配置，可选高熵长串扫描默认关闭；占位符不匹配任何模式，脱敏幂等。engine 持久化路径在写库前调用它，local-api 出进程时再次调用作纵深防御 |

## 定义良好的解析行为

| 输入 | 行为 |
|---|---|
| 分片行（跨 chunk） | 按字节缓冲重组，见到 `\n` 才解码整行 |
| 多字节 UTF-8 跨块 | 安全：`\n`（0x0A）不落在多字节序列内部，按完整行解码 |
| 空行 / 纯空白行 | 跳过并计数（`emptyLinesSkipped`） |
| 超长行 | 超过 `maxLineBytes`（默认 1 MiB）→ 协议错误 `line-limit-exceeded`，流失败关闭，后续输入全部忽略 |
| 总量超限 | 超过 `maxTotalBytes`（默认 64 MiB）→ `total-limit-exceeded`，同上失败关闭 |
| 混杂 stderr | `feedStderr` 只捕获（默认封顶 64 KiB 字符），绝不解析为协议事件 |
| 末尾不完整 JSON | `end()` 时 → 协议错误 `unterminated-json`（截断信号） |
| 末尾完整 JSON 但无换行 | 合法：作为最后一行接受 |
| 中途坏 JSON 行 | 协议错误 `unparseable-json`，继续处理后续行 |
| 重复行 | 内容完全相同的行只归一化一次，后续计入 `duplicatesSkipped` |
| 不认识的事件类型 | 归入 `diagnostic`（`sourceType` 保留原始类型），不可能据此判 success |
| 缺最终事件 | `evaluateOutcome` 给出 `missing-final-result` |

限制是失败关闭的：一旦流失败，任何后续 outcome 判定都包含 `protocol-error`，
解析器不可能"继续读下去"而漏掉真实最终事件还报成功。

## 归一化映射（synthetic 近似，M0-03/M0-04 校验）

- **claude**：`system(init)`→`started`；`assistant` 的 text/tool_use 块→
  `message_delta`/`tool_started`；`user` 的 tool_result→`tool_completed`；
  `result`→`result_reported`（+ 有 `usage` 时另发 `usage_reported`），业务负载取
  `structured_output`；`error`→`error`；`artifact`→`artifact_reported`（合成扩展）；
  `control_request(can_use_tool)`→`approval_requested`、
  `control_response(permission_denied)`→`permission_denied`（合成扩展）。
- **codex**：`thread.started`→`started`；`item.started/completed` 的
  command_execution/mcp_tool_call→`tool_started`/`tool_completed`；
  `item.completed(agent_message)`→`message_delta`；`item.completed(file_change)`→
  `artifact_reported`；`turn.completed`→`result_reported`（+`usage_reported`），
  业务负载取合成扩展字段 `execution_result`；`turn.failed`→带错误的
  `result_reported`；`error`→`error`；`approval.requested`/`approval.denied`→
  `approval_requested`/`permission_denied`（合成扩展）；`turn.started` 无对应
  规范化类型，记为 diagnostic。
- `process_exited` 由适配器/管道在进程等待完成后显式追加
  （`EventStreamPipeline.emitProcessExited`）。

## 成功判定

```
success ⇔ exitCode === 0
       ∧ 无协议错误
       ∧ 存在最终 result_reported 事件
       ∧ 该事件 payload.isError !== true
       ∧ （非 error 结果）payload.businessResult 通过 ExecutionResultSchema（strictObject）
```

失败原因有序枚举：`nonzero-exit`、`protocol-error`、`missing-final-result`、
`final-result-error`、`business-schema-invalid`。error 标记的结果不再追加
`business-schema-invalid`：错误路径本就不携带可信的业务负载。

## 真实协议映射（M0-03 实测，claude 2.1.278）

M0-03 用用户自行认证的真实 CLI 在系统临时目录 scratch 中完成了 smoke 采集，
脱敏样本存放在本包 `fixtures-real/claude/`（`.real.jsonl` + `manifest.json`，
`synthetic: false`），配套 contract 测试见 `test/real-fixtures.test.ts`。
实测发现的真实协议形状，以**新增映射**处理（synthetic 路径不变）：

- `system/api_retry`、`system/hook_started`、`system/hook_response` → 显式
  diagnostic（`api-retry` / `hook-started` / `hook-response`，携带
  attempt/errorStatus/hookName 等字段）。没有对应的规范化类型，也不得视为进展。
- `system/init` 扩充：`claudeCodeVersion`、`permissionMode`、`cwd`、
  `apiKeySource`、`toolCount`、`mcpServerCount`（存在才写入）。
- assistant 行可带 `is_api_error_message: true`（本地生成的 "API Error: …"
  占位消息，`message.model` 为 `"<synthetic>"`）→ 其 text 块映射的
  `message_delta` 载荷带 `apiError: true`。
- `thinking` / `redacted_thinking` 内容块 → diagnostic
  （`thinking-block-not-normalized`），不复制其内容。
- `result` 行实测字段：`resultText`、`terminalReason`、`apiErrorStatus`、
  `numTurns`、`permissionDenials`（存在才写入）。**关键陷阱：真实 CLI 在
  API 失败时给出 `subtype: "success"` 且 `is_error: true`、exit 1** ——
  判定必须以 `is_error` 为准，绝不能信 subtype。
- 普通 `-p` 运行的 `result` 行**没有** `structured_output`：平凡真实成功流
  的业务判定是 fail-closed 的 `business-schema-invalid`，产品要拿到业务
  成功必须显式要求结构化输出契约。

## 真实协议映射（M0-04 实测，codex-cli 0.154.0）

M0-04 用用户自行认证的真实 CLI 在系统临时目录 scratch（临时 git 仓库）中
完成了 smoke 采集，脱敏样本存放在本包 `fixtures-real/codex/`（`.real.jsonl`
+ `manifest.json`，`synthetic: false`），配套 contract 测试见
`test/real-codex-fixtures.test.ts`。实测结论以**新增映射**处理（synthetic
路径不变）：

- 真实成功流与 synthetic 近似高度兼容：`thread.started`→`started`、
  `item.completed(agent_message)`→`message_delta`、
  `item.started/completed(command_execution)`→`tool_started`/`tool_completed`、
  `turn.completed`→`result_reported`(+`usage_reported`) 全部按既有映射通过。
- 真实 `turn.completed` 的 `usage` 字段集为 `input_tokens` /
  `cached_input_tokens` / `cache_write_input_tokens` / `output_tokens` /
  `reasoning_output_tokens`，且**没有**业务负载字段（synthetic 用
  `execution_result` 扩展表达）。平凡真实成功流因此一律 fail-closed 为
  `business-schema-invalid`（CLI 成功 ≠ 业务成功，与 claude 侧结论一致）。
- **新增映射**：真实流存在 `item.completed` 且 `item.type` 为 `"error"` 的行
  （模型元数据回退警告、skills 预算提示、后端拒绝详情等 CLI 级消息）→
  归一化为 `error` 事件（`sourceType` 保留 `item.completed`，载荷含
  `itemId`/`message`）。synthetic 无此形状。
- 失败形态：`-m` 传本账号不支持的模型时，参数层不报错；流内依次出现
  item 级 error ×2 → 顶层 `error`（后端 detail）→ `turn.failed`，exit 1、
  无 usage 事件。事件顺序不保证（实测 `turn.started` 出现在首个 item 之后）。
- 默认权限行为（A19 方向）：非交互 exec 默认模式下，要求写工作区内文件的
  命令**被真实执行**（`command_execution` exit_code 0、文件落盘），全程无
  `approval.requested`/`approval.denied` 事件——exec JSONL 流中不存在交互
  审批通道。
- 环境门：`codex exec` 默认拒绝在非 git 目录运行（exit 1，stderr 提示
  `--skip-git-repo-check`）；本次所有采集在临时 git 仓库中以免使用任何
  额外参数。
- resume：`codex exec resume <SESSION_ID> --json -` 接受 UUID 形态会话 id，
  新 `thread.started` 原样返回同一 `thread_id`；恢复回合 `input_tokens`
  约为平凡新会话基线的两倍（历史重放的客观证据）。
- stderr 会有与协议无关的内部日志（如 `codex_memories_write` 的 ERROR 行），
  管道按既有语义仅在诊断端口捕获，绝不进入协议流。

## 注意

本包解析的是 `@role-orchestrator/fake-cli` 的 synthetic 事件形状（近似实现）。
真实 CLI 的事件对照：claude 侧已在 M0-03 完成并沉淀到 `fixtures-real/claude/`，
codex 侧已在 M0-04 完成并沉淀到 `fixtures-real/codex/`。fixtures-real 均为
脱敏真实采集（运行期标识替换为 `<redacted-N>`），fixtures（synthetic）均为
`.synthetic.jsonl` 合成样本；两者在 manifest 中分别标记，不互相冒充。
