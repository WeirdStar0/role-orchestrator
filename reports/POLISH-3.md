# POLISH-3：文档勘误批次报告（USAGE 守则算术与表述 / secrets-scan 注释精度 / PROPOSALS 归因·时点·哈希·密度勘误）

日期：2026-09-28 · 执行角色：Developer（POLISH-3 文档勘误批次） · 范围：`USAGE.md`、`packages/release-audit/src/secrets-scan.ts`（仅注释行）、`PROPOSALS.md`（追加）、本报告

本批次是纯文档精度批次：**零代码行为变化、零测试增删**（测试 1548 → 1548）、
零依赖变化（外部依赖 84、workspace 项目 35 不变）。基线 HEAD `bf15a62`，
工作树起始干净。冻结面（`CHECKSUMS.sha256` 的 79 个受检文件）一个字节未动；
`USAGE.md`、`PROPOSALS.md`、`secrets-scan.ts` 均不在受检面内，`PROPOSALS.md`
为设计内追加。

---

## 1. D1：USAGE.md 手工清理守则节修正（POLISH-2 第 7/8 轮勘误）

`USAGE.md` §8「evidence 目录手工清理守则」中「停跑 label 的手工清理是 pin
破坏源」一条原含三处算术/表述失真，本批次按下述实测事实重写，并新增
「扫描器假定静态树」一条：

| # | 原文 | 问题 | 修正后 |
|---|---|---|---|
| a | 「每保留运行目录约 24 张 PNG」 | 24 张是 7 个 label 各 1 个最新目录的**代合计**（5+4+5+5+4+1+0），非单目录数 | 单目录实测 0–5 张（flow 类 4–5、a38 为 1、a39 为 0，PNG 目录均值 4.0） |
| b | 「只余 29 张 PNG」 | 差一：repo-audit 的 pin 是严格 `toBeGreaterThan(500)`（`packages/release-audit/test/repo-audit.test.ts:32`），501 即绿 | 真实硬顶 **28 张**（529−501） |
| c | 「约 1.208 个 K 档」 | 单位混乱（把代数当 K 档数） | 以代计 28/24≈**1.17 代**；以目录计约 **7 个 PNG 目录** |
| d | 「删除任何一个停跑 label 的目录组都会直接打破审计断言」 | 过度概括 | 整组实测：flow-1/3/4 各 110 张、flow-2/5 各 88 张（删任一组即破 pin）；regression-a38 整组 22 张（529−22=507 仍绿，余量仅剩 6 张）；a39 整组 0 张（不适用） |
| e | （无） | 缺静态树假定说明 | 新增一条：扫描器假定静态树；并发删除按 ENOENT 跳过（2026-09-26 起容错），并发运行期三项计数临时收窄——POLISH-2 本轮实测 binary 曾至 509 仍绿 |

**事实核验（本批次实跑，非转抄）**：对本机 `packages/browser-e2e/evidence/`
逐 label 统计——每个 label 均留存 22 个目录（K=22）；各 label 最新目录 PNG
数恰为 5/4/5/5/4/1/0（代合计 24）；整组合量恰为 flow-1/3/4=110、
flow-2/5=88、a38=22、a39=0，与 POLISH-2 第 7/8 轮实测一致。算术复核：
529−110=419<501（破）、529−88=441<501（破）、529−22=507>500（绿，余量
507−501=6）、28/24≈1.17、28÷4.0≈7。

## 2. D2：secrets-scan.ts 注释修正（POLISH-1 #16）

`packages/release-audit/src/secrets-scan.ts` 的 `listFilesRecursive` 目录级
ENOENT 守卫注释原句「…the same tolerance the per-file reads below already
have」不精确：下方逐文件读取是**裸 catch**（任意错误都吞掉，见该文件
`catch { continue; }` 五处），而目录级新守卫**仅 ENOENT**（更严）。现改为：

> ENOENT-only: a directory rotated away mid-scan is skipped …; every other
> readdir error remains fatal. This guard is strictly narrower than the
> per-file reads below, which are bare catches tolerating any error.
> Static-tree assumption: the scanner assumes the tree is not concurrently
> mutated; concurrent deletions are skipped by this ENOENT tolerance…

仅注释行，`if (…code === "ENOENT") continue; throw error;` 代码一字未动
（diff 可证）；dist 随 `pnpm test` 管道（test dependsOn build）再生成新注释，
属预期。

## 3. D3：PROPOSALS.md 追加勘误节（POLISH-1 #1/#10）

追加「## 文档勘误（2026-09-28，POLISH-3 批次；只勘误不改旧文）」一节
（+30 行，纯插入，旧文零改动，`git diff` 无删除行）。四条勘误的事实核验：

- **归因**：`git show 58df093 --stat` 证实 `.github/workflows/product-gates.yml`
  为 58df093（2026-09-26 portable 批次）**新增**（+54 行）；
  `git show 17976be --stat` 证实 17976be 对该文件仅 +4 行修改（windows job
  安装 Playwright Chromium 1.61.0）。此前 f7572c7 提交信息与 POLISH-2 报告
  「终验补充」节归因为「17976be 批次新增」有误。
- **时点锚定**：`PROPOSALS.md:453`（2026-09-26「发布前文档收口」节）确有
  裸「当前 1523/34/35/84 计数」表述；勘误为其应读作该节日期时点值，
  现时点 1548/34/35/84。
- **哈希类型**：`git ls-tree HEAD .github/workflows/product-gates.yml` =
  blob SHA-1 `ba7a704e71dfe1a86b71b831581c9b3df3ac922e`；CHECKSUMS 中的
  `d910d637…` 是内容 sha256。两者为同一内容的两种摘要算法，「实质成立、
  表述有误」结论与勘误节一致。
- **密度算术**：引用 D1 的修正事实（见 §1），勘误节与 USAGE.md 同日同口径。

## 4. 变更文件清单（本批次交付 vs 实际入库提交）

| 文件 | 变更 | 性质 | 入库位置 |
|---|---|---|---|
| `USAGE.md` | +16/−6 | 文档（D1：守则节重写一条 + 新增一条） | 本批次提交 |
| `packages/release-audit/src/secrets-scan.ts` | +8/−3 | 仅注释行（D2，代码零改动） | 本批次提交 |
| `PROPOSALS.md` | +30/−0 | 追加（D3 勘误节） | **随并行批次 `9083c9e` 入库**（见 §8） |
| `reports/POLISH-3.md` | 新建 | 本报告 | 本批次提交 |

本批次自己的提交只含上表第 1/2/4 行三个文件；工作树终态为上述四文件全部
落地。无其他任何文件变更；`packages/*/package.json`、任何测试文件、任何
源码行为零改动；未触碰 tag `v0.1.0-rc` 与历史提交。

## 5. 验证命令与真实退出码（全部本机实跑，2026-09-28）

| 命令 | 退出码 | 关键输出 |
|---|---|---|
| `pnpm install` | 0 | 35 workspace projects；lockfile up to date；无依赖变化 |
| `pnpm typecheck` | 0 | Tasks: 57 successful, 57 total |
| `pnpm test`（全仓，turbo 管道） | 0 | Tasks: 68 successful, 68 total；vitest 汇总 34 包合计 **1548 passed / 0 failed / 0 skipped**（基线 1548 零变化）；其中 66/68 任务为 turbo 缓存命中（输入未变），release-audit 的 build+test 因本批次触碰该包源码注释而真实重跑并全绿 |
| `pnpm build` | 0 | Tasks: 34 successful（34 缓存命中；release-audit:build 已在前一步 `pnpm test` 管道中因 src 变更真实重跑） |
| `npx turbo build --filter=@role-orchestrator/release-audit --force` | 0 | 补充验证：强制真实重建 1/1 successful，dist 再生成含新注释 |
| `node planning-check.mjs` | 0 | (a) 78/78 files match CHECKSUMS.sha256 (.gitignore line skipped)；(b) 干净副本 self-test exit 0；status "passed" |

测试计数核验方式：对 `pnpm test` 完整日志逐包 grep vitest「Tests  N passed」
汇总行求和（34 包）= 1548，与批次要求一致；无任何 failed/skipped/todo 行。

## 6. 冻结面与红线遵守

- `CHECKSUMS.sha256` 受检面 79 条记录逐文件校验通过（`planning-check.mjs`
  (a) 步 78/78 + .gitignore 设计内跳过）；本批次未修改任何受检文件、未在
  `docs/`、`schemas/`、`config/`、`prompts/`、`project/`、`contracts/`、
  `tools/`、`scripts/`、`.github/` 下修改或新增任何文件。
- `packages/release-audit/test/repo-audit.test.ts`（不允许修改）一字未动。
- 未调用任何真实 claude/codex；未 force push；未触碰 tag。
- git 流程：本地 commit 后推送 main；如 push 被拒则按预案
  `git pull --rebase origin main` 后重试（无冲突）或停止并披露（有冲突）。

## 8. 并行批次时序事件披露（重要，如实记录）

本批次执行期间，维护者并行会话在同一工作副本上于 2026-09-28 11:28:34 +0800
创建提交 `9083c9e`（「governance: 仓库转公开」，父提交 bf15a62，仅改
PROPOSALS.md +44 行）。该提交入账时，本批次已落在工作树、**尚未提交**的
PROPOSALS.md 勘误节（+30 行，§3 全部内容）被一并带入 `9083c9e`
（44 = 30 本批次 + 14 维护者「仓库转公开」节；逐行核对证实）。

后果与处置：

- **内容零损失、零冲突**：`HEAD:PROPOSALS.md` 第 848–877 行即本批次勘误节
  原文，维护者节按追加语义排于其后（879–891 行）；两节无任何交叠或矛盾，
  文件现值即两节完整内容，旧文依旧零改动。
- **归属错位（无法在不改历史的情况下修正）**：勘误节的实际入库提交是
  维护者的 `9083c9e` 而非本批次的提交。`9083c9e` 非本批次所建，按红线
  （不碰他人/历史提交）不做任何重写；本批次提交信息已相应更正为不含
  「PROPOSALS 追加」字样，以保提交信息与提交内容一致。
- 本批次自身的提交只含 `USAGE.md`、`secrets-scan.ts`、
  `reports/POLISH-3.md` 三个文件。
- `9083c9e` 仅追加 PROPOSALS.md 文本，不触及 CHECKSUMS 受检面与测试；
  本批次全部验证在其之后针对最终状态复跑（见 §5 planning-check 行）。

## 7. 风险与边界（如实）

- 「POLISH-2 本轮实测 binary 曾至 509 仍绿」「均值 4.0」等第 7/8 轮时点
  测量值来自批次任务输入（POLISH-2 审查轮记录），本批次未重演并发场景；
  其余全部数字（最新目录 5/4/5/5/4/1/0、整组 110/88/22/0、K=22、pin 严格性、
  blob SHA-1、提交归属）已由本批次在本机独立实测证实。
- `evidence/` 为 gitignored 再生产物，`pnpm test` 运行会按轮转机制再生；
  本报告引用的是批次任务给定的 POLISH-2 轮测量时点值（529），本批次实跑
  后的当前计数会随再生而浮动（pin 本身仍由不可修改测试钉住）。
- D3 勘误节的「现为 1548/34/35/84」沿用批次输入的元组口径，仅作时点锚定
  勘误；各分量的产品语义不在本批次范围。
