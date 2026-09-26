# HARDENING-1：M7 审查登记的三项最高风险 minor 修复报告

日期：2026-09-25 · 执行角色：Developer（Tier-1 加固批次） · 范围：`packages/plugin-registry`、`packages/boundary-audit`、`packages/scm-contracts` 三包源码与测试，`reports/` 新报告

本批次主题是**收紧边界**：三项修复全部是新增拒绝/新增覆盖，无任何放宽。
所有退出码为真实执行结果（命令原样记录于 §5）。

---

## 1. T1-1 plugin-registry：manifest 全文自钉（审查 minor #1/#27）

### 1.1 缺陷（修复前）

`decision.ts` 原第 8 步的双钉只比对 (a) 产物字节 vs `manifest.integrity.digest`、
(b) `manifest.integrity.digest` vs 库存 `recordedDigest`。攻击者篡改 manifest 的
`scopes`/`name`/`entrypoint`/`version`/`description` 等字段但**保留 digest 字段**
即可通过全部钉扎（builtin 层 `recordedDigest` 为 null 还可跳过 (b)）。篡改后的
scope 声明会直接改变授权面。

### 1.2 设计（已实现）

- **canonical 形式**（`src/manifest.ts` 新增导出）：
  - `canonicalPluginManifestJson(value)`：确定性 canonical JSON——对象键按
    UTF-16 码元序递归排序（**不用 localeCompare**，跨主机逐字节一致）、数组保序、
    无空白；
  - `canonicalPluginManifestSha256(manifest)`：对上述 canonical 字节（UTF-8）
    求 sha256（64 位小写 hex，`node:crypto` 现算，纯函数无 I/O）。
  - 钉的是**语义内容**而非文件字节布局：同一 manifest 的键序/空白差异不影响
    钉，任何值差异必影响钉。
- **库存 schema**：`PluginInventoryRecordSchema` 新增
  `manifestSha256: Sha256HexSchema.nullable()`（strict 常规：未知字段照旧拒绝）。
  语义刻意区别于 `recordedDigest`：`recordedDigest === null` 的 builtin 豁免
  **保留**，但自钉**在任何 tier 都不豁免**。
- **判定**（`src/decision.ts` 新第 8 步，顺序 10 步 → 11 步）：
  - 库存记录 `manifestSha256 === null` → 拒绝 `manifest-pin-mismatch`
    （"inventory record carries no canonical manifest self-pin"）；
  - `canonicalPluginManifestSha256(解析后的 manifest) !== record.manifestSha256`
    → 拒绝 `manifest-pin-mismatch`（"manifest as presented does not match the
    inventory canonical-manifest pin"）；
  - 旧记录**缺字段** → `PluginInventoryRecordSchema` 严格失败 →
    `PluginDecisionInputError`（宿主接线错误，不可能静默评估）。
- **拒绝理由闭枚举**：`PLUGIN_LOAD_REJECTION_REASONS` 插入
  `"manifest-pin-mismatch"`（trust-claim-mismatch 之后、integrity-mismatch
  之前）；审计事件 schema 的 reason 枚举随之覆盖（1:1 投影测试自动断言）。
- **版本字段**：`PLUGIN_MANIFEST_VERSION` 保持 **1** —— manifest 自身形状
  一字未改；变化全部在宿主侧库存记录与判定步骤，库存记录无版本字段可递增。
  **兼容性影响（破坏性，本包无外部消费者，可接受）**：旧库存记录缺
  `manifestSha256` 会在严格 schema 处失败（宿主错误，fail closed）；null 钉
  是判定拒绝值；判定输入形状不变。已同步写入包 README。

### 1.3 测试证据（全部真实执行，hermetic）

新增 9 个用例（plugin-registry 51 → **60**）：
- 原**缺陷形态**逐项必拒：篡改 scopes（扩大/清空）、name、entrypoint、
  version、description，而产物字节与 digest 字段不变 → `manifest-pin-mismatch`
  （修复前这些全部 accept）；
- 审批后改 `trust` 声明（tier 一致的 verified 记录）→ `manifest-pin-mismatch`；
- 呈现 manifest 与钉结构漂移（换 scope）→ 拒；
- **null 钉在任何 tier 都拒**（builtin 与 verified 双验），detail 含
  "no canonical manifest self-pin"；
- 记录缺字段 → `PluginDecisionInputError`（/decision input failed its schema/）；
- 正常路径全 tier 通过（builtin 与 verified，钉与呈现一致）；
- **canonical 性**：键插入序倒序重组同一 manifest → 仍 accept；
- 自钉先于 artifact 钉与 scope 检查命名拒绝（顺序钉住）；
- manifest-schema：字段可空、垃圾值拒、缺字段拒；
- audit-event：新拒绝理由进入 1:1 投影覆盖（破坏记录与内容漂移两种形态）。

原有 51 用例语义零弱化（见 §4 与 PROPOSALS.md 披露）。

---

## 2. T1-2 boundary-audit：optionalDependencies / peerDependencies 补扫（审查 minor #2）

### 2.1 缺陷（修复前）

边收集与 R1/R1b 只遍历 `dependencies`/`devDependencies`；商业包可经
optional/peer 通道进入核心而 verdict 仍 pass；R2 与 R5 也不覆盖这两节。

### 2.2 语义表（已实现；`DependencySection` 扩为四节）

| package.json 节 | 边语义 | R1 `commercial-dep-in-core` | R1b `commercial-devdep-in-core` | R2 `external-dep-outside-allowlist` | R5 `dangling-workspace-dep` | R3 环（硬运行时图） |
|---|---|---|---|---|---|---|
| `dependencies` | 运行时（startup path） | ✅ | — | ✅ | ✅ | ✅ 计入 |
| `optionalDependencies` | **运行时（optional runtime path）**：存在即被安装加载，是运行时边 | ✅ **新增** | — | ✅ **新增** | ✅ **新增** | ❌ 不计入（见下） |
| `devDependencies` | 构建（build path） | — | ✅ | ❌（dev/test 工具，维持 M7-04 语义） | ✅ | ❌ |
| `peerDependencies` | **构建/集成（peer/integration path）**：宿主需在核心集成面解析链接该包 | — | ✅ **新增** | ✅ **新增** | ✅ **新增** | ❌ |

- **peer 并入 R1b 而非新增规则**的论证：peer 与 dev 同属"非运行时依赖表"
  方向，合并保持闭拒绝词汇不膨胀；违规 detail 以
  `"peerDependencies"` + `"peer/integration path"` 与 dev 区分，信息不丢。
- **R2 覆盖 optional+peer** 的论证：optional 是运行时面（定义即然）；核心包的
  外部 peer 是宿主必须在安装期解析的外部集成面，同属核心引入的外部依赖面。
  R2 detail 现注明来源节（`via optionalDependencies` 等）。
- **R3 与 `runtimeWorkspaceEdges` 维持仅硬 `dependencies` 边**（非放宽：
  optional 边仍被 R1/R2/R5 检查；R3 原语义未变，经 optional 边的环不是硬启动
  环，且序列化输出与 R3 图保持 1:1）。
- 解析投影：`parseWorkspaceManifest` 投影四节；节非对象/说明符非字符串 →
  `ManifestParseError`（与既有节同规则）；缺失节 → 空 record。

### 2.3 测试证据（boundary-audit 26 → **34**，全部 hermetic fixture 树）

每条新覆盖通道都有"故意违规被抓到"+ 阴性用例（新增 8 个用例）：
- R1 via optional：核心 optional 依赖商业包 → `commercial-dep-in-core`，
  detail 含 "optional runtime path"；
- R1b via peer：核心 peer 依赖商业包 → `commercial-devdep-in-core`，
  detail 含 "peer/integration path"；
- R2 via optional+peer：两节各一个 allowlist 外外部依赖 → 双
  `external-dep-outside-allowlist`，detail 标注来源节；
- R5 via optional+peer：两节悬空 `workspace:` 引用 → 双
  `dangling-workspace-dep`，detail 标注来源节；
- **阴性**：allowlisted optional（zod）+ 指向核心 workspace 包的 peer + 核心
  peer allowlisted 外部 → verdict pass、零违规（不误报）；
- optional/peer 边不进 R3 环图（含 `runtimeWorkspaceEdges` 不变断言）；
- 含 optional/peer 边的树序列化确定性（两跑逐字节相等）+ 四规则齐发形态；
- 畸形节解析错误（非对象/非字符串说明符）。
- **真实树机制验证**：重建 dist 后
  `node packages/boundary-audit/dist/cli.js <repoRoot>` → 退出码 0，
  `verdict: pass`、34 workspace 包、0 违规（真实树无 optional/peer 节，扩展
  后仍全绿）。

---

## 3. T1-3 scm-contracts：消费后 transport 失败分支钉住（审查 minor #18）

### 3.1 缺陷（修复前）

`clients.ts` 的「消费成功后 transport 失败」分支（审批已 CAS 消耗、审计事件
`outcome: "failed"` + `detail: "transport failed after consumption (...)"`、
无收据、重试需新审批）**零测试**；helpers 的 transport mock 永远 resolve——
未来把 consume 挪到 transport 之后不会有测试变红，A17/A22 纪律可被静默反转。

### 3.2 实现（已实现；不改生产代码，只钉测试）

write-guard.test.ts 新增 2 个用例（write-guard 29 → **31**），全部走真实
approval CAS（SQLite 临时库）：

1. **分支行为钉**：transport `mockRejectedValueOnce(确定性测试错误类型
   FixtureTransportError)` → 断言 (a) 审批行 `CONSUMED` 且
   `consumedByExecutionId = exec-1`；(b) 恰一条事件
   `{outcome:"failed", refusalCode:"transport-contract", executionId:"exec-1",
   detail ⊇ "transport failed after consumption" ∧ "FixtureTransportError"}`；
   (c) 收据不存在（拒绝本身即无收据证明）；(d) 同 ApprovalRef 重试 →
   `ApprovalAlreadyConsumedError`、transport 仍只调 1 次、事件序列
   `[failed, refused]`。
2. **顺序可观察性钉**：事件**序列** `[failed(after consumption, exec-1),
   refused(approval-already-consumed), refused(approval-already-consumed)]` +
   `executionId` 序列 `[exec-1, null, null]` + transport 恒调 1 次——
   「先 transport 后 consume」的错误顺序下这些断言不可能全绿（见 3.3）。

### 3.3 顺序敏感性变异验证（真实执行）

将 `clients.ts` 临时变异为「先 transport 后 consume」（production 顺序反转
探针，仅存续一条命令）后运行两个新用例：
`vitest run test/write-guard.test.ts -t "HARDENING-1"` →
**2 failed | 29 skipped**（测试确实变红）；恢复原实现后同套件
**31/31 全绿**。证明了该用例组对顺序反转产生可观察差异，A17/A22 纪律不再
能被静默反转。

### 3.4 顺带修正

`reports/M7-01-scm-integration.md` §8 write-guard 计数笔误：27 → **29**
（该文件非冻结；本批次新增的 2 个用例计入本报告 §5 的新总数，不回写历史
报告）。

---

## 4. 既有测试改动（语义零弱化声明）

manifest 全文自钉使"呈现 manifest ≠ 钉定 manifest"成为新拒绝面，下列既有
用例**为保持原断言语义**（同一拒绝理由/接受结果）改为让库存记录钉住所呈现的
manifest——拒绝语义只增不减，无任何断言放宽：

- `plugin-registry/test/load-decision.test.ts`：verified 接受、digest 漂移
  （integrity-mismatch）、双钉接受、3 个 scope 授权用例（superset 拒、subset
  接受、空 allowlist 语义）——改用 `inventoryFor(presented)` 钉住所呈现
  manifest；
- `plugin-registry/test/audit-event.test.ts`：`input()` 基线改为钉住带敌意
  文本的默认 manifest；拒绝理由 1:1 覆盖表**追加** 2 个
  `manifest-pin-mismatch` 形态（broken/null 钉 + 内容漂移）。

完整披露见 `PROPOSALS.md` 末尾追加段。

---

## 5. 门禁结果（真实退出码）

| 命令 | 退出码 | 结果 |
|---|---|---|
| `pnpm install` | 0 | `Scope: all 35 workspace projects`；lockfile up to date；外部依赖恰 84 不变，workspace 包数 35 不变（`repo-audit.test.ts` 的 35/84 断言未改动且通过） |
| `pnpm typecheck`（全仓 turbo） | 0 | 57 tasks 全部成功（开发中途修复过本批次新增测试的 2 处类型错误后重跑） |
| `pnpm test`（全仓 turbo，默认并发） | 0 | 68 tasks 全部成功（三目标包真实重跑，其余为 turbo 缓存命中） |
| `pnpm exec turbo run test --force --concurrency=4`（全量 0 缓存） | 0 | **68/68 tasks 全部真实执行成功；vitest 合计 1522 通过 / 0 失败** = 基线 1503 + 新增 19（plugin-registry +9 = 60，boundary-audit +8 = 34，scm-contracts +2 = 76） |
| `pnpm exec turbo run test --force`（全量 0 缓存，默认最大并发） | 1 | **既有负载性 flake**（见 §6 风险 1）：`release-audit test/cli.test.ts` "a single section returns only that section" 在 22 任务全并发下超过 vitest 默认 5000ms 超时；该任务单独重跑（turbo --force 与裸 vitest 均）42/42 全绿。本批次三包不受影响（同并发下全绿） |
| `pnpm build`（全仓 turbo） | 0 | 34 tasks 全部成功 |
| `node planning-check.mjs` | 0 | part (a) `checksum verification OK: 78/78 files match`（.gitignore 行跳过）；part (b) 干净副本 self-test exit 0（126 条本地 md 链接检查，含本报告） |
| `sha256sum -c CHECKSUMS.sha256` | 1（预期） | 78 个 OK；唯一 FAILED 为 `.gitignore`（任务允许的保留项，与 planning-check part (a) 一致） |
| `node packages/boundary-audit/dist/cli.js <repoRoot>` | 0 | 真实树 `verdict: pass`、0 违规（扩展规则后的机制验证） |
| 变异探针：`vitest run test/write-guard.test.ts -t "HARDENING-1"`（clients.ts 临时反序） | 1 | 2 failed \| 29 skipped（顺序敏感性证明）；恢复后同套件全绿 |

**测试总数变化**：1503 → **1522**（+19，全部真实执行通过）。既有计数断言
（如 `repo-audit.test.ts` 的 workspacePackageCount=35、externalPackages=84）
无需改动。

## 6. 风险与未验证项

1. **既有 flake（非本批次引入）**：release-audit 的 CLI 全审计用例默认超时
   5000ms，在全仓最大并发强制重跑下会因负载超时。该包不在本批次允许修改
   范围内，未动其代码或超时配置；单跑与受限并发下稳定全绿。建议后续单独
   任务评估其 testTimeout。
2. **仅设计（未实现，与 M7-02/M7-04 一致）**：真实插件加载器仍不存在（自钉
   的"宿主在管理时刻计算钉"流程属未来加载器任务）；boundary-audit 的
   optional/peer 语义尚未有真实商业包样本（真实树无这些节，机制由 hermetic
   fixture 树验证）；scm-contracts 真实 provider adapter 仍仅设计。
3. 本批次未调用真实 claude/codex、未联网、未执行任何 git 写操作（boundary-
   audit 测试的 git 需求为零；fixture 树均在系统临时目录）。
4. `recordedDigest === null` 的 builtin 产物钉豁免按 ask 允许保留；manifest
   自钉无任何豁免（`manifest-pin-mismatch` 全 tier 强制）。
