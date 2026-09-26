# @role-orchestrator/implicit-verify

M4-06 — CLI 隐式配置与代理预算验证（`docs/ACCEPTANCE.md` A34/A35；`docs/BACKLOG.md`
M4-06，依赖 M4-05）。**纯验证包：不含任何产品逻辑，不 spawn 任何 CLI（既不调用真实
claude/codex，也不读取任何凭据或 CLI 配置文件内容）。**

## 验证边界（务必先读）

- **数据面（真实 CLI 行为）不在本包验证范围。** CLI 内部子 Agent/MCP/hooks 的真实
  隐式加载行为属 M0-03/M0-04 实测证据及其拓展（或未来里程碑）：
  - claude init 实测隐式加载 **9 个用户级 MCP server、13 个 agents、133 个 skills、
    4 个 plugins、171 个 slash commands**，SessionStart hook 事件真实出现在协议流，
    `result.subagent_stats` 带 refused 计数字段（`reports/M0-03-claude-capability.md`
    第 6/7 节）；
  - codex exec 流内 item error 直接提示 **skills context budget**（skills/plugins
    隐式加载的直接证据），而 **MCP 清单在流中不可见——流不可见 ≠ 未加载**
    （`reports/M0-04-codex-capability.md` 第 6/7 节）。
- **本包验证的是控制面对这种不可见性的处理**：capability-gate 的 unverified/blocked
  状态、调度配额与预算的计数边界、runtime-profile 的漂移检测与冻结快照语义。真实
  命令的退出码与盘上证据记录在 M0 报告与 `packages/cli-events/fixtures-real/`，
  本包把它们作为冻结事实重新数据化并钉住控制面结论。
- **A34「执行前阻止」的组合点**：漂移检测原语（`detectExternalConfigDrift` /
  `checkRunProfileDrift`）与冻结快照读路径（`readRunRoleProfile`）由本包验证；
  把它接入未来执行层的 spawn 之前属后续里程碑。测试中的「不启动」是验证组合层的
  拒绝判定，不是引擎 wiring。

## 包内容

- `src/evidence.ts` — 冻结的 M0-03/04 数据面事实（上述清单）+ A35 capability 单元
  与 blocked 假设的期望状态表（registry 弱化即测试翻红）。
- `src/control-plane.ts` — 只读探针，组合既有控制面：
  - `evaluateUnattendedWriteDecision(runtime)` — 无人值守写决策：入口能力 +
    unattended-write 单元 + 隐式加载控制单元 + blocked 假设 + 调度层
    `evaluateDispatchGate`，当前 registry 下恒拒绝；
  - `evaluatePreStartDriftGate(db, runId)` — A34 漂移→拒绝启动的组合判定；
  - `quotaLedgerCensus(db)` — 配额账本普查（经 scheduler 自有读 API）。

## 验收映射

| 验收 | 内容 | 本包钉住的结论 | 测试 |
|---|---|---|---|
| A35 | CLI 内部子 Agent/MCP 发起额外执行：受控/计费/拒绝；不绕过 DAG 配额 | 隐式加载观察单元 verified 而显式管理/控制单元 unverified（unknown-deny）；无人值守写单元 blocked；`codex.default-mode-unattended-write`、`claude.mid-run-approval-in-noninteractive`、`implicit-loading.unmanaged-clean-baseline` 三条假设 blocked（node-checkpoint / explicit-management）；需要 unverified 能力的真实调度派发被 GATE_BLOCKED——零配额授予、零 execution、零节点迁移、零 dispatch outbox | `test/a35-data-plane.test.ts`、`test/a35-unattended-gate.test.ts` |
| A35（预算边界） | 调度配额/预算/usage 只对编排器 dispatch 的 execution 计数 | `quota_grants`、`execution_usage` 对 `executions` 的外键使非派生活动无法入账（类型化拒绝，账本零残留）；预算消耗随 dispatch 精确推进、耗尽后下一个编排器派发被拒——CLI 内部活动没有任何配额条目，不可计费即不可放行无人值守 | `test/a35-budget-boundary.test.ts` |
| A34 | Profile/model/宿主 config 执行中变化：检测漂移；原 run 不隐式更换 | 内容变化（hash 变化）/缺文件/超大文件/凭据名全部被检出（凭据名在登记期拒绝，永不 baseline）；漂移→组合层拒绝启动且调度账本零残留；恢复原字节后基线可复现；执行中（配置改写 + 绑定改指 + 新 revision 出现）冻结快照与 config hash 逐字节不变，漂移只作为 finding 报告；enqueue/dispatch 消费冻结 profile（queue 行、outbox 载荷、配额键）；快照行被篡改时完整性校验失败而非静默读取 | `test/a34-prestart-drift.test.ts`、`test/a34-frozen-run.test.ts` |

## 运行

```bash
pnpm test        # 本包：5 个 vitest 文件、29 个测试
pnpm typecheck
pnpm build
```

测试数据库为临时目录中的真实 SQLite（组合迁移链 001..004 + 014，组合模式同
`@role-orchestrator/scheduler` 测试助手），宿主配置 fixture 为系统临时目录内的
synthetic 文件（内容非凭据、非真实 CLI 配置）。本包不新增任何数据库迁移。
平台门控：无（不 spawn 进程、不依赖 win32 专属机制），无 skip。既有各包的
测试不受影响。

## 依赖的既有控制面（本包不重复实现）

- `@role-orchestrator/capability-gate` — verified/unverified/blocked 状态数据与
  fail-closed 查询（`statusOf` / `checkAssumption` / `isUsable`）；
- `@role-orchestrator/scheduler` — 派发能力门、配额授予（fencing + 全有或全无）、
  `quota_grants` 外键；预算/usage 由 `@role-orchestrator/budget` 提供（A37：
  未知 usage 记 unavailable，绝不写 0）；
- `@role-orchestrator/runtime-profile` — A34 不可变半（`run_profile_snapshots` +
  `readRunRoleProfile`）与检测半（`getRunBindingDrift` / `detectExternalConfigDrift` /
  `checkRunProfileDrift`）。
