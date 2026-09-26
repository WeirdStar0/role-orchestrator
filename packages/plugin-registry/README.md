# @role-orchestrator/plugin-registry

M7-02「设计受控插件与工具扩展」的契约包：版本化 manifest、权限 scope 声明、
可信来源分级与禁用策略。**仅设计，没有插件加载器**：本包没有任何读盘加载、
进程启动、网络连接或执行代码；交付的是契约 + 一切加载都必经的**唯一纯函数
判定入口**（`evaluatePluginLoad`）。设计文档见 `reports/M7-02-plugin-tool-registry.md`。

## 组成

- `src/manifest.ts`：版本化 manifest 严格 schema（strict semver 2.0.0、
  sha256 内容 integrity、闭枚举 scope 列表、发布方 trust 声明）与宿主侧
  信任清单记录（tier + disabled + recordedDigest 钉扎 + `manifestSha256`
  整份 canonical manifest 自钉；verified 必须带摘要钉）。文本字段拒绝控制
  字符与 Trojan-Source 双向覆盖符。HARDENING-1（审查 minor #1/#27）新增：
  `canonicalPluginManifestJson`（键递归排序、无空白、与 locale 无关的确定性
  canonical 序列化）与 `canonicalPluginManifestSha256`（对整份 manifest 值
  求 sha256）；清单记录的 `manifestSha256` 字段钉住宿主批准时的整份
  manifest，null 钉是判定拒绝不是豁免。
- `src/decision.ts` 新增第 8 步 `manifest-pin-mismatch`：重算呈现 manifest
  的 canonical sha256 与库存自钉比对，**任何 tier 都强制执行**——只改
  scopes/name/entrypoint/version 等字段而保留 artifact 与 digest 字段的
  篡改（原缺陷形态）从此必拒。判定顺序从 10 步扩为 11 步（拒绝语义只增
  不减：原 10 步的顺序与理由全部保留）。
- `src/scope.ts`：闭枚举 scope 词汇（repo.read / repo.write / git.read /
  tests.run / memory.propose），与 contracts 的 PERMISSION_IDS 一一恒等映射，
  并以数据形式引用 capability-gate 的 REQUIRED_CONTROLS；`budgetMetered`
  被 `z.literal(true)` 钉死——免计量 scope 在类型层面不可表达（A35）。
  刻意不含 dag.propose / decision.propose 与一切执行形 scope。
- `src/override-scan.ts`：原始输入上的覆盖词汇注入扫描（A02/A16 类推）。
  键名命中闭集（model/profile/role/permission/budget/approval/argv/env…）
  即拒；字符串值委托 capability-gate 的 `isBlocked`（同一份 M0-06 blocked
  argv 注册表，无漂移副本）。路径只由命中键名（闭集成员）与哨兵构成，
  不回显任何 manifest 文本。
- `src/decision.ts`：唯一判定入口。顺序即契约：注入扫描 → 严格 schema →
  kill switch（全局/按 id）→ 清单缺席即默认拒绝 → disabled → untrusted →
  trust 声明必须与清单一致 → **manifest 自钉（canonical 全文 sha256，任何
  tier 强制，HARDENING-1 新增）** → 双重 integrity 钉（产物 vs manifest、
  manifest vs 清单钉）→ scope 全部在宿主 allowlist 内 → accept。
  纯函数、无缓存接受——宿主必须逐次调用重估，禁用后下一次调用即被拒。
- `src/events.ts`：审计事件闭字段集（id/version/digest/tier/decision/
  reason/at）。manifest 自由文本在结构上不可达（A42/A36），未通过 schema
  的拒绝连 id 都不落事件。
- `src/errors.ts`：只有宿主接线错误才抛类型化错误（如 artifactSha256 非
  64 位小写 hex、verified 清单缺钉）；预期拒绝一律是判定值不是异常。

## 测试

`pnpm vitest run`（turbo `test` 任务自动纳入），全部 hermetic：纯函数 +
node:crypto 现算 sha256，无网络、无进程、无真实插件。覆盖全部决策分支：
未知字段、非法 semver、重复 scope、scope 超集、disabled/untrusted/kill
switch、trust 声明不一致、双重 integrity 不匹配、覆盖词汇注入（含嵌套/
数组/大小写/危险 flag 文本）、A42 事件无文本泄露、逐次重估禁用语义。

## 边界

- 本包不加载、不执行、不联网；真实加载器属后续独立任务，且必须逐次调用
  `evaluatePluginLoad` 并按拒绝值行动。
- scope→control 绑定是数据不是执行：enforcement 在执行层，本包让「漏声明
  计量/控制」不可表达。
- 信任分级由宿主清单决定，manifest 的 trust 字段只是发布方声明；两者不一致
  即拒绝（防调包/自封 verified）。

## 兼容性影响（HARDENING-1，破坏性变更，本包无外部消费者故可接受）

- 清单记录 schema 新增必声明字段 `manifestSha256`（sha256，可 null）：旧
  记录缺该字段会在严格 schema 处失败（宿主接线错误 `PluginDecisionInput-
  Error`），不会静默评估；`null` 钉可解析但判定必拒（`manifest-pin-
  mismatch`）——自钉没有 tier 豁免，与 `recordedDigest` 的 builtin 豁免
  不同。
- 判定输入不变（仍读 `inventoryRecord`），拒绝理由枚举新增
  `manifest-pin-mismatch`（闭枚举演进，审计事件 schema 同步覆盖）。
- `PLUGIN_MANIFEST_VERSION` 保持 1：**manifest 本身的形状一字未改**；变化
  全部在宿主侧库存记录与判定步骤，故无版本字段可递增。
