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
- **usage tee 适配器（M8-04，`createUsageSink`）**：把 engine
  `persistDrainedEvents` 旁路的脱敏 usage 行（`{ type: <保留的 sourceType>,
  usage }` 合成行）经既有方言提取器喂进调用方自建的 `PerformanceStore`。
  store 实例与文件路径由调用方显式创建传入，本适配器不建路径、不落盘；
  落盘后的 usage 载荷不含 model，归属由调用方显式给出
  （`claudeModelId`/`codexModelId`），缺失落显式哨兵 `"unknown"`，绝不猜。
  适配器诚实可抛错；fail-open 是 engine 侧的保证
  （sink 异常=一行 stderr 诊断，执行主流程零影响）。

## 事件提取语义（以真实 fixtures 钉死的事实为准）

- claude stream-json：`result` 行是回合权威汇总（usage + `duration_ms` +
  `modelUsage` 键名），默认只提取 result 行；assistant 行的 usage 与 result
  行真实地不相等（c1 捕获：8 vs 12 output tokens），同回合并报会重复计数，
  assistant 级提取仅作诊断项（`includeAssistantEvents`）。
- codex `exec --json`：usage 只在 `turn.completed`（`input_tokens` /
  `cached_input_tokens` / `cache_write_input_tokens` / `output_tokens`）。
  流内无 model id、无 duration——modelId 由调用方显式传入（spawn 方知道调的
  什么模型），否则落到显式哨兵 `"unknown"`；duration 恒 null，不编造 0。
  - TODO（M8-04 审查移交 M8 族，M8-05 批注记，留待后续批澄清）：
    codex 的 `input_tokens` 是否已剔除 cached 份额（即 `input_tokens` 与
    `cached_input_tokens` 是否互斥不重叠）未经真实样本验证——契约口径串
    （`src/schema.ts:30` "excludes cache reads"）与解析映射
    （`src/parse.ts:250-252`：`input_tokens`→`inputTokens`、
    `cached_input_tokens`→`cacheReadTokens`）都按「已剔除」假设书写。
    若真实语义是「含 cached 的总额」，该映射会重复计入 prompt 份额，
    input 口径与 P50 建议随之失真；澄清需采集 codex 真实 turn 样本对照
    （方法同 M8-01 补窗口），在口径串与映射两侧同步修正前，codex 侧
    input 口径维持 unverified。本 TODO 只注记，不改动任何口径串文本。
- 源边界宽容（第三方方言增量演化，未读字段忽略），消费的每个字段都过 zod
  校验；坏行计入 `errors`，绝不静默吞掉。
