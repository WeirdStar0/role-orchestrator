# M8 开发批次报告：M8-02 模型性能统计 + M8-03 桌面壳 ADR

日期：2026-09-28 · 执行角色：Developer · 基线：main 2c02fcd（1548 测试 /
35 workspace 项目 / 外部依赖 84）

## Summary

两项任务全部落地：

- **M8-02**：新建 `packages/model-stats`（第 36 个 workspace 项目）——
  zod strict 的 `UsageEvent` 契约（费用字段为 `z.literal("unknown")`，
  契约级未知）；claude stream-json / codex `exec --json` 双方言 hermetic
  JSONL usage 提取器；只追加 `PerformanceStore`（内存 + watermark 追加
  JSONL 文件持久化，加载逐行 strict 复验 fail-closed）；`report()` 只读
  接口（纯渲染 + 类表面封闭 pin + 决策词表检查）；`BudgetRefinement`
  预留 stub（恒返回 `status: "stub"`）。解析器以
  `packages/cli-events/fixtures-real/m8-01-2026-09-28/` 的真实脱敏捕获做
  契约测试（只读引用），全程未调用真实 CLI。
- **M8-03**：新建 `reports/M8-03-desktop-shell-adr.md`（Proposed，初版可
  推翻）——Electron / Tauri v2 / Neutralino.js 五维对比（体积/内存/安全
  模型/Windows 兼容/与 local-api 契合度），初版推荐 Tauri v2（capability
  默认全拒恰合「壳不超出页面权限」硬约束）；威胁建模（进程注入/IPC 劫持/
  本地提权）与缓解；通篇标注【假设】/【待实测】；明确「仅 ADR 未实现」；
  local-api 引用均落到真实代码（`guard.ts` 五条守卫、`token.ts` per-user
  0o600 令牌文件）。

## 实际变更文件

新增：

- `packages/model-stats/`（package.json、tsconfig.json、tsconfig.build.json、
  vitest.config.ts、README.md、src/{index,schema,parse,store,report,budget}.ts、
  test/{helpers,schema,parse-claude,parse-codex,fixtures-real,store,budget}.test.ts；
  dist/ 为本地构建产物，仓库 .gitignore 第 2 行忽略之，不入库）
- `reports/M8-03-desktop-shell-adr.md`
- `reports/M8-BATCH.md`（本文件）

修改（登记面，均已在 PROPOSALS.md 2026-09-28 节披露）：

- `packages/release-audit/test/repo-audit.test.ts`：`workspacePackageCount`
  断言 35→36（ask 第 7 条点名要求的登记）
- `packages/boundary-audit/src/core-manifest.ts`：`OPEN_CORE_PACKAGE_MANIFEST`
  追加 `@role-orchestrator/model-stats`（34→35 名）+ 头注释扩记
- `pnpm-lock.yaml`：新增 model-stats importer（`pnpm install` 自动产物）
- `PROPOSALS.md`：追加「基线披露：M8 开发批次」节

冻结面（CHECKSUMS 78 文件、docs/、schemas/、config/、prompts/、project/、
contracts/、tools/、scripts/、.github/）零改动；fixtures-real 只读引用，
未修改其中任何文件。

## 实际执行的验证（真实退出码）

| 命令 | 退出码 | 结果 |
|---|---|---|
| `pnpm install` | 0 | Scope: all 36 workspace projects；resolved 84 / added 0（外部依赖零变化） |
| `pnpm typecheck`（repo 根，turbo） | 0 | 58 tasks 全过 |
| `pnpm test`（repo 根，turbo） | 0 | **1593 测试全绿**（1548 基线 + model-stats 45），35 包无失败 |
| `pnpm build`（repo 根，turbo） | 0 | 35 build tasks（model-stats 构建产物另经单包 `pnpm build` 实跑 exit 0 复核） |
| `node planning-check.mjs` | 0 | CHECKSUMS 78/78 匹配；validate_bundle 自检（temp 干净副本）exit 0，selfTestsPassed 37 |
| `pnpm test`（model-stats 单包，开发中间态） | 1→修复→0 | 中间态 1 失败（见下「设计记录」#1），修复后 45/45 |

测试计数：**+45**（schema 8 / claude 解析 10 / codex 解析 7 / 真实 fixture 4 /
store 12 / budget stub 4），全仓 1548 → **1593**。

## 设计记录（实现决定）

1. **claude assistant 行是嵌套 `message` 结构**：真实捕获
   （`claude-c1-stream.jsonl`）的 assistant 事件把 `model`/`usage` 嵌在
   `message` 键下（result 行则是顶层 usage/modelUsage/duration_ms）。首版
   解析器按顶层读取，真实 fixture 测试抓出该错误（45 中唯一一败），已修正
   为读 `message` 内层并对顶层拍平形态保留容忍回退。
2. **默认只提取 result 行**：真实捕获里 assistant 行 usage（output 8）与
   result 行回合汇总（output 12）真实不等、model 串也不同
   （`claude-opus-5-5` vs `claude-opus-5[1m]`）；同回合并报会重复计数。
   默认取 result 行（权威回合汇总，含 duration），assistant 级提取为
   `includeAssistantEvents` 诊断项——两个数字都以测试钉在真实捕获上。
3. **codex 无 model id / duration**：`turn.completed` 只带 usage 四元组；
   modelId 由调用方显式传入（spawn 方知道调用的模型），缺省落到显式哨兵
   `"unknown"`（独立聚合桶，不冒充真实模型）；duration 恒 null 不造 0；
   `reasoning_output_tokens` 不并入 outputTokens（无法从捕获确认是否已含，
   不猜）。真实 X1 捕获钉值：input 56522 / cacheRead 4096 / cacheWrite 0 /
   output 12。
4. **费用结构性不可见**：源行自带 `total_cost_usd`/`costUSD`
   （c1 捕获：0.111661），提取器按 ask「契约级 unknown」要求将其丢弃，
   schema 层 `z.literal("unknown")` 使任何数字形态都无法入约；测试断言
   序列化结果不含自报价格。
5. **性能统计无调度语义**：store 类表面封闭 pin
   （append/appendMany/events/flushToFile/report/size/summaryByModel，
   无 update/delete/reset/recommend）；报告决策词表（switch/reroute/
   recommend/prefer/fallback）只允许出现在禁止性尾注一行。

## 偏离与登记（全部披露于 PROPOSALS.md 2026-09-28 节）

ask 允许改动面未逐一列出的两处**机械登记**，均为包增量的强制后果、沿
M6-04→M7-04 先例：

- `packages/release-audit/test/repo-audit.test.ts` 35→36（ask 第 7 条本身
  点名要求）；
- `packages/boundary-audit/src/core-manifest.ts` 扩名（其 R4a 规则设计为
  「新增包不扩名即 drift」，封闭清单不可静默过期）。

`.spec-workflow/`（未跟踪目录）非本批次产物，未纳入提交、未修改。

## 未验证项 / 风险

- **未验证**：真实 CLI 端到端提取（红线 3 禁止本批次调用真实 CLI）；解析器
  的真实性由 M8-01 真实脱敏捕获的契约测试承载（4 项，含两方言各一线）。
- **未验证**：更多真实捕获形态（resume/perm/cancel 等 16 个 fixture 未全数
  入契约测试；本批按 ask 点名只 pin c1 + x1）。风险：后续捕获如出现
  `result` 行无 usage / 多 modelUsage 键等形态，已有对应分支与显式
  sentinel，但未经真实数据验证。
- **风险**：claude「assistant vs result 数字不等」的语义解释（回合汇总 vs
  消息级）基于捕获观察，若未来 CLI 改变 result 语义，聚合口径需重审——
  真实 fixture 契约测试会在彼时红。
- **M8-03**：ADR 全部对比数字标注为公开文档口径的【假设】，五项【待实测】
  已列入 ADR「验证与回退」；推荐（Tauri v2）可被推翻，条件成文。

## Artifact 引用

- 实现：`packages/model-stats/src/`（schema/parse/store/report/budget）
- ADR：`reports/M8-03-desktop-shell-adr.md`
- 披露：`PROPOSALS.md`「基线披露：M8 开发批次（2026-09-28）」节
- 提交：见 git log（本批次 commit，推送 main）
