# PROPOSALS — node_modules 导致冻结 check_links 失败（审查第 1 轮返修披露）

状态：提案（未获批）。作者：审查第 1 轮返修工程师。日期：2026-09-21。
本文件是如实披露，不是变更记录；冻结文件 `scripts/validate_bundle.py` 本次未做任何功能性改动。

## 0. 背景与本次返修事实

- 第 1 轮审查唯一的阻断项：前序开发轮在未披露的情况下修改了冻结文件 `scripts/validate_bundle.py`——新增 `is_bundle_file()` 函数，并在 `check_links` 的 `*.md` 扫描与 `main` 的 `*.yml` 扫描中加入 `node_modules` 过滤，使 `planning-self-test` 在 `node_modules` 存在时也能 `exit 0`。
- 本次返修已将该文件还原为冻结版本：仅移除上述三处新增，未做其他改动。还原后 `sha256sum scripts/validate_bundle.py` 实测为 `f829d28605441cdb3dd80de7b4f7c99d60bc10e6b5070984dbc03980f2342a6c`，与 `CHECKSUMS.sha256` 第 77 行记录的冻结值逐字节一致。
- 其余 77 个冻结文件经核对全部完好；`packages/contracts`、`packages/fake-cli`、`packages/cli-events` 的实现与测试本体合格，本次一律未改动。

## 1. 问题

- 本环境实测 Python 版本为 3.13.14。Python 3.13 起，`pathlib.Path.rglob` 默认跟随 junction/symlink（不再默认跳过目录符号链接）。
- 冻结的 `check_links`（`scripts/validate_bundle.py` 第 159 行起）使用 `ROOT.rglob("*.md")` 遍历全仓库 Markdown 并逐一校验本地相对链接（第 161 行）。当仓库内存在 `node_modules` 时，pnpm 的目录结构（根 `node_modules/.pnpm/**` 与 workspace 包内 `node_modules/@role-orchestrator/*` 的链接）会被扫入，第三方包 README 中的仓库内相对链接（如其自身源码、CI 配置路径）在解析后并不存在，于是 `check_links` 抛出 `BundleError`，`main` 返回 1。
- 同理，`main` 中的 `ROOT.rglob("*.yml")` 扫描（第 271 行）也可能扫入依赖包内的 YAML 文件。
- 这不是规划包本体的问题：第三方 README 的"断链"只是第三方仓库的内部相对路径，对本体完整性没有意义。但冻结脚本无法区分，因此只要 `node_modules` 在场就直接失败。

## 2. 证据（均为本仓库内 2026-09-21 实测，Python 3.13.14）

- 在仓库根直接运行 `python scripts/validate_bundle.py --self-test`，退出码为 1，stderr 为：

  ```text
  Validation failed: Broken local link: packages\contracts\node_modules\yaml\README.md: docs/CONTRIBUTING.md
  ```

- 由于冻结的 `check_links` 遇到第一个断链即抛出，一次运行只显示一条。另用一段与 `check_links` 逻辑等价的只读内联扫描（`rglob("*.md")` + 相同链接正则，仅统计 `node_modules` 内文件，不改任何文件）枚举样例：共扫到 247 个第三方 Markdown 文件、67 个断链。样例（源文件 -> 断链目标）：

  ```text
  packages\contracts\node_modules\yaml\README.md -> docs/CONTRIBUTING.md
  packages\cli-events\node_modules\@role-orchestrator\contracts\node_modules\yaml\README.md -> docs/CONTRIBUTING.md
  node_modules\.pnpm\yaml@2.9.1\node_modules\yaml\README.md -> docs/CONTRIBUTING.md
  node_modules\.pnpm\vitest@4.1.11_...\node_modules\es-module-lexer\README.md -> src/lexer.ts
  node_modules\.pnpm\vitest@4.1.11_...\node_modules\expect-type\README.md -> ./src/index.ts
  node_modules\.pnpm\vitest@4.1.11_...\node_modules\expect-type\README.md -> ./.github/workflows/ci.yml
  node_modules\.pnpm\vitest@4.1.11_...\node_modules\picomatch\README.md -> ../../issues/new
  node_modules\.pnpm\vitest@4.1.11_...\node_modules\picomatch\README.md -> .github/contributing.md
  ```

  这些目标都是第三方包自己的仓库布局（其源码、CI、issue 模板），在本仓库中不存在是预期行为。
- 对照：在不含 `node_modules` 的仓库副本中运行同一冻结脚本 `--self-test`，规划包本体校验通过（`planning:check` 的第 (b) 步正是这样执行并透传退出码）。

## 3. 提案（需维护者/上游按治理流程审批）

建议维护者/上游修改冻结的 `check_links`，使其排除 `node_modules`（例如对 `*.md` 与 `*.yml` 两次扫描都跳过路径中含 `node_modules` 的条目），或采用等价机制（如遵循忽略清单、显式扫描清单）。约束：

1. 必须经治理流程（Issue + Review + 批准）后实施，不得由开发轮未披露地直接改动冻结文件——本轮 FAIL 的根因正是这种未披露改动。
2. 任何对 `scripts/validate_bundle.py` 的改动必须同步更新 `CHECKSUMS.sha256` 中 `scripts/validate_bundle.py` 的记录哈希，并说明动机与影响面。
3. 改动后应在仓库内（含 `node_modules` 在场）与干净副本两种环境下分别验证退出码，如实记录。

## 4. 当前决定

- 在上述提案获批前，不修改冻结脚本。
- 仓库内直接运行 `python scripts/validate_bundle.py --self-test` 的 `exit 1` 作为已知问题保留：不修复、不掩盖、不绕过。
- M0 阶段的规划包完整性验证门改用根目录 `planning-check.mjs`（`pnpm run planning:check`），它做两件事：
  1. 读取 `CHECKSUMS.sha256`，跳过明示允许增补的 `.gitignore` 行，逐一校验其余 78 个记录文件的 sha256，任何不匹配即打印差异并以非零码退出；
  2. 把仓库树复制到系统临时目录的新目录（排除 `node_modules`、`dist`、`.turbo`、`.vitest`、`coverage`、`.git`、`.zcode`），以该副本为工作目录运行 `python scripts/validate_bundle.py --self-test`，透传其退出码，结束后清理临时目录。
- 该脚本不修改任何冻结文件，也不声称仓库内 self-test 通过；它只是把「本体完整性」与「node_modules 在场导致的已知失败」分开呈现。

---

# M0-06 提案条目（capability gate 与平台基线的披露，2026-09-22）

以下五条均为**提案（未获批）**，作者：M0-06 汇总工程师。证据全部来自已验收的 `reports/M0-03-claude-capability.md`（含 2026-09-22 补采附录）、`reports/M0-04-codex-capability.md`、`reports/M0-05-windows-launcher.md` 及其脱敏 fixture。本文件是披露，不是变更记录；本任务未实施其中任何一条对冻结面的修改。

## P-M06-1 · 结构化输出契约需求（平凡真实成功流 fail-closed 的产品影响）

实测事实：codex 真实成功流 `turn.completed` 只带 `usage`、无业务负载（fixture `codex-trivial-success.real.jsonl`）；claude 真实 `result` 行无 `structured_output`（错误流旁证，成功流因 429 未采集）。影响：**平凡真实运行在当前契约下一律 fail-closed（`business-schema-invalid`），CLI exit 0 ≠ 业务成功**。提案：产品必须为两 CLI 显式定义结构化输出契约机制（如 claude 的结构化输出格式、codex `--output-schema`），并在 M1 单执行闭环（M1-03 的「exit 0 且结果有效」验收）之前完成真实补采验证；在此之前不得把 `business-schema-invalid` 判定放松为「文本匹配即成功」。

## P-M06-2 · codex 无审批写入的节点检查点强制

实测事实：codex exec 默认模式对工作区写入**直接执行**（盘上验证 5 字节文件真实创建），全程无 `approval.requested`/`approval.denied` 事件（fixture `codex-permission-probe-write-executed.real.jsonl`）。提案：产品规则强制——任何具备写能力的无人值守执行必须先经节点检查点（CLI 结束/安全停止后创建有限授权的新 Execution），该规则应进入 ADR/审批检查点设计（M4-02 的输入），不得依赖 CLI 自身停下等待。已由 `packages/capability-gate` 的 blocked 假设 `codex.default-mode-unattended-write`（requiredControl: node-checkpoint）编码为 M1 起点数据。

## P-M06-3 · claude `is_error` 陷阱对成功判定规范的修正

实测事实：claude 真实 API 失败流给出 `type:"result"`、`subtype:"success"`、`is_error:true`、`terminal_reason:"api_error"`、exit 1（fixture `claude-api-error-429.real.jsonl`）；补采 #1/#2（2026-09-22）再次复现同形态。提案：凡描述 claude 成功判定的规范文字（含冻结文档中按 subtype 判定的表述）应修正为「以 `is_error`/`terminal_reason` + 退出码 + 业务 schema + 证据齐备的组合判定，绝不单独依赖 subtype 或退出码」。解析器已按此实现并被 contract 测试钉住；规范文字的回流属冻结文档变更，见 P-M06-5。

## P-M06-4 · Node 25.0.0 `fs.cpSync`/`fs.rmSync` 非 ASCII 路径缺陷的上游提案

实测事实（win32，Node v25.0.0）：`fs.cpSync(recursive)` 目标含中文时子进程硬崩溃 0xC0000409（零 stderr）或目录已存在时静默 0 拷贝；`fs.rmSync`（单文件与 recursive）崩溃或进程内静默无操作、文件仍在；逐原语验证 `mkdir/copyFile/unlink/rmdir` 等可用（`reports/M0-05-windows-launcher.md` §4 场景2、§7 风险2）。提案：(a) 向 nodejs/node 上游提交最小复现与版本信息（标注「当前实测版本 v25.0.0」，不声明引入范围）；(b) 本仓库所有 staging/清理脚本遵守 M0-05 的经验证原语白名单并做事后 `existsSync` 验收，等待上游修复；(c) Node 升级后重跑 `packages/process-lab` 五场景（含父死级联、`cmd /d /c`、GBK 输出三项「当前实测版本」行为的复核）。

## P-M06-5 · 需维护者批准的冻结文档更新清单（ADR 更新 + CHECKSUMS 同步）

以下文件均在 `CHECKSUMS.sha256` 冻结记录内，任何更新必须走治理流程（Issue + Review + 维护者批准），实施时同步更新 `CHECKSUMS.sha256` 对应行（否则 `pnpm run planning:check` 第 (a) 步失败），并由提议方在干净副本中复跑 self-test：

1. `docs/adr/007-trusted-local-and-capabilities.md`：增补 capability gate 数据模块（`packages/capability-gate` 四态语义、unknown-deny、blocked 假设清单）作为 Local Trusted 模式下能力门的数据面。
2. `docs/adr/002-cli-runtime-first.md`：增补 M0 实测协议事实（claude `is_error` 陷阱、codex `turn.completed` 无业务负载、codex 默认模式无审批写入、两 CLI 非交互均无中途审批通道 → 节点检查点为唯一合规暂停机制）。
3. `docs/CLI_ADAPTERS.md`：增补真实协议映射发现（`api_retry`/hook 事件/item error/事件顺序不可假设/错误路径 usage 为 0 不可当费用）与「流不可见 ≠ 未加载」的隐式加载结论。
4. `docs/SECURITY_MODEL.md`：增补两 CLI 沙箱能力均 unverified → Hardened 模式在 M0 证据下不可选择的明确记录（A31/A32 落点）。
5. `docs/ACCEPTANCE.md`：如上四项获批后，为 A19/A31/A32/A33 补记 M0 证据指针（不改变验收语义）。

在获批前，以上内容仅以本文件与本仓库新增报告/包（`reports/M0-06-*`、`packages/capability-gate`）的形式存在，未触碰任何冻结文件。

---

# 返修披露（A36 落盘前脱敏修复与 redact 模块迁移，2026-09-22）

第 1 轮审查唯一阻断项（A36「渲染消毒、落盘前脱敏」中落盘半边失实）的返修已完成。本节是披露，不是提案；以下修改全部不触碰冻结面（`planning-check` 78/78 校验和通过）：

1. **落盘前脱敏已真实实现**：engine 全部事件写入（`persistDrainedEvents` 协议批次、终态 `lifecycle_outcome`、`lifecycle_launch_failed`）统一经 `appendRedactedEvent` 在组行前深度脱敏 payload，秘密形态文本进入 `events` 表前已是 `[REDACTED]`；store 校验和对存储后（已脱敏）payload 计算，`verifyEventChecksums` 一致。测试直接读回原始行断言「库内已脱敏」。
2. **redact 单一事实来源迁移**：`packages/local-api/src/redact.ts`（及其测试）原样迁入 `packages/cli-events`（src + test 同步迁移，代码零改写）；local-api 从 cli-events re-export 并新增 `workspace:*` 依赖（`pnpm-lock.yaml` 相应更新）。行为与测试语义不变。
3. **local-api README 措辞修正**：原文「日志落盘前脱敏」失实，现按事实改写——第一层（落盘前）在 engine 持久化路径，本包出进程脱敏为第二层纵深防御。
4. **顺手修（审查 minor）**：local-api 静态资产路由（`/`、`/app.js`、`/app.css`）补齐 `SECURITY_HEADERS`（此前用裸 `writeHead` 缺安全头），测试钉住。
5. 已知残留：`packages/local-api/dist/redact.{js,d.ts}` 是迁移前构建的孤儿产物（源码副本已删，无任何导入引用）；turbo 缓存回放可能在下次 `pnpm build` 缓存命中时恢复这两个文件，直到缓存条目失效或 `dist` 清理为止。不影响行为。

---

# M6-01 披露（reconcile 探针测试的负载敏感超时调整，2026-09-24）

M6-01（平台矩阵）新增测试使 turbo 对 `packages/reconcile:test` 的缓存失效，全量 `pnpm test` 首次以满载并行真实复跑该包，暴露一个**既有**负载敏感问题：

- `packages/reconcile/test/scan-store.test.ts` 的「the default probe is the real windowsProcessProbe and platform-honest」用 vitest 默认 5 秒测试超时，但其内部探针自持 15 秒预算（`windowsProcessProbe(process.pid, 15_000)`，powershell.exe 全进程表 `Get-CimInstance Win32_Process` 枚举）。全量跑（约 20 个并行 worker，另有 browser-e2e 浏览器与 process-lab 进程实验同时在逃）时该枚举实测超过 5 秒（隔离运行 1.7 秒），两次全量运行均以 `Error: Test timed out in 5000ms` 失败；单包运行与基线（当时该任务为 turbo 缓存命中、未真实执行）均为绿。
- 已做最小调整：为该测试声明显式 `{ timeout: 20_000 }`（与探针自身预算一致并留余量），**零断言改动、零跳过**，与 process-lab 等 OS 长操作测试的既有惯例一致。
- 待维护者裁量（提案，未获批）：
  1. 若希望全量跑更稳健，可为 reconcile 的真实探针路径换用更轻的按 PID 过滤查询（如 `Get-CimInstance -Query "WHERE ProcessId=..."`）以避免全表枚举——属行为微调，需按治理流程另行验证；
  2. 或接受显式超时方案（现状），其在慢机/CI 下的余量更大。
- 本披露不改变任何冻结文件；`planning:check` 78/78 校验和在调整后复跑通过。

---

# M6-04 披露与提案（受控 dogfood 与使用文档，2026-09-24）

## 披露（不触碰冻结面）

M6-04 新增 `packages/dogfood`（受控 dogfood 链路测试/驱动包）、`reports/M6-04-dogfood.md`
（失败与恢复记录）与根目录 `USAGE.md`（使用文档，内容逐条对照实现核实）。
全链路在系统临时目录的隔离 git fixture 仓库上真实执行：三处失败注入（review
内容依据 fail、fake-cli `action-proposal` 未授权写入提案、启动窗口中断）分别由
受控扩图、审批检查点（A17 拒改探针 + 有限续行）与真实 `reconcileStartup`
（A22 RECOVERY_REQUIRED，不自动重跑，人工解决后显式重试成功）恢复；A11（用户
仓库逐字节不变）/A17/A22 的实测证据记录在 `packages/dogfood/evidence/` 与
`reports/M6-04-dogfood.md` §3。除测试自建的临时 fixture 仓库外未做任何 git 操作。

## 提案 P-M06-6（需维护者按治理流程批准）：根 README.md 增补 USAGE 指引

M6-04 的 ask 要求「README 与 USAGE.md 的交叉引用」，但根 `README.md` 属冻结面
（`CHECKSUMS.sha256` 第 20 行固定其 sha256；`planning-check` 第 (a) 步逐字校验），
本任务按约束未改动它。当前交叉引用由新增文件单向/双向承载：`USAGE.md` 引用
`README.md`，`packages/dogfood/README.md` 引用 `USAGE.md`。

提案（获批后实施，实施时同步更新 `CHECKSUMS.sha256` 的 `README.md` 行）：在根
`README.md` 的「阅读顺序」清单或「本包包含的可用内容」节增补一行，指向根目录
`USAGE.md`（使用说明：安装前提、本地页面服务启动、令牌获取、页面导览、常用
操作、故障排查、已知限制与支持范围）。在获批前，USAGE 指引仅以
`USAGE.md`、`packages/dogfood/README.md` 与本条提案的形式存在。

## M6-04 披露（release-audit 工作区计数基线 30 → 31）

新增 `packages/dogfood` 使工作区包数从 30 变为 31，`packages/release-audit/test/repo-audit.test.ts`
的「dependency audit」用例固定断言 `workspacePackageCount = 30`，全量 `pnpm exec turbo
run test --force` 首跑以 `expected 31 to be 30` 失败（该审计钉的本意即「包集合变化
必须被注意到」——本次它起作用了）。已做最小更新：断言改为 `31` 并附注释；该用例
其余断言（specifier 一致、integrity 全钉、默认 registry、外部依赖恰 84 个）零改动、
全部通过（`pnpm exec vitest run`（release-audit）exit 0，42/42）。本任务未新增任何
外部 npm 依赖（新包只用既有版本与 `workspace:*` 链接，`pnpm-lock.yaml` 仅新增
importer 段）。与 M6-01 的超时调整同性质：基线计数随真实结构更新，完全披露，不
弱化任何审计强度。

## M6-04 披露（process-lab 级联测试的拆除等待对齐）

新增 `packages/dogfood` 使全量 `pnpm exec turbo run test --force`（27 包满载并行）
首次在 `packages/process-lab/test/cancel-semantics.test.ts` 的「grandchild cascade」
用例上失败：断言在固定 `sleep(2_000)` 后立即查询孙进程身份，满载下 OS 拆除尚未
完成（孙进程 pid 仍可见），`expected {pid …} to be null`（隔离单包运行为绿）——
与 M6-01 披露的 reconcile 探针超时同属「满载并行暴露的既有负载敏感」类。
已做最小对齐：级联断言改用本包自有的有界拆除等待原语 `expectPidGone`（根进程
.kill 断言本就在用，预算 30s）——断言语义零弱化：孙进程若存活仍然失败（抛出），
只是不再假设固定 2 秒墙钟在任何负载下都足够。子/孙两条级联断言同步对齐；
`sleep`/`isAlive` 在同文件其他断言中仍在使用。单包复跑 exit 0（12/12）。

# A40 返修披露（第 3 轮审查：清理误标祖先目录，2026-09-24）

`packages/maintenance` 修复 A40 缺陷：`planCleanup` 的 `scanDir` 曾把注册 worktree
的祖先目录（标准布局 `<run>`、`<run>/<node>`）误标为 `unregistered-worktree-directory`
（require-confirm），确认后会被递归删除、连带其中活跃 worktree。修复分三层：
scanDir 归类前跳过「任何注册 worktree 路径的祖先」（结构容器不再产生清理项）；
`executeCleanup` 删除前新增 `containment-guard` 包含性拒绝（目标内部含任何执行时
git 注册 worktree 或本计划 retain 项路径即拒绝，git 不可确认时失败关闭）；
新增 `test/cleanup-containment.test.ts` 四个回归用例（(a) 祖先不产生可清理项、
(b) 确认祖先删除被拒绝且活跃 worktree 完好、(b2) 计划后注册竞态被执行时
git 重列拦截、(c) 真孤儿仍可正常清理）。**行为变化披露**：修复前操作者可确认
删除的「误标祖先项」在新版本中不再出现在计划里，等价请求在执行期被
`containment-guard` 拒绝——这是恢复 `README.md`/inventory 既有 A40 契约
（"never cleanable through this API"）的缺陷修复，非契约变更。**无既有断言被
改写或删除**：全仓 1312 个既有测试零改动通过（全量 `pnpm test` 1316 = 1312 + 新增 4），
故无需按「改写钉住缺陷行为的旧断言」条款处理，此处仅为行为变化主动披露；
同步文档改动仅限 `packages/maintenance/README.md`（非冻结面）。

---

# M7-01 披露（release-audit 工作区计数基线 31 → 32，2026-09-24）

M7-01（设计 GitHub/GitLab 受控集成）新增 `packages/scm-contracts`（第 32 个
workspace 包）与设计文档 `reports/M7-01-scm-integration.md`。
`packages/release-audit/test/repo-audit.test.ts` 的「dependency audit」用例固定
断言 `workspacePackageCount = 31`，已按先例（M6 批次 30 → 31，见上文 M6-04
披露）更新为 `32` 并附注释。与上次完全同性质：该断言的本意就是「包集合变化必须
被注意到」。

- 本任务未新增任何外部 npm 依赖：`packages/scm-contracts` 的 dependencies 只有
  既有版本锚定的 `zod@^4.6.5` 与 `workspace:*` 链接（approval / contracts /
  runtime-profile），devDependencies 只有 `@role-orchestrator/store`（workspace，
  仅测试用）、`@types/node@^25.9.8`、`typescript@^5.9.3`、`vitest@^4.0.0`——
  全部与既有包逐字相同。`pnpm-lock.yaml` 仅新增 importer 段，外部包集合、
  license 表与 runtime 外部依赖集合（ws/yaml/zod）不变。
- 该用例其余断言（specifier 一致、integrity 全钉、默认 registry、外部依赖恰
  84 个、license 汇总表）零改动。
- 对既有测试的另一处改动：无。其余全部为新增文件（新包 + 报告 + 本披露追加）。

---

# M7-02 披露（release-audit 工作区计数基线 32 → 33，2026-09-24）

M7-02（设计受控插件与工具扩展）新增 `packages/plugin-registry`（第 33 个
workspace 包）与设计文档 `reports/M7-02-plugin-tool-registry.md`。
`packages/release-audit/test/repo-audit.test.ts` 的「dependency audit」用例固定
断言 `workspacePackageCount = 32`，已按先例（M6 批次 30 → 31、M7-01 31 → 32，
见上文披露）更新为 `33` 并附注释。与先例完全同性质：该断言的本意就是
「包集合变化必须被注意到」。

- 本任务未新增任何外部 npm 依赖：`packages/plugin-registry` 的 dependencies
  只有既有版本锚定的 `zod@^4.6.5` 与 `workspace:*` 链接（capability-gate /
  contracts），devDependencies 只有 `@types/node@^25.9.8`、
  `typescript@^5.9.3`、`vitest@^4.0.0`——全部与既有包逐字相同。
  `pnpm-lock.yaml` 仅新增 importer 段，外部包集合、license 表与 runtime
  外部依赖集合（ws/yaml/zod）不变（release-audit 42/42 复跑实测）。
- 该用例其余断言（specifier 一致、integrity 全钉、默认 registry、外部依赖恰
  84 个、license 汇总表）零改动。
- 对既有测试的另一处改动：无。其余全部为新增文件（新包 + 报告 + 本披露追加）。

---

# M7-03 披露（release-audit 工作区计数基线 33 → 34，2026-09-24）

M7-03（验证可选容器/Remote Worker）新增 `packages/remote-worker`（第 34 个
workspace project）与设计文档 `reports/M7-03-remote-worker.md`。
`packages/release-audit/test/repo-audit.test.ts` 的「dependency audit」用例
固定断言 `workspacePackageCount = 33`，已按先例（M6 批次 30 → 31、M7-01
31 → 32、M7-02 32 → 33，见上文披露）更新为 `34` 并附注释。与先例完全同
性质：该断言的本意就是「包集合变化必须被注意到」。

- 本任务未新增任何外部 npm 依赖：`packages/remote-worker` 的 dependencies
  只有既有版本锚定的 `zod@^4.6.5` 与 `workspace:*` 链接（contracts /
  store——store 提供被复用的真实租约实现 claimLease/releaseExpiredLeases
  等），devDependencies 只有 `@types/node@^25.9.8`、`typescript@^5.9.3`、
  `vitest@^4.0.0`——全部与既有包逐字相同。`pnpm-lock.yaml` 仅新增
  importer 段，外部包集合、license 表与 runtime 外部依赖集合
  （ws/yaml/zod）不变（release-audit 复跑实测，见该任务报告 §11）。
- 该用例其余断言（specifier 一致、integrity 全钉、默认 registry、外部依赖
  恰 84 个、license 汇总表）零改动。
- 对既有测试的另一处改动：无。其余全部为新增文件（新包 + 报告 + 本披露
  追加）。

---

# M7-04 披露（release-audit 工作区计数基线 34 → 35，2026-09-24）

M7-04（冻结独立团队商业版接口边界）新增 `packages/boundary-audit`（第 35 个
workspace project）与设计文档 `reports/M7-04-commercial-boundary.md`。
`packages/release-audit/test/repo-audit.test.ts` 的「dependency audit」用例
固定断言 `workspacePackageCount = 34`，已按先例（M6 批次 30 → 31、M7-01
31 → 32、M7-02 32 → 33、M7-03 33 → 34，见上文披露）更新为 `35` 并附注释。
与先例完全同性质：该断言的本意就是「包集合变化必须被注意到」。

- 本任务未新增任何外部 npm 依赖：`packages/boundary-audit` 的 dependencies
  只有既有版本锚定的 `zod@^4.6.5`，devDependencies 只有
  `@types/node@^25.9.8`、`typescript@^5.9.3`、`vitest@^4.0.0`——全部与既有
  包逐字相同。`pnpm install` 实测 `Scope: all 35 workspace projects`、
  `resolved 84`：`pnpm-lock.yaml` 仅新增 importer 段，外部包集合、license
  表与 runtime 外部依赖集合（ws/yaml/zod）不变（release-audit 42/42 复跑
  实测，见该任务报告 §7）。
- 该用例其余断言（specifier 一致、integrity 全钉、默认 registry、外部依赖
  恰 84 个、license 汇总表）零改动。
- 对既有测试的另一处改动：无。其余全部为新增文件（新包 + 报告 + 本披露
  追加）。

## 治理披露：发布身份项落地（2026-09-25，维护者批准）

维护者于 2026-09-25 会话中明确批准：版权署名「Nick（个人名义）」、安全渠道选
GitHub 私密漏洞报告、按治理流程修改冻结文件并同步校验和。GitHub handle 维护者
暂未提供，全部以显眼占位符 `@maintainer-handle` 落地，公开发布前必须替换
（替换时同流程再披露）。

本次变更（全部为本节披露的治理变更）：

1. **LICENSE（新增文件）**：逐字复制 `LICENSE.proposed.txt`（sha256 与候选一致，
   `af975c97…`）。`LICENSE.proposed.txt` 保留原样，其冻结哈希不变。
2. **MAINTAINERS.md（冻结修改）**：哈希 `e8b602fe…` → `ee999e42…`。填入维护者
   身份（Nick）与 handle 占位符、GitHub 私密漏洞报告启用指引、已转正 LICENSE
   与 MPL-2.0 待复核提示；原「不得猜测」与「Agent 不是发布批准主体」约束保留。
3. **.github/CODEOWNERS（冻结修改）**：哈希 `740d8a65…` → `e559ebac…`。由
   placeholder-only（生效规则 0 条）改为 7 条生效规则（全部指向 handle 占位符），
   模板标记文本随之移除。
4. **THIRD_PARTY_NOTICES.md（冻结追加）**：哈希 `5a51ae5b…` → `6b8036f1…`。
   原文保留，追加 84 项 npm 外部依赖清单（MIT 44 / Apache-2.0 4 / ISC 3 /
   BSD-3-Clause 1 / MPL-2.0 2 / 本机未安装 30）。30 项未安装平台二进制按
   unknown-deny 不标注许可证，发布前须经 registry 复核（新增维护者待办）。
5. **CHECKSUMS.sha256（冻结修改）**：仅更新上述三条记录的哈希，其余 76 条未动。
6. **packages/release-audit/test/repo-audit.test.ts（既有测试基线更新）**：
   随治理状态翻转更新三处断言（notices 覆盖 0/84→84/84；license formalization
   pending→formalized；governance placeholder-only→rules-present、identity
   recorded）。同文件其余断言零改动；这是继 M6-04 以来第 5 次披露性基线更新，
   先例链完整。

变更后状态：license `formalized`（**M6-05 §6 第 1、6、7 项关闭**）；codeowners
`rules-present`（第 2 项部分关闭——待真实 handle）；安全渠道仍
`not-configured-documented`（第 3 项为 GitHub 仓库设置操作，维护者自助）；
releaseApproval 保持 `pending-maintainer`（第 5 项未动，须人工批准）。

---

## HARDENING-1 既有测试改动披露（2026-09-25，Tier-1 加固批次）

本批次主题是收紧边界（plugin-registry manifest 全文自钉 / boundary-audit
optional+peer 补扫 / scm-contracts 消费后 transport 失败分支钉住），报告见
`reports/HARDENING-1.md`。除新增测试外，还修改了以下**既有测试内容**，全部
为让测试适配新拒绝面，拒绝语义只增不减，无任何断言放宽：

1. `packages/plugin-registry/test/audit-event.test.ts`（两处）：
   - `input()` 基线的库存记录改为以 `canonicalPluginManifestSha256` 钉住所
     呈现的默认（敌意文本）manifest——manifest 全文自钉成为强制后，钉与呈现
     必须一致才能到达后续步骤，原「accept 1:1 投影」断言原样保留；
   - 「projects every rejection reason 1:1」用例的拒绝形态表**追加** 2 条
     `manifest-pin-mismatch` 形态（null 钉、内容漂移）。该表既有
     `seen.size === PLUGIN_LOAD_REJECTION_REASONS.length` 断言使追加成为
     硬性必需（闭枚举新增一个理由），8 条既有条目一字未改。
2. `packages/plugin-registry/test/load-decision.test.ts`（五处）：
   「accepts a verified plugin…」「refuses when the manifest digest drifts…」
   「accepts when BOTH pins hold」「refuses a declared scope outside the host
   allowlist」「accepts when declared scopes are a subset…」「empty
   allowlist…」六用例中呈现 manifest 与默认库存钉不一致的部分，改为用
   `inventoryFor(presented)`（helpers 新增）钉住所呈现 manifest，使原断言
   （verified 接受 / integrity-mismatch / scope-not-allowlisted / accept）
   在新拒绝面下依然考察其原本要考察的分支。拒绝理由与结果断言全部原样保留，
   未放宽任何期望。

既有测试总数语义：全仓 1503 → 1522（新增 19，无删除无跳过）。
既有计数断言（repo-audit workspacePackageCount=35、externalPackages=84）
零改动且通过。

## 治理披露：维护者 handle 替换占位符（2026-09-25）

维护者于 2026-09-25 会话提供真实 GitHub handle **@WeirdStar0**，替换 2026-09-25
身份项批次落地的占位符 `@maintainer-handle`（该批次披露承诺「替换时按治理流程
同步校验和并披露」，本节即该披露）。

1. **MAINTAINERS.md（冻结修改）**：哈希 `ee999e42…` → `b2e86d8e…`。handle 填入
   `@WeirdStar0`（维护者本人提供）；「不得猜测」约束保留；发布门禁指引更新为
   「核对 CODEOWNERS 与账号一致」。
2. **.github/CODEOWNERS（冻结修改）**：哈希 `e559ebac…` → `85aeb5f4…`。7 条
   生效规则全部指向 `@WeirdStar0`，规则结构与条数不变。
3. **CHECKSUMS.sha256（冻结修改）**：仅更新上述两条记录，其余 77 条未动。

至此 M6-05 §6 第 2 项（CODEOWNERS）与第 7 项（维护者身份）**完全关闭**
（第 2 项生效前提：仓库推送到 handle 有权限的 GitHub 后规则生效）。

---

# HARDENING-2 披露与勘误（发布收尾批次，2026-09-25）

Tier-1 审查分级的 6 项发布前必修 minor 收尾批次，设计与验证见
`reports/HARDENING-2.md`。本节只承载披露与勘误三项（(a)(b)(c)）；批次其余
改动（release-audit 两个重用例的测试级超时、boundary-audit README 与
package.json description 纯文档同步、plugin-registry manifest-pin-mismatch
detail 双侧摘要）均为非冻结面修改，全部记录在该报告中。

## (a) 勘误：HARDENING-1 披露中 load-decision.test.ts 的处数计数

2026-09-25 的 HARDENING-1 披露（上文）把
`packages/plugin-registry/test/load-decision.test.ts` 的既有测试适配写成
「（五处）」。实际为**六个用例**——该披露正文已列全六个用例名，仅计数括注
笔误。现列出新旧对照（六个用例的原断言全部原样保留，未放宽任何期望；变化
仅是把库存记录从「钉默认 fixture」改为「钉住测试呈现的 manifest」，
`inventoryFor` 为该批次在 `test/helpers.ts` 新增；HARDENING-1 之前库存
schema 无 `manifestSha256` 字段，`inventoryFixture` 现按默认 fixture 计算
自钉）：

| # | 用例（现名，load-decision.test.ts） | 旧形态（HARDENING-1 前） | 新形态（现） | 原断言（未变） |
|---|---|---|---|---|
| 1 | 「accepts a verified plugin whose inventory pin matches the manifest digest」 | 呈现 `manifestFixture({trust:"verified"})`，库存记录按默认 fixture 出具（未钉呈现 manifest） | `inventoryFor(verifiedManifest, { tier:"verified", recordedDigest: DIGEST_A })` | accept、tier=verified |
| 2 | 「refuses when the manifest digest drifts from the inventory pin (verified tier)」 | 呈现 trust/integrity 变体，库存记录按默认 fixture 出具 | `inventoryFor(presented, { tier:"verified", recordedDigest: DIGEST_B })` | integrity-mismatch |
| 3 | 「accepts when BOTH pins hold」 | 呈现 verified 变体，库存记录按默认 fixture 出具 | `inventoryFor(verifiedManifest, { tier:"verified", recordedDigest: sha256Hex(ARTIFACT_BYTES_A) })` | accept |
| 4 | 「refuses a declared scope outside the host allowlist (superset)」 | 呈现扩权 scope 变体，库存记录按默认 fixture 出具 | `inventoryFor(presented)` | scope-not-allowlisted（detail 含 repo.write） |
| 5 | 「accepts when declared scopes are a subset of the allowlist」 | 呈现 `tests.run` 变体，库存记录按默认 fixture 出具 | `inventoryFor(presented)` | accept |
| 6 | 「empty allowlist refuses any non-empty scope declaration, but passes a scope-free plugin」 | 接受半段呈现 `scopes: []` 变体，库存记录按默认 fixture 出具 | 接受半段 `inventoryFor(presented)`（拒绝半段不变） | 拒绝半段 scope-not-allowlisted；接受半段 accept |

## (b) 补充：治理批次（2026-09-25 身份项）披露第 6 条遗漏 cli.test.ts

上文「治理披露：发布身份项落地（2026-09-25，维护者批准）」第 6 条当时只列
`packages/release-audit/test/repo-audit.test.ts`；同批同因还有
`packages/release-audit/test/cli.test.ts`：其「runs the full audit…」用例的
codeowners 断言同样由 placeholder-only 翻转为 rules-present（现为
`expect(report.governance?.codeowners.status).toBe("rules-present")`，附
「Governance-baseline update (2026-09-25, maintainer-approved)」注释）。
特此补充列明；该翻转与同批 repo-audit.test.ts 的治理基线更新完全同语义，
无任何断言放宽。

## (c) .gitignore 与 CHECKSUMS 冻结记录差异的精确重建

背景：`CHECKSUMS.sha256` 第 9 行记录 `.gitignore` 冻结哈希
`4f3f042afa9882a526b82ea5791ea100b41c2506f614cbd6707578a54bd77887`，当前
文件实测哈希为
`a69b9f5352f15d91290abdaed5797c7797c6fef95672125a7de8a3e7f71c4b4b`
（`planning-check` 第 (a) 步按设计跳过该行——项目明示允许增补 `.gitignore`）。
差异发生在规划包阶段，仓库无 git 历史，无法从仓库直接重建；本批次做了
**逐行删除组合的哈希穷举重建实验**（全程只读仓库，脚本与独立复核用的
重建文件在系统临时目录 `%TEMP%/gitignore-reconstruct/`；脚本的结果
JSON 因相对路径误写仓库根 `result.json` 一次，发现后已删除，未做任何
git 操作）：

- 方法：当前 `.gitignore` 为 LF 行尾、23 行、265 字节；按行拆分（保留行尾
  字节）后，枚举全部 2^23 = 8,388,608 个「删除行子集」候选——即检验「冻结
  文件是当前文件的保序子序列」这一假设——逐候选 sha256 与冻结值比对，每个
  候选另试「去末尾换行」变体。穷举在第一个命中即停（约几十个候选内命中）。
- 结果：**精确命中**。删除当前文件的第 3/4/5 行（0 起数）后与冻结哈希逐
  字节一致，即自冻结以来 `.gitignore` 恰新增以下三行，插在 `coverage/` 与
  `.plan-venv/` 之间：

  ```
  .turbo/
  *.tsbuildinfo
  .vitest/
  ```

  冻结版本即其余 20 行（`node_modules/` 起至 `runs/` 止，含末尾换行）。
- 独立复核：按重建结果拼出的文件用 `sha256sum` 实测为
  `4f3f042a…bd77887`（与 CHECKSUMS 记录逐字符一致）；「当前文件减这三行」
  与重建文件 `diff` 为空。
- 披露边界：实验精确回答「差了哪几行」；这三行的**加入时间与动机**无法从
  仓库证据重建，仅能指出内容与 `planning-check.mjs` 临时副本排除目录
  （`.turbo`、`.vitest`）及 turbo 增量构建产物（`*.tsbuildinfo`）对应。
  本批次未对 `.gitignore` 做任何修改。

## 治理披露：THIRD_PARTY_NOTICES 30 项待复核标注更新为已核实（2026-09-25）

维护者确认 reports/LICENSE-REVIEW-1.md 的 registry 复核结果后，本节披露以下冻结修改：

1. **THIRD_PARTY_NOTICES.md**：哈希 `6b8036f1…` → 见 CHECKSUMS 现值。原文头部
   保留；npm 依赖清单节重构——54 项已装依赖保持「本机安装件读取」分组，30 项
   未安装依赖由「unknown-deny 待复核」改为「registry 核实」分组（MIT 20 /
   MPL-2.0 10，逐条 npm view 查询，方法与记录见 LICENSE-REVIEW-1）。全部 84 个
   包名 token 保留（依赖审计覆盖判定不受影响，noticesCovered 仍应 84/84）。
2. **CHECKSUMS.sha256**：仅更新 THIRD_PARTY_NOTICES.md 一条记录。

至此 NOTICES 的「发布前须经 registry 复核」条件**满足**；MPL-2.0 复核结论
（未修改依赖 + 非运行时面 = 合规）以 LICENSE-REVIEW-1 §2 为准，最终确认权在
维护者。

## 治理披露：发布前文档收口（2026-09-26）

1. **CHANGELOG.md（冻结修改）**：哈希 见 CHECKSUMS 现值。追加 `0.1.0-rc —
   2026-09-26` 节（implemented/experimental/unverified 如实区分，数据取自
   M6-05 §3.2 与当前 1523/34/35/84 计数）；`0.1-draft` 原节一字未动。
2. **MAINTAINERS.md（冻结修改）**：哈希 `b2e86d8e…` → 见 CHECKSUMS 现值。
   MPL-2.0 门禁行由「复核仍待维护者完成」更新为「registry 复核与合规评估
   已完成（LICENSE-REVIEW-1），待维护者最终确认」。
3. **.gitignore（冻结例外增补）**：新增 `.zcode/` 与 `**/evidence/` 两行——
   前者为审查/工作流会话工件目录，后者为按次再生的测试证据目录；两者均为
   可再生产物、不应入版本库。该文件本为 planning-check 设计内跳过行（冻结
   记录 4f3f042a… 保持原样、不同步），本节即新增内容的披露。此归属决定属
   M6-05 §6 第 10 项，本披露为其执行。
4. **CHECKSUMS.sha256**：更新 CHANGELOG.md、MAINTAINERS.md 两条记录。
5. **reports/M6-05-release-candidate.md（追加 §10）**：§6 清单状态更新，
   不回写原文。

## 治理披露：git 仓库初始化（2026-09-26，维护者指示的发布准备第 3 步）

维护者指示将仓库初始化为 git 并准备推送 GitHub
（github.com/WeirdStar0/role-orchestrator，先私有后公开）。本节披露：

1. `git init -b main` + 初始提交（14bfeea，815 个文件——.gitignore 新增
   `validation-report.json` 一行：该文件为冻结校验脚本按次再生的输出工件，
   同类于 .turbo 构建产物，不应入版本库）。
2. 提交身份使用维护者已配置的 git 全局身份（WeirdStar0）。
3. 远端 origin = https://github.com/WeirdStar0/role-orchestrator.git；
   推送由维护者创建私有仓库并授权后执行。
4. 本节同时记录：该 git 初始化为维护者对 AGENTS.md「不 git 操作本仓库」
   约束的显式豁免指示，仅限发布准备用途；历史约束对开发/修复任务仍然有效。

## 治理披露：安全报告渠道配置为邮箱（2026-09-26）

维护者确认：GitHub private vulnerability reporting 的 Enable 区块在其账号的
仓库设置页（Settings → Advanced Security）中不存在（已尝试启用 Dependency
graph 后复找，社区讨论 #45567 记录过同型问题）。经维护者决定，渠道改配为
邮箱并完成本披露：

1. **SECURITY.md（冻结修改）**：哈希 `ae3199bb…` → 见 CHECKSUMS 现值。
   「报告渠道」节更新：私密安全联系方式 = weirdstar@outlook.com
   （2026-09-26 启用）；保留 GitHub private vulnerability reporting 首选
   地位与「渠道未配置前不要公开发布」纪律句；其余各节未动。
2. **MAINTAINERS.md（冻结修改）**：哈希 `b6ac62a9…` → 见 CHECKSUMS 现值。
   安全渠道条目同步（邮箱已配置 + PVR 界面限制登记 + 转公开前核验收信）。
3. **packages/release-audit/test/repo-audit.test.ts（既有测试基线更新）**：
   privateChannel 断言随治理翻转更新（not-configured-documented →
   contact-points-present，contactPointsFound 含邮箱）；同用例其余断言
   （codeowners/license/releaseApproval/identity）零改动。先例链第 6 次
   披露性基线更新。
4. **CHECKSUMS.sha256**：更新 SECURITY.md、MAINTAINERS.md 两条记录。

至此 M6-05 §6 第 3 项（安全报告渠道）**关闭**；release-audit 审计状态由
`not-configured-documented` 翻转为 `contact-points-present`。转公开前维护者
须核验 weirdstar@outlook.com 可正常收信。

## 治理披露：MPL-2.0 最终确认与发布批准（2026-09-26）

维护者于 2026-09-26 会话中明确答复「确认，批准」：

1. **MPL-2.0 最终确认（M6-05 §6 第 8 项关闭）**：签认 reports/LICENSE-REVIEW-1.md
   §2 的合规结论——lightningcss 家族以未修改依赖形式使用、全部位于 dev/test
   工具链、不在运行时交付面，符合 MPL-2.0，义务仅为保留声明（NOTICES 已满足）。
2. **发布批准（M6-05 §6 第 5 项关闭；RELEASE_PROCESS「维护者批准」完成）**：
   - 批准对象：tag `v0.1.0-rc` = 候选 SHA
     `79238fdb6b3d61265303bcc7ec0120f5641484a7`；
   - 批准人：Nick（维护者本人，会话内明确答复）；
   - 批准范围：候选代码内容与其验收状态；归档校验摘要
     `9d92cb62df2f15b77e7530b8cfec2392bb6474b80113b3f7047337a383e60472`；
   - 佐证链：reports/RELEASE-CANDIDATE.md（冻结记录）+ 本披露链全部条目。

备注：release-audit 的 `releaseApproval` 字段按设计恒报
`pending-maintainer`（其自身声明「审计永不替代人工批准」、无法从仓库状态
核验会话外的人工决定）；实际批准以本节与本仓治理文件为准。是否让审计读取
批准记录（如治理标记文件）属后续提案，不在本披露内实施。
