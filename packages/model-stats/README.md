# @role-orchestrator/model-stats

M8-02：模型性能统计的**只读**基础设施。

## 边界（与 M8 ask 一一对应）

- **统计只读**：本包不参与、不影响任何调度决策；没有选择/切换/回退模型的 API，
  报告渲染与类表面都有测试钉死。
- **费用契约级 unknown**：仓库没有获批的费率数据源；CLI 自报的价格
  （如 claude result 行的 `total_cost_usd`）不是价格 oracle，提取时被结构性丢弃。
  `UsageEvent.costUsd` 是 `z.literal("unknown")`，不存在数字表示。
- **hermetic**：解析器只用真实脱敏捕获做测试（`packages/cli-events/fixtures-real/`
  的 M8-01 受控窗口 + `packages/model-stats/fixtures-real/` 的 M8-01 补窗口 7 个
  jsonl），从不调用真实 CLI。
- **只追加**：`PerformanceStore` 只有 append；文件持久化是 watermark 追加 JSONL，
  从不改写既有内容；加载时逐行按 strict schema 复验，坏行 fail-closed。
- **BudgetRefinement 建议（只读，M8-04）**：二态 `ready | insufficient-data`。
  ready 时按观测分布给出 per-model 建议——单回合输出 token 上限=每回合
  outputTokens 的 nearest-rank P95（向上取整到 1000 档）、输入预算参考=每回合
  inputTokens（不含 cache 读/写）的 nearest-rank P50；每个建议值附推导口径
  （方法名 + 样本量 n）。样本不足（`MIN_SAMPLES_PER_MODEL = 5`）时
  insufficient-data 并逐 model 说明缺口。全部是 token 计数，无任何费用数字；
  建议非策略：采纳需维护者批准、另批处理，本包不触碰
  `@role-orchestrator/budget` 与 scheduler 的任何执行面。

## 事件提取语义（以真实 fixtures 钉死的事实为准）

- claude stream-json：`result` 行是回合权威汇总（usage + `duration_ms` +
  `modelUsage` 键名），默认只提取 result 行；assistant 行的 usage 与 result
  行真实地不相等（c1 捕获：8 vs 12 output tokens），同回合并报会重复计数，
  assistant 级提取仅作诊断项（`includeAssistantEvents`）。
- codex `exec --json`：usage 只在 `turn.completed`（`input_tokens` /
  `cached_input_tokens` / `cache_write_input_tokens` / `output_tokens`）。
  流内无 model id、无 duration——modelId 由调用方显式传入（spawn 方知道调的
  什么模型），否则落到显式哨兵 `"unknown"`；duration 恒 null，不编造 0。
- 源边界宽容（第三方方言增量演化，未读字段忽略），消费的每个字段都过 zod
  校验；坏行计入 `errors`，绝不静默吞掉。
