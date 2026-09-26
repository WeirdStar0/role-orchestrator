# HARDENING-2：Tier-1 发布前必修 minor 收尾批次报告

日期：2026-09-25 · 执行角色：Developer（发布就绪收尾批次） · 范围：`packages/release-audit` 测试文件（仅测试级超时）、`packages/boundary-audit` README 与 package.json description（纯文档）、`packages/plugin-registry` decision.ts detail 与其测试、`PROPOSALS.md`（追加）、本报告

本批次对应 Tier-1 审查分级的 6 项发布前必修 minor：R1→#4、R2→#9、
R3→#1/#12/#14、R4→#20。冻结面（`CHECKSUMS.sha256` 记录的 79 个文件、
docs/schemas/config/prompts/project/contracts/tools/scripts/.github 目录）
一字未动；安全边界与既有拒绝语义零放宽。所有退出码均为真实执行结果
（命令原样记录于 §5）。

---

## 1. R1（minor #4）release-audit 满载超时 flake：测试级超时预算

### 1.1 设计

- 为满载下已知重的用例声明显式 `{ timeout: 20_000 }`（先例：
  `packages/reconcile/test/scan-store.test.ts:343` 的同形参数，即 M6-01
  披露的负载敏感超时调整）， vitest 测试级参数可行，未动任何包级 vitest
  配置；**零断言改动、零源码改动、零跳过**。每处附一行注释引用
  HARDENING-1 §6 与本报告：
  - `test/cli.test.ts`「runs the full audit on this repository and exits 0
    with parseable JSON」（全审计真实跑本仓库）；
  - `test/repo-audit.test.ts`「secret scan: verdict is
    known-reservations-only with ZERO needs-judgment findings (A42/A36)」
    （全仓库秘密扫描行走）。
- **点名两用例之外的必要补齐（主动披露）**：首轮满载强制重跑（见 §5）
  真实失败在**同文件第三个用例**——`test/cli.test.ts`「a single section
  returns only that section」（对本仓库跑 secrets 节扫描，同类真实仓库
  行走）。它在 turbo 默认最大并发的满载下实测 5943ms，超过 vitest 默认
  5000ms 超时；这正是 HARDENING-1 §5 当轮记录过的同一 flake（当时也是
  该用例、同签名）。
  该补齐仍在 ask 允许面之内（release-audit 测试文件的测试级超时配置），
  同形 `{ timeout: 20_000 }`、同一行注释惯例、零断言改动。§5 的两轮
  修后满载数据证明该补齐是必要的：两轮该用例分别实测 6104ms / 6004ms，
  均超旧默认 5000ms——没有它，两轮满载仍会红。
- **为什么不用包级 `testTimeout`**：测试级参数可行（已被 §5 两轮全绿
  证明），按 ask 的优先序采用最小面方案；包级配置会顺带放宽其余 39 个
  快用例（多数 ≤700ms）的超时语义，无必要。

### 1.2 验证

- 单包 `pnpm exec vitest run`（release-audit）：42/42 通过（数量不变，
  无新增用例）。
- 满载验证见 §5：修后连续两轮 `turbo run test --force`（默认最大并发、
  0 缓存）68/68 tasks 全绿。**修复前那轮的真实失败记录保留在 §5**，
  作为补齐决策的证据，不掩盖。
- 如实标注：满载 flake 本质上不可按需确定性复现，两轮全绿是「修后未再
  复现」的证据，不是「不可能再超时」的证明；预算 20s 对观测到的最大值
  （6104ms）留有 >3 倍余量。

## 2. R2（minor #9）boundary-audit 文档同步（纯文档）

### 2.1 设计

- `README.md` 规则表按 `src/audit.ts` 实际行为逐字对齐：
  - `commercial-dep-in-core`（R1）：`dependencies`（startup path）+
    `optionalDependencies`（optional runtime path——存在即被安装加载，
    是运行时边；HARDENING-1）；
  - `commercial-devdep-in-core`（R1b）：`devDependencies`（build path）+
    `peerDependencies`（peer/integration path；并入 R1b 保持闭拒绝
    词汇，HARDENING-1）；
  - `external-dep-outside-allowlist`（R2）：`dependencies` +
    `optionalDependencies` + `peerDependencies`（`devDependencies` 维持
    M7-04 的 dev/test 工具语义，不在 allowlist 扫描内）；
  - `dangling-workspace-dep`（R5）：全部四个依赖节；
  - 同时为全部八行补上与 `audit.ts` 头注释一致的规则编号
    （R1/R1b/R2/R3/R4a/R4b/R4c/R5），R3 行注明仅 `dependencies` 边成环。
  - 依据：`audit.ts:238-243`（coreRules 四节映射）、`audit.ts:261-275`
    （R2 三节扫描）、`audit.ts:203-229`（R5 四节边收集）、
    `audit.ts:278-293`（R3 仅硬运行时边）。
- `package.json` 的 `description` 字段同步同一语义（四节通道划分、R2
  三节、R5 四节、R3 仅 dependencies 边），纯描述文本。
- 未改任何代码与测试（boundary-audit 测试只用 fixture 包，不钉真实
  README/description；单包 34/34 复跑证实）。

## 3. R3（minor #1/#12/#14）PROPOSALS.md 披露勘误与补充

新增一个追加节「HARDENING-2 披露与勘误（发布收尾批次，2026-09-25）」
（PROPOSALS.md 为只追加文件，本节 appended 至文末），承载三项：

- **(a) 勘误**：HARDENING-1 披露把 `plugin-registry/test/
  load-decision.test.ts` 的既有测试适配写成「（五处）」，实为**六用例**
  （该披露正文本已列全六个用例名，仅计数括注笔误）。新节给出六个用例的
  新旧对照表：断言全部原样，变化仅为库存记录从「按默认 fixture 出具」
  改为「`inventoryFor(presented)` 钉住所呈现 manifest」。
- **(b) 补充**：治理批次（2026-09-25 身份项）披露第 6 条当时只列
  `repo-audit.test.ts`，遗漏同批同因的
  `packages/release-audit/test/cli.test.ts`（「runs the full audit…」用例
  的 codeowners 断言 placeholder-only→rules-present 翻转，现为
  `expect(report.governance?.codeowners.status).toBe("rules-present")`，
  附 governance-baseline update 注释）。补充列明，语义与同批翻转一致。
- **(c) .gitignore 精确 diff 披露**：见下节实验。

### 3.1 .gitignore 哈希重建实验（全程只读仓库，无 git 操作）

- **背景**：`CHECKSUMS.sha256` 第 9 行冻结记录 `.gitignore` =
  `4f3f042afa9882a526b82ea5791ea100b41c2506f614cbd6707578a54bd77887`；
  当前文件实测 `sha256sum` =
  `a69b9f5352f15d91290abdaed5797c7797c6fef95672125a7de8a3e7f71c4b4b`
  （LF 行尾、23 行、265 字节）。仓库无 git 历史，差异无法直接重建。
- **方法**：脚本
  `%TEMP%/gitignore-reconstruct/reconstruct.mjs`（系统临时目录，仓库侧
  只读）：按行拆分当前文件（保留行尾字节），枚举全部
  2^23 = 8,388,608 个「删除行子集」候选（检验「冻结文件 = 当前文件的
  保序子序列」假设），逐候选 sha256 与冻结值比对；每候选另试「去末尾
  换行」变体。命中即停（实际约几十个候选内命中，耗时 <0.1s）。
  过程杂散文件披露：脚本的结果 JSON 用的相对路径，在仓库进程 cwd 下
  误写了仓库根 `result.json`；发现后已删除该杂散文件（其内容为上面的
  命中记录），实验本体只读仓库的性质不受影响。临时目录现存
  `reconstruct.mjs` 与独立复核用的 `reconstructed-frozen.gitignore`。
- **结果：精确命中**。删除当前文件第 3/4/5 行（0 起数）后与冻结哈希
  逐字节一致，即自冻结以来恰新增三行，插在 `coverage/` 与
  `.plan-venv/` 之间：

  ```
  .turbo/
  *.tsbuildinfo
  .vitest/
  ```

  冻结版本为其余 20 行（`node_modules/` 起至 `runs/` 止，含末尾换行）。
- **独立复核**（同目录）：按重建结果拼出的文件 `sha256sum` 实测
  `4f3f042a…bd77887`，与 CHECKSUMS 记录逐字符一致；
  `diff <(grep -v -e '^\.turbo/$' -e '^\*\.tsbuildinfo$' -e '^\.vitest/$'
  .gitignore) 重建文件` 为空。
- **披露边界**：实验精确回答「差了哪几行」；三行的**加入时间与动机**
  无法从仓库证据重建，仅能指出其内容与 `planning-check.mjs` 临时副本
  排除目录（`.turbo`、`.vitest`）及 turbo 增量构建产物
  （`*.tsbuildinfo`）对应。`.gitignore` 是项目明示允许增补的文件
  （planning-check 注释原文），本批次未对其做任何修改。

## 4. R4（minor #20）plugin-registry manifest-pin-mismatch detail 双侧摘要

### 4.1 设计

- `src/decision.ts` 第 8 步内容漂移分支（原 :201-203）：拒绝 detail 从
  `"manifest as presented does not match the inventory canonical-manifest
  pin"` 扩展为携带两侧 sha256 hex 摘要——
  `(presented <canonicalPluginManifestSha256(manifest)> vs pinned
  <record.manifestSha256>)`；重算值提取为局部变量只算一次。
- **A42/A36 纪律不破**：两侧均为 64 位小写 hex 的结构事实（与
  `PluginLoadReject.integrityDigest`、审计事件 `integrityDigest` 同一
  纪律），不含 manifest 自由文本；审计事件 schema
  （`src/events.ts`）本就无 detail 字段，审计面零变化。
- **null 钉分支保持原 detail 不变**（`"inventory record carries no
  canonical manifest self-pin"`）——无「两侧」可言；其既有断言
  （load-decision.test.ts「a null (missing) self-pin refuses at EVERY
  tier…」的 `detail.toContain("no canonical manifest self-pin")`）原样
  通过。
- 旧 detail 字符串在全仓的引用仅 decision.ts 本体与 HARDENING-1 报告的
  历史引文（报告不回写）；无任何测试/README 依赖旧串，故无既有断言需
  适配、无语义弱化。

### 4.2 测试

`test/load-decision.test.ts`「manifest self-pin」组新增 1 用例（包内
60 → **61**）：篡改 manifest 触发内容漂移分支 → 断言 detail **同时包含**
两侧已知值（重算 `canonicalPluginManifestSha256(tampered)` 与库存钉
`canonicalPluginManifestSha256(approved)`），并用全串正则
`^manifest as presented does not match the inventory canonical-manifest
pin \(presented [0-9a-f]{64} vs pinned [0-9a-f]{64}\)$` 钉死「仅含两个
hex 结构事实」的形状，另断言篡改的自由文本（"Renamed After Approval"）
不出现在 detail。用例先断言两侧值不相等，防退化成空断言。

---

## 5. 门禁结果（真实退出码）

| 命令 | 退出码 | 结果 |
|---|---|---|
| `pnpm install` | 0 | `Scope: all 35 workspace projects`；lockfile up to date；外部依赖恰 84 不变（repo-audit 断言 35/84 未改动且在满载两轮中通过） |
| `pnpm typecheck`（turbo） | 0 | 57 tasks 全部成功 |
| `pnpm build`（turbo） | 0 | 34 tasks 全部成功 |
| `pnpm test`（turbo，默认并发，改动后首跑） | 0 | 68/68 tasks 成功（63 缓存） |
| `pnpm exec turbo run test --force`（默认最大并发，**补齐第三用例之前**） | **1** | 真实失败：release-audit `test/cli.test.ts`「a single section returns only that section」实测 5943ms 超默认 5000ms 超时（HARDENING-1 §5 同一 flake 复现）；本批次点名的两个用例在该轮**均通过**（"runs the full audit…" 5180ms，已超旧默认、被新预算救下）。该轮失败是 §1.1 补齐决策的直接证据，记录保留 |
| `pnpm exec turbo run test --force`（默认最大并发，修后第 1 轮） | 0 | 68/68 tasks、0 缓存，3m18.1s；34 个 vitest 套件合计 **1523 通过 / 0 失败 / 0 跳过**（基线 1522 + plugin-registry 新增 1）；重用例实测：full audit 4306ms、secret scan 4123ms、single section 6104ms（均在新 20s 预算内） |
| `pnpm exec turbo run test --force`（默认最大并发，修后第 2 轮） | 0 | 68/68 tasks、0 缓存，3m14.0s；合计 **1523 通过 / 0 失败 / 0 跳过**；重用例实测：full audit 4709ms、secret scan 4220ms、single section 6004ms |
| `pnpm test`（turbo，默认并发，最终状态复跑） | 0 | 68/68 tasks 成功（64 缓存） |
| `node planning-check.mjs` | 0 | part (a) `checksum verification OK: 78/78 files match`（.gitignore 行按设计跳过）；part (b) 干净副本 self-test exit 0 |
| `sha256sum -c CHECKSUMS.sha256` | 1（预期） | 78 个 OK；唯一 FAILED 为 `.gitignore`（§3.1 的已知保留漂移，本批次未触碰它） |
| `node packages/boundary-audit/dist/cli.js <repoRoot>` | 0 | 真实树 `verdict: pass`、0 违规、34 个包目录（该 CLI 只数 `packages/` 下目录；repo-audit 的 35 是含根 package.json 的 workspace project 数，两者口径不同、各自基线均未动） |
| 单包 `pnpm exec vitest run`（release-audit / plugin-registry / boundary-audit） | 0 / 0 / 0 | 42/42、61/61（60→61）、34/34 |

**测试总数变化**：1522 → **1523**（+1：plugin-registry 新增双侧摘要
用例；无删除、无跳过）。既有计数断言（repo-audit 的
workspacePackageCount=35、externalPackages=84）未改动且通过。workspace
包数 35、外部依赖恰 84，均不变。

## 6. 风险与未验证项

1. **满载 flake 不可按需复现**：修后两轮全绿是「未再复现」的观测，不是
   不可能性的证明；若未来机器负载形态变化（更多并发任务、更慢盘），超出
   20s 预算仍可能超时——该预算对观测最大值（6104ms）留 >3 倍余量。
2. **.gitignore 三行的加入时间与动机不可重建**（§3.1 披露边界），实验
   只证明行集合本身。
3. **boundary-audit optional/peer 语义仍无真实商业包样本**（真实树无
   这些节）；R2 是纯文档同步，机制由既有 hermetic fixture 测试（34/34）
   覆盖，与 HARDENING-1 §2 一致。
4. 本批次未调用真实 claude/codex、未联网、未执行任何 git 写操作
   （.gitignore 实验在系统临时目录、纯哈希计算，无 git）。
5. 未验证项：无其他。四项修复的全部验证命令均已真实执行并记录退出码。
