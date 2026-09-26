# POLISH-1：发布后收尾批次报告（evidence 轮转 / FM-PROC-03 余量 / 注释措辞清理）

日期：2026-09-26 · 执行角色：Developer（抛光批次） · 范围：`packages/browser-e2e`、`packages/dogfood` 的 evidence 写入层及其测试、`packages/fault-matrix` 的 FM-PROC-03 用例预算、`packages/release-audit/test/cli.test.ts` 注释、`MAINTAINERS.md`（冻结，维护者授权的一处措辞）、`CHECKSUMS.sha256`（同步一行）、`PROPOSALS.md`（追加披露）、`packages/browser-e2e/vitest.config.ts`（P1 明示允许的 vitest 配置面）、本报告

本批次落地发布后登记的三项收尾：P1 evidence 目录轮转、P2 fault-matrix
FM-PROC-03 满载余量、P3 注释与措辞清理。安全边界与既有拒绝语义零改动：
全部 diff 中没有一条断言变更、没有一条拒绝路径变更、没有新增依赖（外部依赖
保持 84）、workspace 项目保持 35。所有退出码均为真实执行结果（命令原样记录
于 §5）。测试总数 1523 → 1543（新增 20 个轮转单测，既有用例零改动、零跳过）。

---

## 1. P1：evidence 目录轮转（browser-e2e + dogfood）

### 1.1 问题

两包每次测试运行在 `packages/<pkg>/evidence/` 下新增一个 `<label>-<UTC 时间戳>`
目录，无上限。本批次开工时实测：browser-e2e 已累积 **1386 个 run 目录 /
6282 个文件**（7 个 label × 198），dogfood **162 个目录 / 320 个文件**——两者
合计占全仓扫描树（7474 文件）的 88%，release-audit 的秘密扫描成本随测试
次数线性增长。

### 1.2 设计

两包 `src/evidence.ts` 各加入同构的轮转层（两包互不依赖，各自持有一份）：

- **纯函数决策**（`planRunDirRotation` + `splitRunDirName`）：输入目录名列表、
  当前 run 目录名、keepCount；只让能解析为 `<同 label>-<24 位定长时间戳形态>`
  的名字参与；按时间戳降序取前 keepCount 个为 `keep`，其余为 `delete`
  （最旧优先）。时间戳为零填充定长 UTC，字典序即时间序；stamp 校验是**形态级**
  （`\d` 数字形），日历语义无关紧要（机器生成、只按字典序排序）——此行为有
  单测钉住。
- **薄 fs 层**（`rotateRunDirs`）：io 可注入（测试用临时目录保持 hermetic）；
  根目录不可读 = no-op；逐目录删除失败记入 `failed` 返回，**绝不抛出**——
  清扫工作永不弄红测试。失败与轮转结果都写入当次 driver log 一行。
- **接线**：`Evidence.start(label, header, options?)` 在创建新 run 目录并写完
  header 后执行轮转（满足「写入新目录后删除」的时序）。
  - browser-e2e：**库默认关闭**，环境变量 `BROWSER_E2E_EVIDENCE_ROTATION="1"`
    （严格等于 "1"）或参数 `{ rotate: true }` 显式开启；包 vitest 配置设置该
    环境变量，使常规 `pnpm test` 运行自动轮转。
  - dogfood：**默认开启**（其唯一测试断言内存结果，从不回读 evidence 目录），
    `{ rotate: false }` 可关；无环境变量门。

### 1.3 轮转语义（何时删、删什么、绝不删什么）

- **何时删**：仅在某次运行创建新 run 目录之后、且该次运行显式启用轮转时；
  未启用时零删除。
- **删什么**：仅与当前 run 目录**同 label** 且符合 run 目录命名的更旧目录；
  每次保留最新 K 个（见 1.4 的 K=22），多余的按最旧优先删除。
- **绝不删**：当前这次运行的目录（按名字显式豁免删除集，同毫秒冲突也不可能
  入选）；**其他 label 的目录**（7 个 browser-e2e label 与 dogfood-chain 各自
  独立轮转，互不可见——这也是并行 worker 安全性的来源：vitest 每个测试文件
  有唯一 label，轮转族两两不相交）；非目录项与任何不符合命名的名字；
  evidence 根之外的任何路径。
- 因此每个**活跃** label 稳定保有 K 个目录：修后两轮全量测试实测 browser-e2e
  恰为 7 × 22 = **154 个目录 / 704 文件**（原 1386/6282），dogfood **22 / 44**
  （原 162/320）。已停跑的 label 不会被本轮轮转收缩（无新运行即无触发点），
  这是按 label 前缀轮转的语义边界，如实写明。

### 1.4 K 值偏离披露：批次指定 K=20 → 实测定为 22

对「轮转后扫描树」的实测（先用与 scanner 等价的只读脚本模拟，再用真实
scanner 复核）表明 **K=20 会打破不可改动面的冻结断言**：
`packages/release-audit/test/repo-audit.test.ts:25` 的
`expect(result.binaryFiles).toBeGreaterThan(500)`——K=20 时 binaryFiles 仅 481
（evidence PNG 是全仓 binaryFiles 的绝对主体，evidence 之外全仓只有 1 个
binary 文件）。该测试文件属于本批次明令不可改动面，故两包出厂常量取
**K=22**。修后真实 scanner 实测：**scannedFiles=1622（>1500）、
textFiles=1093（>900）、binaryFiles=529（>500）、verdict=known-reservations-only**
，三项计数断言全部保持绿色且有余量。纯函数按 `keepCount` 参数化，K=20 的
行为仍有单测钉住（25 假目录 → 保留最新 20、删除 5）；偏离只存在于常量
（`EVIDENCE_ROTATION_KEEP` / `DOGFOOD_EVIDENCE_ROTATION_KEEP` = 22）并在代码
注释与本节写明依据。**零断言改动**——这是新常量对既有断言的让位，不是断言
放宽。已同步披露于 PROPOSALS.md。

### 1.5 测试钉住（新增 20 个，全部 hermetic：临时目录/注入 io，无浏览器、无网络、无真实 CLI）

browser-e2e `test/evidence-rotation.test.ts`（11 个）：

- 命名解析：`<label>-<stamp>` 解析与全类型拒绝（纯文件、无 stamp 目录、缺
  分隔符、空 label、形态不符、stamp 后缀锚定）。
- 纯决策：25 假目录 → 保留最新 20、删除恰 5（批次指定用例）；少于 K 零删除；
  其他 label/文件/畸形名绝不进 keep 或 delete；keepCount=1 时当前目录也绝不
  入删除集；当前目录名不可解析时拒绝轮转。
- 环境门：默认关、严格 "1" 才开（"0"/"true"/"" 均不开）。
- 真实 fs（临时根）：恰删 5 个最旧同 label 目录、无关项原样、当前目录存活；
  根不可读 no-op；删除失败进 `failed` 不抛出。
- 真实 evidence 根接线（自清理 label，净足迹为零）：`rotate: true` 时 label
  被修剪到恰 K 个、当前目录存活；环境变量缺失时 `Evidence.start` 默认零删除。

dogfood `test/evidence-rotation.test.ts`（9 个）：同构纯决策/真实 fs 用例 +
真实根接线两条（默认开、`rotate: false` 关）。两个接线测试结束时自清理其
label 的全部目录，仓库 evidence 树不新增任何残留（实测确认为 0）。

### 1.6 P1 验证

- 两文件单测：browser-e2e 11/11、dogfood 9/9 绿（退出码 0）。
- 全量 `pnpm test` 后实测 evidence 树：154 目录/704 文件 + 22 目录/44 文件，
  且每 label 恰 22。
- 真实 scanner 复核（`runReleaseAuditCli(["secrets", repoRoot])`）：
  scanned=1622 / text=1093 / binary=529 / verdict=known-reservations-only。
- `repo-audit.test.ts:27-28` 的 reservation 前缀断言（含
  `packages/browser-e2e/evidence/`）在本批次两轮全量中持续成立——轮转每个
  活跃 label 至少保留一批。

## 2. P2：FM-PROC-03 kill 预算满载余量

### 2.1 症状与根因审查

FM-PROC-03（fake-cli grandchild 场景 + `timeoutSeconds: 2`，windows-native）
在满载 `turbo --force` 下曾复现超时失败（终审第 10 轮；记录见批次 ask）。
逐层审查代码后的结论：

- 用例的 vitest 级超时**早已不是** 5s 默认（该文件统一 240s），但满载下仍有
  两条饥饿路径超出其保护范围：
  1. 引擎 `killProcessTree` 的 `taskkill` spawn **没有内部超时**（引擎侧证据
     语义如此设计，kill 与自然退出竞速是 NORMAL outcome），spawn 饥饿时只能
     靠用例级预算兜底；
  2. 案例内三次 `expectPidGone(pid)` 用的是 process-lab 默认 **30s** 预算，而
     其每轮轮询可能花最多 **15s** 在一次 Win32_Process powershell.exe 查询上
     （process-lab 命令上限），两次慢查询即可耗尽 30s——即使整棵树已经死亡。
- **kill 预算 2s 是引擎语义不是测试旋钮**：它断言的是引擎在 2s 预算下杀树并
  落 `timeout` 原因的行为，本批次一字未动。

### 2.2 修复（仅预算，零断言语义弱化）

- `packages/fault-matrix/src/cases/process-boundary.ts`：FM-PROC-03 的三次
  `expectPidGone` 显式传 `FM_PROC_03_PID_GONE_WAIT_MS = 120_000`（原默认
  30_000）。断言仍是「pid 被证明死亡」，只是有界等待的余量加大；注释引用
  先例（FM-PROC-04 的 `probeTimeoutMs: 30_000`、reconcile
  `scan-store.test.ts` 的显式预算注释）与 15s/次的查询成本依据。
- `packages/fault-matrix/test/db-process-boundary.test.ts`：FM-PROC-03 用例级
  timeout 从共享 `TIMEOUT=240_000` 独立为 `FM_PROC_03_TIMEOUT = 420_000`，
  注释写明账目（世界搭建 + 引擎 kill 链（taskkill spawn 无内部上限，仅由
  此预算兜底）+ 3 × 120s 有界等待），保证每条等待都能各自出结果、真实失败
  仍报精确原因而非裸 vitest 超时。同文件其余 9 个用例的 240s 不变。

### 2.3 P2 验证（按 ask 要求的两层）

- **单包 3 次串行全绿**：`pnpm exec vitest run`（fault-matrix）×3，
  每轮 17/17 tests、3 files 全绿，退出码 0；耗时 90.65s / 87.39s / 94.30s；
  FM-PROC-03 每轮通过（含 matrix-driven 全矩阵驱动内的同名用例）。
- **全量 `--force` 一轮绿**：`pnpm exec turbo run test --force`（默认最大
  并发，0 缓存强制重跑）68/68 task 成功、退出码 0、34 包合计 1543 tests
  全过；本轮满载下 FM-PROC-03 实测 3764ms 通过。

## 3. P3：注释与措辞清理

- **(a)** `packages/release-audit/test/cli.test.ts` 原 23-25 行注释仍称
  "placeholder handle pending the real one"——更新为实际状态：CODEOWNERS
  规则-present（2026-09-25）且维护者 handle **@WeirdStar0** 已于 2026-09-25
  按治理流程录入，注释引用 PROPOSALS.md「治理披露：维护者 handle 替换占位符
  （2026-09-25）」。只改注释；断言与测试名一字未动。
- **(b)** `MAINTAINERS.md`（冻结，本批次获维护者授权的一处措辞更新）：MPL-2.0
  行由「……待维护者最终确认」更新为「维护者已最终确认（2026-09-26，
  `PROPOSALS.md` 披露「MPL-2.0 最终确认与发布批准」）」。同步 `CHECKSUMS.sha256`
  该行：`19704b8f…` → `e27728b5…`（仅此一行，其余 78 条未动）；修后
  `node planning-check.mjs` 退出码 0，(a) 步 78/78 一致。
- **(c)** `PROPOSALS.md` 追加「治理披露：POLISH-1 发布后收尾批次（2026-09-26）」
  一节：MAINTAINERS 冻结修改、K 值偏离、轮转语义、测试计数基线四项。

## 4. 冻结面与红线遵守

- 本批次实际改动文件全集（git status 实录）：两包 `src/evidence.ts`、两包
  新测试文件、browser-e2e `vitest.config.ts`、fault-matrix 的用例预算两文件、
  `release-audit/test/cli.test.ts`（仅注释）、`MAINTAINERS.md`（授权措辞）、
  `CHECKSUMS.sha256`（一行）、`PROPOSALS.md`（追加）、`reports/POLISH-1.md`
  （新建）。`.gitignore` 未改动（evidence 目录本就被 `**/evidence/` 忽略，
  轮转纯为本地文件系统行为，不入 git、不入 CHECKSUMS）。
- `docs/`、`schemas/`、`config/`、`prompts/`、`project/`、`contracts/`、
  `tools/`、`scripts/`、`.github/` 九个目录**零修改、零新增**（除
  CHECKSUMS/MAINTAINERS/PROPOSALS 的授权条目外未触碰任何冻结文件）。
- 未触碰 tag `v0.1.0-rc` 与历史提交；无 force push；未调任何真实
  claude/codex（全程 fake-cli dist bin，测试保持 hermetic）。
- 既有拒绝语义零变更：全 diff 无断言/校验规则/错误分类改动；
  `repo-audit.test.ts` 一字未动，其计数断言（35 workspace 包、84 外部依赖、
  扫描树三项、reservation 前缀）全部原样通过。

## 5. 验证命令与真实退出码（全部本机 win32 / Node v25.0.0 / pnpm v10.14.0 实跑）

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `pnpm install` | 0 | 35 workspace projects，lockfile up to date |
| `pnpm typecheck` | 0 | 57/57 tasks（4 个改动包重跑、53 缓存） |
| fault-matrix 单包 `pnpm exec vitest run` × 3 串行 | 0 / 0 / 0 | 每轮 17/17 tests、3 files 绿（90.65s / 87.39s / 94.30s） |
| browser-e2e `pnpm exec vitest run test/evidence-rotation.test.ts` | 0 | 11/11 |
| dogfood `pnpm exec vitest run test/evidence-rotation.test.ts` | 0 | 9/9 |
| `pnpm test`（全仓 turbo run test） | 0 | 68/68 tasks，1543 tests 全过 |
| `pnpm build` | 0 | 34/34 tasks |
| `pnpm exec turbo run test --force` | 0 | 68/68 tasks（0 cached），1543 tests，FM-PROC-03 满载 3764ms 通过 |
| `node planning-check.mjs` | 0 | (a) 78/78 校验和一致；(b) 干净副本 self-test 退出 0 |

测试计数：1523 → **1543**（+20 全部为新增轮转单测；数量对账：browser-e2e
18 = 原 7 文件 7 + 新 11；dogfood 10 = 原 1 + 新 9；其余包数量与基线一致）。

## 6. 风险与边界（如实）

- K=22 的余量是实测值（binary 529 对断言 500 余 29；scanned 1622 对 1500 余
  122）：若未来单个 flow 用例的截图数大幅减少，余量会收窄；届时应重测并再次
  披露，而不是回调断言。
- 已停跑 label 的历史目录不会自动收缩（按 label 前缀轮转的语义边界）；若
  需要一次性清理，属维护者手工动作，不在测试进程内做。
- 满载 flake 本质上不可按需确定性复现：P2 的两轮证据（单包 3 连绿 + 满载
  --force 一轮绿）是「修后未再复现」，不是「不可能再超时」的证明；但 420s
  用例预算与 120s 有界等待对全部已观测路径留有量化的充足余量。
- browser-e2e 轮转的环境变量门是包 vitest 配置层面的（常规测试运行自动
  开启）；库默认（非 vitest 引入方）仍为关闭，行为有单测钉住。
