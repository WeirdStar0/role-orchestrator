# M0-03 · Claude 非交互接入验证报告

状态：已完成（真实调用部分受上游 429 限流约束，两项能力只能记 unverified，详见下文）。
对应任务：docs/BACKLOG.md `M0-03`（验收 A05/A19/A33/A35 方向）。角色：Developer。
日期：2026-09-21。所有结论绑定本报告记录的真实命令退出码；无任何手写 PASS。

## 1. 环境与实测版本

| 项 | 值 | 来源 |
|---|---|---|
| CLI | claude `2.1.278`（stdout 原文 `2.1.278 (Claude Code)`） | 本次实测，见调用 #1 |
| OS | Windows 10.0.26100 x64，Git Bash（shell 层为 cmd.exe 宿主） | 本次实测 |
| Node / pnpm | v25.0.0 / 10.14.0 | 本次实测 |
| 运行目录 | 系统临时目录下新建 scratch（`mktemp -d -t m03-claude-scratch-XXXX`），不在仓库内 | 约束：真实调用不得在仓库目录运行 |
| 权限模式 | init 事件记录 `permissionMode: "default"` | 调用 #2 脱敏流 |
| 认证 | init 事件记录 `apiKeySource: "none"`；未读取任何 auth/config 文件 | 调用 #2 脱敏流 |

## 2. 方法与约束遵守

- 全部真实调用都在 scratch 目录执行；提示词均为自拟平凡内容（`Reply with exactly OK` 等），经 stdin 输入，未把仓库内容放进提示词。
- 未使用任何跳过权限参数（无 `--dangerously-skip-permissions` 等），未执行登录/登出/凭据命令，未修改 CLI 配置，未读取 auth/config 文件内容。
- 真实调用共 **8 次**（预算 ≤10），逐次记录见第 4 节。无一次认证失败（未触发登录态问题）；所有推理级失败均为网关 `429 rate_limit`。
- 产物：脱敏 fixture 5 个 + manifest（`packages/cli-events/fixtures-real/claude/`，`synthetic: false`）；contract 测试 `packages/cli-events/test/real-fixtures.test.ts`（17 条）；解析器扩展 `packages/cli-events/src/normalizer.ts`。

## 3. 检查单逐项结论

| # | 检查项 | 结论 | 依据 |
|---|---|---|---|
| 1 | 版本记录 | **verified** | 调用 #1：`claude --version` → exit 0，stdout `2.1.278 (Claude Code)` |
| 2a | stream-json 事件流形态（错误/重试路径） | **verified** | 调用 #2/#5 捕获完整事件流：`hook_started`×2 → `hook_response`×2 → `system/init` → `api_retry`×10 → `assistant`（API 错误占位消息）→ `result`（`subtype:"success"` 但 `is_error:true`、`terminal_reason:"api_error"`、`api_error_status:429`、exit 1） |
| 2b | stream-json 成功推理路径（平凡提示词得到正常回复） | **unverified** | 3 次尝试（初始 + 2 次重试，为该检查的上限）全部 429，模型从未产出正常回合 |
| 3 | 权限行为（默认权限下要求创建小文件） | **unverified** | 调用 #8：10 次内部重试后 429 终止，无任何 `tool_use` 事件、探针文件未创建、`result.permission_denials == []`。部分证据：init `permissionMode:"default"`；`-p` 模式无交互审批通道（`control_request` 从未出现，A19 相关） |
| 4a | resume 参数形态与 CLI 层行为 | **verified** | 调用 #6：`--resume <session-id>`（id 在报告中以 `<redacted>` 表示）被接受；新 init 事件的 `session_id` 与被恢复 session **一致**（运行时比对为 True）；随后推理 429 |
| 4b | resume 语义连续性（恢复后对话延续） | **unverified** | 推理被 429 阻断，无法观察延续 |
| 5a | `-m` 无效值行为 | **verified** | 调用 #4：`--model definitely-not-a-real-model-xyz` → CLI **不在参数层拒绝**，stderr 打 `[claude-code:unrecognized_model] {"model":"...","query_source":"sdk"}`，`init.model` 原样透传，网关返回 400（无重试，`api_retry` 为 0 条），exit 1 |
| 5b | `-m` 有效值行为 | **verified（接受度）/ unverified（推理）** | 调用 #7：`--model 'claude-opus-5[1m]'`（实测默认模型串）→ stderr **无** `unrecognized_model` 警告（与 5a 形成对照），`init.model` 原样回显；推理 429 |

无 blocked 项：认证始终有效（请求持续到达网关并被限流），不存在因未登录而终止检查的情形。

## 4. 真实调用台账（8 次）

| # | argv（cwd=scratch，提示词经 stdin） | 退出码 | 时长 | 结果摘要（脱敏） |
|---|---|---|---|---|
| 1 | `claude --version` | 0 | <1s | `2.1.278 (Claude Code)` |
| 2 | `claude -p --output-format stream-json --verbose` ＋ stdin `Reply with exactly OK` | 1 | 242.7s | 17 行流：hooks+init+`api_retry`×10（`error_status:429`，`max_retries:10`）+ assistant API 错误占位 + `result`（`is_error:true`，`subtype:"success"`） |
| 3 | 同 #2（第 1 次重试） | 1 | 229.4s | 同 #2，10×429 |
| 4 | `claude -p --output-format stream-json --verbose --model definitely-not-a-real-model-xyz` ＋ 同提示词 | 1 | 7.4s | stderr `unrecognized_model` 警告；`init.model` 透传；400 无重试；`terminal_reason:"api_error"` |
| 5 | 同 #2（第 2 次重试，预算用尽） | 1 | 232.7s | 同 #2，10×429 |
| 6 | `claude -p --output-format stream-json --verbose --resume <redacted>` ＋ stdin `Reply with exactly RESUMED` | 1 | 227.6s | init `session_id` == 原 session（True）；15 行流（本次仅 1 对 hook）；10×429 |
| 7 | `claude -p --output-format stream-json --verbose --model 'claude-opus-5[1m]'` ＋ `Reply with exactly OK` | 1 | 230.2s | stderr 干净；`init.model` 回显；10×429 |
| 8 | `claude -p --output-format stream-json --verbose` ＋ stdin `Create a file named m0_03_probe.txt in the current directory containing exactly: hello` | 1 | 262.5s | 无 tool 事件；探针文件不存在；`permission_denials:[]`；10×429 |

重试政策执行：stream 成功路径按约束用满初始+2 次重试；#6/#7/#8 各只做 1 次——429 已持续约 70 分钟（16:03Z–17:12Z），对同输入重复重试只会消耗配额而不产生新证据（约束 5 的"最多 2 次"为上限而非义务，如实记录而非刷次数）。

## 5. 关键协议发现（已落入解析器与 fixture）

1. **`result` 陷阱（最重要）**：真实 CLI 在 API 失败时给出 `type:"result"`、`subtype:"success"`、`is_error:true`、`terminal_reason:"api_error"`、exit 1。synthetic 近似假设错误子类型形如 `error_*`——真实形态下判定必须且已经以 `is_error` 为准（`packages/cli-events/src/normalizer.ts` 的 `claudeResult`），contract 测试显式钉住"subtype 为 success 仍判失败"。
2. **内部重试可见**：429 时 CLI 自己最多重试 10 次（`api_retry` 事件，含 `attempt/max_retries/error_status/retry_delay_ms`），单次调用可拖到 4 分钟；400 则立即终止不重试。规范化映射：`api_retry` → diagnostic `api-retry`（不视为进展）。
3. **API 错误占位消息**：assistant 行可带 `is_api_error_message:true`，`message.model` 为字面量 `"<synthetic>"`，text 以 `API Error:` 开头。映射为 `message_delta` 时载荷带 `apiError:true`，供下游区分模型输出与本地占位。
4. **非交互 `result` 无 `structured_output`**：平凡提示词的真实成功流不会携带业务结构化负载（本次因 429 未能采集成功样本，但 #2/#4/#5 的 result 行均无该字段，且 fake-cli 契约与 docs/CLI_ADAPTERS.md 的成功条件要求业务 schema 有效）。推论（写入 README）：**产品要判业务成功必须显式要求结构化输出契约**，否则真实平凡运行一律 fail-closed（`business-schema-invalid`）。
5. **init 元数据丰富**：`claude_code_version`、`permissionMode`、`apiKeySource`、`cwd`、`tools`/`mcp_servers`/`slash_commands`/`skills`/`agents`/`plugins` 清单、`memory_paths`、`messaging_socket_path` 等。映射为 `started` 事件的可选载荷（版本/权限模式/cwd/authSource/工具与 MCP 数量）。
6. **hook 事件是真实流一部分**：宿主配置的 SessionStart hook 以 `hook_started`/`hook_response`（含 exit_code/outcome）出现在协议流里 → diagnostic `hook-started`/`hook-response`。两次调用 hook 数量可变（2 对或 1 对），解析器不能假设其存在或数量。
7. **resume 语义**：`--resume <id>` 下 init 的 `session_id` 保持原值（非新 session）。
8. **模型名不做参数层校验**：任意串被接受并透传，仅 stderr 警告 `unrecognized_model`；无效名在网关层 400。

## 6. 隐式环境加载观察（A35 / docs/CLI_ADAPTERS.md「隐式行为控制」相关）

init 事件显示 CLI 在非交互 `-p` 下隐式加载了宿主级配置：9 个用户级 MCP server（部分 `connected`，且两次调用连接集合不同）、13 个 agents、133 个 skills、4 个 plugins、SessionStart hooks，以及 171 个 slash commands。`result` 事件带有 `subagent_stats`（含 `refused: depth_limit/concurrency_limit/budget` 计数字段，本次全 0）。结论：**原生子 Agent/MCP 的额外执行入口在真实环境默认存在**，M0-06 的 capability gate 必须将其纳入受控/计费/拒绝设计，不能假设裸 `-p` 是干净的。

## 7. A19 / A33 / A35 方向的记录

- **A19（无 interactiveApproval）**：`-p` 非交互流中从未出现 `control_request(can_use_tool)` 审批请求（synthetic 扩展形状在真实 2.1.278 非交互模式下未观察到）；默认权限拒绝的实际行为本次未能观察（见 3#3）。产品侧应按 docs/CLI_ADAPTERS.md 采用"节点检查点"，不伪造中途暂停。
- **A33（凭据共享/并发）**：本机认证形态仅能从 init 的 `apiKeySource:"none"` 间接观察；按约束未探测凭据配置。**不标记 verified**，认证锁并发设计维持 M0-06 待办。
- **A35（CLI 内部子 Agent/MCP 额外执行）**：见第 6 节，真实证据已采集。

## 8. 交付物与测试

| 交付物 | 说明 |
|---|---|
| `packages/cli-events/fixtures-real/claude/*.real.jsonl`（5 个） | 脱敏真实流：429 错误、无效模型 400、resume、有效模型回显、权限探针 |
| `packages/cli-events/fixtures-real/claude/manifest.json` | `real:true / synthetic:false`，逐 fixture 记录 argv、退出码、时长、stderr、事件序列期望、脱敏规则、行为注记 |
| `packages/cli-events/test/real-fixtures.test.ts`（17 条测试） | 事件序列/outcome 与 manifest 逐条比对（含随机分片重放 A05 方向）、subtype 陷阱钉死、resume/模型/权限行为断言、**脱敏自检**（无用户名路径、无 uuid 形状、`<redacted-N>` 存在） |
| `packages/cli-events/src/normalizer.ts` 扩展 | 第 5 节全部映射；均为新增分支/可选字段，synthetic 路径不变 |
| `packages/cli-events/README.md` 增补 | 「真实协议映射（M0-03 实测）」一节 |

脱敏规则（manifest 同步记录）：运行期标识（session_id/uuid/hook_id/message.id/socket 路径）→ `<redacted-N>`（不同值不同占位符、相同值相同占位符，保持流的真实区分度以免触发管道的重复行去重）；路径中 Windows 用户名（反斜杠、正斜杠、连字符 slug 三种形态）→ `<user>`；hook 响应正文（第三方内容）整体替换；init 大数组截断为 3 项 + `<truncated:N-of-M>` 标记（原始数量记 manifest `inventorySizes`）。已确认 fixture 中无任何 token/key（真实输出中本就未出现凭据）。

## 8.1 验证管道实测结果（本次实际执行）

| 命令 | 退出码 | 结果 |
|---|---|---|
| `pnpm typecheck` | **0** | turbo 5 tasks successful |
| `pnpm test` | **0** | contracts 44 + fake-cli 23 + cli-events 114 = **181 passed / 0 failed**（既有 164 全部保持通过；新增 17 条真实 fixture contract 测试） |
| `pnpm build` | **0** | 3 tasks；turbo 首跑报 cache hit，已用 `--force` 强制重建复核（exit 0，0 cached），并核对 `dist/normalizer.js` 确含新映射（`api-retry`） |
| `pnpm run planning:check` | **0** | 78 个冻结文件 sha256 校验通过（含 `scripts/validate_bundle.py` 冻结值）；临时副本中 self-test exit 0——冻结面未被本次改动触碰 |

## 9. 未验证项与风险

1. **成功推理路径**（stream 成功形态、`structured_output` 实际出现条件、成功流 usage/成本字段取值）：上游 429 限流贯穿本次验证窗口（8 次调用中 5 次推理级调用全部 429）。影响：成功路径的解析映射目前只有 synthetic 近似 + 错误流侧证；CLI 恢复后应按本报告台账补采（M0-06 前完成）。
2. **默认权限下的工具拒绝行为**：完全未观察。风险：adapter 的 permission_denied 归一化路径（synthetic 的 `control_response(permission_denied)`）与真实拒绝形态（预计为 tool_result 错误文本 + `result.permission_denials` 数组）尚无真实对照。
3. **resume 语义连续性**、**有效模型推理**：同因未验证。
4. 真实流中 hook 数量、MCP 连接集合在调用间可变（已观测），依赖其确定性的设计需防御。
5. 本报告不改变 docs/ 冻结内容；CLI_ADAPTERS.md 中"control_request→approval_requested"映射在真实非交互模式下未获证，属于 M0-04/M0-06 需重新审视的点。

## 10. 结论

M0-03 的检查单在真实 CLI 2.1.278 上执行完毕：版本、事件流形态（错误/重试路径）、resume 参数行为、模型设置接受度 **verified**；成功推理路径与默认权限下的实际拒绝行为因持续 429 **unverified**（非认证问题，无 blocked 项）；缺失能力未被伪造为支持。全部脱敏 fixture 与 contract 测试已进入既有测试管道。

## 11. 补采附录（M0-06 执行，2026-09-22）

按第 9 节第 1 条的补采排期，M0-06 任务在本机对「stream 成功路径流形态」执行了补采。约束与第 2 节相同：系统临时目录下新建 scratch（`mktemp -d -t m06-claude-success-XXXX`，不在仓库内）、提示词自拟平凡（`Reply with exactly OK`，经 stdin）、无任何额外参数、**最多 2 次尝试**；未使用跳过权限参数，未读取/修改任何 auth/config。

| 尝试 | argv（cwd=scratch，提示词经 stdin） | 退出码 | 时长 | 结果摘要（脱敏） |
|---|---|---|---|---|
| 补采 #1 | `claude -p --output-format stream-json --verbose` | 1 | 238s | 17 行流：hook×2 对 + init + `api_retry`×10（**9×429 + 1×502**）+ assistant API 错误占位（`is_api_error_message:true`，第 10 次为网关 502「上游请求失败 (Connect)」，提示检查本机推理网关回环地址——报告不引用具体端口）+ `result`（`subtype:"success"`、`is_error:true`、`terminal_reason:"api_error"`）。assistant 行时间戳 2026-09-21T20:00:58Z |
| 补采 #2 | 同 #1（上限内最后一次） | 1 | 202s | 17 行流，同形态；`api_retry`×10 全部 429；stderr 均为空 |

两次尝试均失败，**成功推理路径流形态维持 unverified**。按约束不超限重试，未产出 fixture（`packages/cli-events/fixtures-real/claude/` 仍为 5 个）、未改动 contract 测试；scratch 目录已删除（未脱敏数据不入库）。

补采期间的补充观察（不改变第 5 节结论，供 M1 参考）：

1. 错误路径的 `result` 行 usage 全为 0、`total_cost_usd:0`、`permission_denials:[]`、`subagent_stats` 全 0——错误路径的「0 值」不可作为用量/费用记录（A37 方向：缺失/无效 usage 应记 unavailable/unknown，不记 0）。
2. 网关错误出现新变体 502（上游连接失败），与 429 同样走满 10 次内部重试后以 `terminal_reason:"api_error"` 终止——解析器的 `api_retry`/`api_error_status` 处理对 5xx 同样适用，无需新映射。
3. 429 窗口从 2026-09-21 16:03Z 持续到 2026-09-21 20:05Z（约 4 小时，跨 M0-03 验证窗口与本次补采）；后续补证应选择低峰窗口并保持每次调用台账记录。
