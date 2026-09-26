# M0-04 · Codex 非交互接入验证报告

状态：已完成（真实调用无认证障碍，检查单全部覆盖；无 blocked 项）。
对应任务：docs/BACKLOG.md `M0-04`（验收 A05/A19/A33/A35 方向）。角色：Developer。
日期：2026-09-22（本地时区 UTC+8，真实调用发生于本地 01:00–01:08，即 2026-09-21T17:0xZ）。所有结论绑定本报告记录的真实命令退出码；无任何手写 PASS。

## 1. 环境与实测版本

| 项 | 值 | 来源 |
|---|---|---|
| CLI | codex `0.154.0`（stdout 原文 `codex-cli 0.154.0`） | 本次实测，见调用 #1 |
| 安装形态 | npm 包 `@openai/codex` 0.154.0 → 平台包 `@openai/codex-win32-x64` 原生 `codex.exe`，经 mise shim 进入 PATH | 本次实测（`mise which codex` + 启动脚本核对） |
| OS | Windows 10.0.26100 x64，Git Bash（shell 层为 cmd.exe 宿主） | 本次实测 |
| Node / pnpm | v25.0.0 / 10.14.0 | 本次实测 |
| 运行目录 | 系统临时目录下新建 scratch（`mktemp -d -t m04-codex-scratch-XXXX`），不在仓库内；scratch 内 `git init`（见第 2 节） | 约束：真实调用不得在仓库目录运行 |
| 权限模式 | 默认模式：未使用任何 `-s/--sandbox`、审批或跳过权限参数 | 全部调用 argv |
| 认证 | 始终有效（无一次登录态失败）；错误文本间接显示账号类型为 ChatGPT account（未读取任何 auth/config 文件） | 调用 #6 的后端 detail 文本 |

## 2. 方法与约束遵守

- 全部真实调用都在 scratch 目录执行；提示词均为自拟平凡内容（`Reply with exactly OK` 等），经 stdin（`-` 占位）输入，未把仓库内容放进提示词。
- 未使用任何跳过权限参数（无 `--dangerously-bypass-approvals-and-sandbox` 等）、未执行登录/登出/凭据命令、未修改 CLI 配置、未读取 auth/config 文件内容。
- **环境门发现**：`codex exec` 默认拒绝在非 git 目录运行（调用 #2：exit 1，stderr `Not inside a trusted directory and --skip-git-repo-check was not specified.`）。为保持其余全部调用零额外参数、如实观察默认行为，在 scratch 内 `git init` 了一个一次性空仓库（不涉及本仓库任何 git 写操作），之后未再使用 `--skip-git-repo-check`。
- 真实调用共 **9 次**（预算 ≤10），逐次记录见第 4 节。无一次认证失败；无 429 限流（与 M0-03 窗口不同）。
- 产物：脱敏 fixture 5 个 + manifest（`packages/cli-events/fixtures-real/codex/`，`synthetic: false`）；contract 测试 `packages/cli-events/test/real-codex-fixtures.test.ts`（17 条）；解析器扩展 `packages/cli-events/src/normalizer.ts`（codexItem 新增 `error` item 映射，新增分支，synthetic 路径不变）。

## 3. 检查单逐项结论

| # | 检查项 | 结论 | 依据 |
|---|---|---|---|
| 1 | 版本记录 | **verified** | 调用 #1：`codex --version` → exit 0，stdout `codex-cli 0.154.0` |
| 2 | `codex exec --json` 事件流形态（平凡提示词，真实成功路径） | **verified** | 调用 #3：exit 0，15.9s，4 行 JSONL：`thread.started`（UUID 形态 thread_id）→ `turn.started` → `item.completed(agent_message "OK")` → `turn.completed(usage)`。真实成功流**没有**业务负载字段（synthetic 以 `execution_result` 扩展表达，真实不存在）→ fail-closed `business-schema-invalid`（CLI exit 0 ≠ 业务成功，已钉进 contract 测试） |
| 3 | 权限/审批行为（默认模式要求创建小文件） | **verified（默认行为）/ 无交互审批通道** | 调用 #4：exit 0，30.5s。要求创建的文件**被真实创建**（盘上验证 5 字节，内容 `hello`）：`command_execution` item 以 exit_code 0 完成；全程**无** `approval.requested`/`approval.denied` 事件。结论：exec 非交互默认模式会直接执行工作区内写入，不存在交互审批通道（A19 方向：产品侧必须用节点检查点，不能假定 CLI 会停下来等审批）；同一运行 stderr 出现与协议无关的内部 ERROR 行（`codex_memories_write::phase2`），管道正确地未将其解析为协议事件 |
| 4 | resume | **verified（参数形态 + 会话延续）** | 调用 #5：`codex exec resume <id> --json -`（id 在报告中以 `<redacted>` 表示）→ exit 0，13.5s；`thread.started` 原样返回**同一** thread_id（运行期比对为 True；脱敏后 fixture 中 base 与 resume 共用 `<redacted-1>` 占位符保留该证据）；会话延续有客观证据：恢复回合 `input_tokens` 49807 ≈ 平凡新会话基线 24895 的两倍（历史重放），且回答 `RESUMED` 与恢复后提示词一致 |
| 5a | `-m` 无效值行为 | **verified** | 调用 #6：`-m definitely-not-a-real-model-xyz` → **参数层不拒绝**：thread 正常启动，item 级 `error` 行 ×2（模型元数据回退警告、skills 预算提示）→ 顶层 `error`（后端 detail：`...model is not supported when using Codex with a ChatGPT account.`）→ `turn.failed`，exit 1，无 usage 事件。事件顺序注意：`turn.started` 出现在首个 item 之后（解析器不得假设顺序，测试已钉住） |
| 5b | `-m` 有效值行为 | **verified** | 调用 #9：`-m gpt-6-astra`（账号实际会话模型，以本次会话 rollout 元数据佐证）→ exit 0，正常成功回合，事件序列与默认模型基线（调用 #3）逐类型一致。对照：`-m gpt-5-codex`、`-m gpt-5.3-codex`（均存在于二进制模型目录）也被账号层以与无效名完全相同的 `turn.failed` 形态拒绝（调用 #7/#8）——**模型接受度按账号门控，与二进制目录无关** |

无 blocked 项：认证始终有效，9 次调用无一因登录态终止。

## 4. 真实调用台账（9 次）

| # | argv（cwd=scratch git 仓库，提示词经 stdin `-`） | 退出码 | 时长 | 结果摘要（脱敏） |
|---|---|---|---|---|
| 1 | `codex --version` | 0 | <1s | `codex-cli 0.154.0` |
| 2 | `codex exec --json -` ＋ `Reply with exactly OK`（**非 git 目录**） | 1 | 683ms | stdout 空；stderr `Not inside a trusted directory and --skip-git-repo-check was not specified.`；无配额消耗 |
| 3 | `codex exec --json -` ＋ `Reply with exactly OK`（git init 后） | 0 | 15.9s | 4 行流；`agent_message`＝`OK`；`turn.completed.usage`＝input 24895 / cached 0 / cache_write 0 / output 5 / reasoning 0 |
| 4 | `codex exec --json -` ＋ `Create a file named m0_04_probe.txt in the current directory containing exactly: hello` | 0 | 30.5s | `command_execution`（pwsh 写文件）started→completed exit_code 0；文件真实落盘；无审批事件；stderr 一条内部 ERROR（非协议） |
| 5 | `codex exec resume <redacted> --json -` ＋ `Reply with exactly RESUMED` | 0 | 13.5s | thread_id 与 #3 一致（True）；回答 `RESUMED`；input 49807 / cached 24704 / output 12 |
| 6 | `codex exec --json -m definitely-not-a-real-model-xyz -` ＋ `Reply with exactly OK` | 1 | 5.5s | item error ×2 + 顶层 error（`not supported ... ChatGPT account`）+ `turn.failed`；无 usage |
| 7 | `codex exec --json -m gpt-5-codex -` ＋ 同提示词 | 1 | 5.5s | 与 #6 完全同形态（该名不在账号授权内） |
| 8 | `codex exec --json -m gpt-5.3-codex -` ＋ 同提示词 | 1 | 5.9s | 同形态；仍带 `Model metadata ... not found` 警告（目录≠授权） |
| 9 | `codex exec --json -m gpt-6-astra -` ＋ `Reply with exactly OK` | 0 | 14.7s | 正常成功回合；事件序列与 #3 一致；input 24895（与 #3 基线相同） |

重试政策执行：检查单要求有效/无效各一次；`gpt-5-codex`（#7）为首次有效值尝试，`gpt-5.3-codex`（#8）为第 1 次重试（上限 2 次），随后改用会话 rollout 元数据佐证的 `gpt-6-astra`（#9）一次命中，未用满重试上限。总 9 次 ≤ 预算 10。

## 5. 关键协议发现（已落入解析器与 fixture）

1. **CLI 成功 ≠ 业务成功（最重要）**：真实 `turn.completed` 只带 `usage`（`input_tokens`/`cached_input_tokens`/`cache_write_input_tokens`/`output_tokens`/`reasoning_output_tokens`），**没有**业务负载字段；平凡真实成功流的 outcome 是 fail-closed 的 `business-schema-invalid`。产品要判定业务成功必须显式要求结构化输出契约（与 M0-03 claude 侧结论一致；README 已写明）。
2. **新增映射（唯一需要解析器改动的真实形状）**：`item.completed` 且 `item.type == "error"`（CLI 级消息：模型元数据回退警告、skills 预算提示、后端拒绝详情）→ 归一化 `error` 事件（`sourceType` 保留 `item.completed`，载荷含 `itemId`/`message`）。synthetic 无此形状，为新增 case 分支。
3. **失败形态与事件顺序**：账号层模型拒绝时流内出现 item error ×2 → 顶层 `error`（message 为 JSON 编码的 `{"detail":...}` 字符串，原样保留）→ `turn.failed`，exit 1、无 usage。`turn.started` 可出现在首个 item 之后——解析器不得假设事件顺序。
4. **与 synthetic 高度兼容**：`thread.started`→`started`、`item.completed(agent_message)`→`message_delta`、`item.started/completed(command_execution)`→`tool_started`/`tool_completed`（真实 started 行带 `exit_code: null`、`status: "in_progress"`，整体 item 拷贝已保留）、`turn.completed`→`result_reported`+`usage_reported`、`turn.failed`→带错误的 `result_reported`、顶层 `error`→`error`、`turn.started`→diagnostic：全部走既有映射无需改动。
5. **exec 流极简**：无 init/元数据行（对照 claude 的丰富 init），`thread.started` 只有 `thread_id`（UUID 形态）。cwd/模型/沙箱等不回显；隐式加载证据只能从旁证获得（见第 6 节）。
6. **stderr 混杂真实存在**：`codex_memories_write::phase2` 的内部 ERROR 行出现在 stderr，管道既有语义（诊断端口捕获、绝不解析为协议事件）经真实数据验证。
7. **环境门**：非 git 目录默认拒绝运行（exit 1 + stderr 提示），属启动前置失败而非模型错误。
8. **resume 语义**：`codex exec resume <UUID> --json -` 复用同一 thread_id；会话历史以 input_tokens 近翻倍的方式在计量上可见。

## 6. 隐式环境观察（A33 / A35 相关）

- **skills/plugins 隐式加载有直接证据**：调用 #6/#7/#8 流内的 item error 明确提示 `Skill descriptions were shortened to fit the skills context budget... Disable unused skills or plugins...` ——非交互 exec 默认加载了用户级 skills/plugins，即使事件流本体不显示清单。
- **MCP 清单不可见**：与 claude 的 init 不同，exec JSONL 流不携带 MCP server 清单/连接状态；本包事件面无法证明 MCP 是否加载。M0-06 的 capability gate 不能以“流里没有”推断“不存在”。
- **账号类型旁证**：后端拒绝 detail 文本提及 `ChatGPT account`（未读取任何凭据/配置文件）。Profile 目录分开但凭据共享的并发设计（A33）维持 M0-06 待办，本报告不标记凭据能力 verified。

## 7. A19 / A33 / A35 方向的记录

- **A19（无 interactiveApproval）**：exec JSONL 流中从未出现任何审批请求/拒绝事件；默认模式下工作区写入被直接执行（第 3 节 #3，已真实落盘验证）。结论：Codex exec 不提供交互审批通道，产品必须采用“节点检查点”（CLI 结束/安全停止后新授权 Execution），不得伪造中途暂停；且**不能假设默认模式会替产品挡住工作区写入**——本次实测它没有挡。
- **A33（凭据共享/并发）**：仅能从错误文本旁证账号类型；按约束未探测凭据配置。**不标记 verified**。
- **A35（CLI 内部子 Agent/MCP 额外执行）**：skills/plugins 隐式加载有直接流内证据（第 6 节）；MCP 清单在 exec 流中不可见（与 claude 不同的风险面）。M0-06 必须把“流不可见 ≠ 未加载”纳入设计。

## 8. 交付物与测试

| 交付物 | 说明 |
|---|---|
| `packages/cli-events/fixtures-real/codex/*.real.jsonl`（5 个） | 脱敏真实流：平凡成功、权限探针（写入被执行）、resume、无效模型 turn.failed、有效模型成功 |
| `packages/cli-events/fixtures-real/codex/manifest.json` | `real:true / synthetic:false`，逐 fixture 记录 argv、退出码、时长、stderr、事件序列期望、脱敏规则、行为注记；另记录环境门观察（调用 #2） |
| `packages/cli-events/test/real-codex-fixtures.test.ts`（17 条测试） | 事件序列/outcome 与 manifest 逐条比对（含随机分片重放 A05 方向）、business-schema-invalid 陷阱钉死、无审批事件断言（A19 方向）、resume 同 thread_id 断言、item error 映射断言、**脱敏自检**（无用户名路径、无 uuid 形状、`<redacted-N>` 存在） |
| `packages/cli-events/src/normalizer.ts` 扩展 | codexItem 新增 `error` item case（第 5 节 #2）；均为新增分支，synthetic 路径与既有 164 测试不变 |
| `packages/cli-events/README.md` 增补 | 「真实协议映射（M0-04 实测，codex-cli 0.154.0）」一节 |

脱敏规则（manifest 同步记录）：thread_id（运行期 UUID）→ `<redacted-N>`（相同值相同占位符——base 与 resume fixture 共用 `<redacted-1>` 保留“同一会话”证据）；路径类用户名替换规则就绪但本次无需使用（捕获流中经 `Users\star`/`Users-star` 模式核查均无用户名）；确认不含任何 token/key（真实输出中本就未出现凭据）。

## 8.1 验证管道实测结果（本次实际执行）

| 命令 | 退出码 | 结果 |
|---|---|---|
| `pnpm typecheck` | **0** | turbo 5 tasks successful（4 cached，1 executed） |
| `pnpm test` | **0** | contracts 44 + fake-cli 23 + cli-events 131 = **198 passed / 0 failed**（既有 164+17 全部保持通过；新增 17 条 codex 真实 fixture contract 测试） |
| `pnpm build --force` | **0** | 3 tasks，0 cached；已核对 `dist/normalizer.js` 确含新映射（codexItem `case "error"`） |
| `pnpm run planning:check` | **0** | (a) 78 个冻结文件 sha256 校验通过；(b) 临时副本（排除 node_modules/dist 等）中 `python scripts/validate_bundle.py --self-test` exit 0。另实测 `sha256sum scripts/validate_bundle.py` = `f829d286...342a6c`，与 `CHECKSUMS.sha256` 记录逐字节一致 |

## 9. 未验证项与风险

1. **多轮/长会话与 `item.started` 的其他 item 类型**：本次只观测到 `agent_message`/`command_execution`/`error` 三种 item 类型；文档化的 `mcp_tool_call`、`file_change`、`web_search`、`todo_list`、`reasoning` 等真实形状未在平凡提示词中出现，仍只有 synthetic 近似。平凡提示词故意不触发它们；后续接入 MCP/文件编辑场景时应补采（M0-06 前）。
2. **审批/沙箱拒绝路径**：默认模式未出现任何拒绝行为（写入直接成功），故 `approval.requested`/`approval.denied` 与沙箱拦截的真实形态（synthetic 扩展形状）仍无真实对照。未使用任何沙箱/审批参数——按约束此类行为探索需要产品层显式授权，本次不做。
3. **`--output-schema` 结构化输出**：真实 `turn.completed` 无业务负载的结论仅在平凡提示词下成立；`codex exec --output-schema <file>` 能否产出通过 `ExecutionResultSchema` 的业务负载未验证（涉及新参数与更多配额，超出本检查单）。
4. **resume 的边界**：仅验证了“从首个会话恢复一次成功”；fork（`codex exec fork`）、`--last`、恢复不存在 id 的报错形态未验证。
5. **模型名授权面**：`gpt-6-astra` 之外，本次实测的显式 `-m` 值全部被账号层拒绝；该账号可用的完整模型清单未探测（无本地列举命令，逐名试探浪费配额）。
6. 真实流事件顺序可变（`turn.started` 滞后）；依赖固定顺序的设计需防御（测试已钉住该顺序事实本身）。

## 10. 结论

M0-04 的检查单在真实 codex-cli 0.154.0 上执行完毕：版本、事件流形态（**含真实成功路径**，补上了 M0-03 因 429 缺失的对照面）、默认权限行为（写入直接执行、无审批通道）、resume 参数形态与会话延续、模型设置接受/报错行为全部 **verified**；无 blocked 项。真实流暴露的唯一解析器缺陷（item 级 `error` 类型）已以新增映射修复，synthetic 路径与全部既有测试保持通过，缺失能力未被伪造为支持。
