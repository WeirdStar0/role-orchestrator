# CLI Adapter 设计与兼容验证

## 已核实的最小接入面

Claude Code：`claude -p` 提供非交互调用，可配置 JSON/stream-json 输出。
Codex：`codex exec --json` 提供非交互 JSONL 事件。
官方说明见 [S01](SOURCES.md#s01)、[S02](SOURCES.md#s02)。
实际参数与协议受版本影响，M0 必须记录实测版本，不以页面说明代替 Windows 联调。

下列命令只说明入口形态，不是可直接投入生产的权限配置：

```text
claude -p --output-format stream-json --verbose
codex exec --json
```

Adapter 在参数数组中注入经过授权的模型和权限参数，提示词通过 stdin 或受控文件输入，
不把用户文本拼成 shell 命令。默认不启用自动跳过权限的参数。
Claude 的 bare 等运行模式会改变配置和认证加载行为，不能在订阅登录 Profile 上盲目启用。
保留 CLI 的系统/组织管理约束，不通过覆盖参数取消上级安全策略。

## 统一接口

```text
probe(profile, executionTarget) -> CapabilityReport
prepare(executionRequest) -> PreparedInvocation
start(preparedInvocation) -> ExecutionHandle
events(handle) -> AsyncIterable<NormalizedEvent>
cancel(handle, policy) -> CancellationResult
resume(request) -> new ExecutionHandle (仅 capability verified)
reconcile(executionRecord) -> RecoveryAssessment
```

Profile resolution、风险分级和审批在 adapter 上层完成。
Adapter 不能自行改用另一个 Profile，不能因启动失败增加危险参数。
命令、版本、受信任配置、stdin hash 和输出文件清单写入 Execution manifest。

## 事件规范

规范化事件包括 started、message_delta、tool_started、tool_completed、
permission_denied、approval_requested、usage_reported、artifact_reported、
result_reported、process_exited、error、diagnostic。
原始 CLI 事件类型保存在 sourceType；不认识的事件作为 diagnostic 保存，
不能因未知类型误判 success，也不能依赖抓取 TUI 文本当主要协议。

JSONL 解析器必须覆盖分片行、多字节 UTF-8、空行、超长行、混杂 stderr、
末尾不完整 JSON、重复事件和最终事件丢失。
限制单行大小、总日志大小和内存队列；背压不会把 daemon 内存耗尽。
默认对日志脱敏；保留“不记录”的敏感字段，不把它们先写入 raw.log 再脱敏。

成功条件至少为 exitCode=0、最终结果无 error、业务 schema 有效、
要求的 artifact/commit/test evidence 存在。不仅检查退出码。

## 审批能力不可假定一致

优先采用各 CLI 经过验证的原生结构化审批/控制通道。
没有可靠 interactiveApproval 时采用“节点检查点”：
Agent 输出结构化 action proposal -> CLI 结束/安全停止 ->
系统等待用户/授权决策 -> 创建有限授权的新 Execution。
不能从日志里看见一个危险命令就声称已经阻止其执行。

高风险动作必须在执行之前取得授权。无法拦截或无法证明权限边界时不启动该动作。
任务澄清与权限提权分开：Coordinator 可以回答业务问题，不能替代用户授予系统权限。
后续 Codex app-server 或 SDK 桥接需另立 ADR，不混淆为当前已实现 CLI 能力。

## 隐式行为控制

显式管理 CLI 自动读取的仓库指令、hooks、MCP、plugins 和内部 subagents。
外部配置必须有清单与 hash，仓库来源未经用户信任前不启动带执行权限的 CLI。
CLI 原生子 Agent 若不能被禁用或纳入预算，不启用无人值守并发模式。
Memory/Artifact bridge 可用 adapter 内受控 hooks/MCP 实现，但不改变核心编排协议。

## 测试策略

Fake CLI 在 PR CI 中模拟两种方言；数据是 synthetic，不冒充真实 CLI 采集。
真实 smoke tests 在用户已认证的可信机器上显式执行，保存脱敏 fixtures 与版本。
升级 CLI 必须重新测试 parsing、模型解析、审批、会话恢复、子进程终止和环境隔离。
未知版本先标记 unverified；不是把语义化版本号大于某值当做兼容证明。
