# POLISH-2：维护批次报告（secrets-scan 遍历容错 / evidence 清理守则 / dogfood 删除失败注入 / 轮转测试时钟免疫 / 跨包漂移锚定）

日期：2026-09-27 · 执行角色：Developer（POLISH-2 维护批次） · 范围：`packages/release-audit/src/secrets-scan.ts` 及其测试、`USAGE.md`、`packages/browser-e2e/README.md`、`packages/dogfood/README.md`、两包 `test/evidence-rotation.test.ts`、`PROPOSALS.md`（追加）、本报告

本批次关闭 POLISH-1 终审分级的 2 项必须级 minor（#1、#9+#17）与 3 项小项
（#3、#7、#15 轻量版）。安全边界与既有拒绝语义零改动：全部 diff 中没有一条
断言弱化、没有一条拒绝路径变更、没有新增依赖（外部依赖保持 84、workspace
项目保持 35，`repo-audit.test.ts` 一字未动且全量通过）。所有退出码均为真实
执行结果（命令原样记录于 §5）。测试总数 1543 → **1548**（新增 5 个：T1 +1、
T3 +2、T5 +2；既有用例零改动、零跳过——T4 只改 1 行 fixture 时间戳基准，
断言未变）。

---

## 1. T1（必须级）：secrets-scan 目录遍历 ENOENT 容错

### 1.1 问题

`packages/release-audit/src/secrets-scan.ts` 的 `listFilesRecursive` 用裸
`readdirSync` 遍历目录。与 browser-e2e/dogfood 的 evidence 轮转并发时
（turbo 包级并行），目录在入栈与被 readdir 之间被删会抛未捕获 ENOENT 使整包
测试崩溃——文件级读取本就有 try/catch continue，目录级没有。

### 1.2 修复

`readdirSync` 包 try/catch：错误 `code === "ENOENT"`（且仅 ENOENT）时跳过该
目录继续遍历（被删目录不贡献文件，与下方逐文件读取的容错同构），其余错误
照抛。附注释引用 POLISH-1 轮转并发背景。真实仓库扫描结果不得变化——修后
release-audit CLI 实测 verdict=known-reservations-only、needs-judgment=0、
scanned 1629 / text 1100 / binary 529（§5），三项 pin 全绿。

### 1.3 测试（+1，注入 fs，hermetic）

`packages/release-audit/test/secrets-scan.test.ts`：以 `vi.mock("node:fs")`
部分覆写 `readdirSync`（vi.hoisted 门控，默认 null 时全部委托真实实现——文件
内其余 12 个既有用例的执行路径不变）：

- 遍历中某子目录 readdir 抛 ENOENT → 不崩、该目录贡献为零（scannedFiles=2、
  无任何 `rotated-away/` 发现）、其余文件照常扫出并完整分类
  （`src/planted.yaml` 的 anthropic-key 命中、needs-judgment、verdict
  findings）；
- 同一用例第二阶段钉住「仅 ENOENT」：门控改抛 EACCES → `scanSecrets` 照抛
  （零断言语义弱化）。

## 2. T2（必须级）：evidence 手工清理守则（纯文档，零代码）

- `USAGE.md` 第 8 节新增「evidence 目录手工清理守则（browser-e2e /
  dogfood）」小节：(a) 轮转机制一句话（每 label 保留最新 22、只删同 label
  更旧目录、删除失败只记 log 不弄红运行）；(b) 手工清理前必须先跑
  release-audit 复核三项扫描计数（scanned > 1500 / text > 900 / binary >
  500，即 `repo-audit.test.ts` 的 pin），清理后再复核，跌破任一即需要重测
  证据基线或调 K；(c) 停跑 label（每个约 75 PNG）的手工清理是 pin 破坏源
  警告——binary 实测 529 对 pin 500 只余 29 张 PNG，按每保留运行目录约 24
  张计恰为 POLISH-1 测得的约 1.208 个 K 档余量；(d)
  `BROWSER_E2E_EVIDENCE_ROTATION` 开关说明（严格 "1" 才开、库默认关、
  dogfood 无开关默认开 + `{ rotate: false }` 按次关）。
- `packages/browser-e2e/README.md`「截图与日志证据」节后新增「运行目录轮转
  （POLISH-1）与手工清理守则」小节：本包轮转语义 + 指向 USAGE.md 守则。
- `packages/dogfood/README.md` 新增「证据目录轮转（POLISH-1）与手工清理
  守则」一节：默认开启语义 + 指向 USAGE.md 守则。

## 3. T3：dogfood 删除失败容错注入单测（+2）

`packages/dogfood/test/evidence-rotation.test.ts` 此前没有删除失败路径的任何
覆盖（browser-e2e 有、dogfood 没有）。补两层：

- **注入 io 镜像用例**：镜像 browser-e2e
  `test/evidence-rotation.test.ts` 的既有 `removeTree` 抛错用例——注入 io 的
  `removeTree` 对首个受害者抛 EPERM → 断言结果进 `failed`（含 dir + error
  全文）、不抛出、其余目录照删（`deleted` 恰含另一个受害者）。
- **接线失败用例**：`vi.mock("node:fs")` 部分覆写 `rmSync`（hoisted 门控，
  默认直通真实实现），对真实 evidence 根自清理 label 的最旧受害者抛错，
  让**真实接线**（`Evidence.start` → `rotateRunDirs` → `nodeRotationIo`）端
  到端跑完一次失败：其余受害者照删（剩余目录数 = KEEP + 1 个删不掉的受害
  者）、运行本身不失败、**driver log 收到失败记录**（含 `FAILED 1`、目录
  名、`EPERM` 全文）。

## 4. T4 + T5：轮转测试时钟免疫与跨包漂移锚定

### 4.1 T4：fixture 时间戳基准 2026-09-26 → 2020-01-01（各 1 行）

两包 `test/evidence-rotation.test.ts` 的 `stamps()` 合成时间戳基准由
`Date.UTC(2026, 8, 26, …)` 改为 `Date.UTC(2020, 0, 1, …)`，并注明理由：fixture
必须严格老于任何真实 run 目录（真实 stamp 用墙钟）；原 2026-09-26 基准在墙钟
可达范围内——时钟回拨到基准之前会把 fixture 排得比真实目录更旧，接线断言
（25 目录 → 删 3）会因当前目录豁免而少删一个而失败。断言语义不变：全部既有
断言要么基于相对顺序、要么与基准无关（`startsWith("${LABEL}-2")` 对 2020
仍成立），无需适配。说明：批次授权面提到的「src/evidence.ts 的测试 fixture
时间戳」经逐一核对不存在——两包 `src/evidence.ts` 内没有 fixture 时间戳
（仅注释中的示例字面量），本批次对两个 `src/evidence.ts` **零改动**，T4 的
一行改动落在时间戳实际所在的两个测试文件。

### 4.2 T5：跨包漂移锚定向量（各 +1）

两包 `evidence-rotation.test.ts` 各加入**逐字相同**的 canonical 向量用例：
同一组目录名集合（5 个同 label 目录 + 1 个其他 label + 1 个普通文件）+ 同一
keepCount（2），对 `planRunDirRotation` 输出做整结构 `toEqual`（deep-equal）：
keep 降序 2 个、delete 最旧优先 3 个、异 label 与非 run 目录名被过滤。两包各
自钉住同一向量，未来任一单侧行为变化会立刻在测试 diff 中暴露（POLISH-1 #15
轻量版：不引入跨包依赖，两份字面量互为镜像）。

## 5. 验证命令与真实退出码（全部本机 win32 / Node v25.0.0 / pnpm v10.14.0 实跑）

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `pnpm install` | 0 | lockfile up to date |
| `pnpm typecheck` | 0 | 57/57 tasks |
| `pnpm build` | 0 | 34/34 tasks |
| release-audit 单包 `pnpm vitest run test/secrets-scan.test.ts` | 0 | 13/13（+1） |
| dogfood 单包 `pnpm vitest run test/evidence-rotation.test.ts` | 0 | 12/12（+3） |
| browser-e2e 单包 `pnpm vitest run test/evidence-rotation.test.ts` | 0 | 12/12（+1） |
| `pnpm test`（全仓 turbo run test） | 0 | 68/68 tasks，1548 tests 全过（2m44.8s） |
| `node planning-check.mjs` | 0 | (a) 77/77 一致（.gitignore 行按门禁设计跳过）；(b) 干净副本 self-test 退出 0 |
| release-audit CLI（`runReleaseAuditCli(["all", repoRoot])`） | 0 | secrets 分节：verdict=known-reservations-only、needs-judgment=0、scanned 1629 / text 1100 / binary 529（三项 pin 全绿） |
| boundary-audit CLI（`ro-boundary-audit .`） | 0 | verdict=pass、violations=[] |

测试计数：1543 → **1548**（+5 对账：secrets-scan 12→13；dogfood 轮转 9→12；
browser-e2e 轮转 11→12；其余包与基线一致，sum 由全量日志逐包汇总核实）。

## 6. 本机门禁环境事件（两起，均已由协调方处置，CI/新克隆不受影响）

全仓门禁在本批次验证期间暴露两起**与本批次改动无关**的本机环境事件，如实记
录（两者均为 gitignored/工作树副本层面的问题，git 内容零变化，CI 与新克隆
不受影响）：

1. **`.zcode/mm-venv` 污染扫描树**：2026-09-26 13:20 由工作流会话生成的
   Python venv（`.zcode/mm-venv`，gitignored 第 26 行，SSH 迁移的临时工件）
   使仓库级扫描树多出 2 个 needs-judgment（`certifi/cacert.pem` 文件名规则、
   `cryptography/.../ssh.py` 的 private-key-block 形态）——release-audit 的
   repo-audit/cli 共 3 个用例在本机转红（改动前的旧 dist 即可复现，非本批次
   引入）。协调方确认工件归属并删除后，本机扫描恢复基线（verdict=
   known-reservations-only、needs-judgment=0、scanned 1629 / text 1100 /
   binary 529）。维护者本机前一次全量测试日志（2026-09-26 11:20）早于该
   venv 生成，此前未暴露。
2. **`THIRD_PARTY_NOTICES.md` 的 Windows 工作副本 CRLF 残留**：CHECKSUMS 记录
   `86a6b110…` = git blob（LF）原样哈希，但本机磁盘副本是 CRLF（`09317993…`，
   mtime 2026-09-25 19:21，早于本会话；git status 判净证明 clean-filter 后
   内容与 blob 一致——纯 checkout 行尾残留，根因是 09-25 用 Python io.open
   生成时写了 CRLF，维护者批次已在 git 世界转为 LF）。协调方按
   Developer 提出的方案处置（rm + `git checkout --`，按 `.gitattributes`
   `eol=lf` 重新落盘，字节恰等于冻结记录）后，本机 planning-check 恢复
   77/77 全绿。

## 7. 冻结面与红线遵守

- 本批次实际改动文件全集（git status 实录）：`packages/release-audit/src/
  secrets-scan.ts`、`packages/release-audit/test/secrets-scan.test.ts`、
  `USAGE.md`、`packages/browser-e2e/README.md`、`packages/dogfood/README.md`、
  两包 `test/evidence-rotation.test.ts`、`PROPOSALS.md`（追加）、本报告
  （新建）。`CHECKSUMS.sha256` 记录的 77 个受检文件零改动（(a) 步 77/77）。
- `docs/`、`schemas/`、`config/`、`prompts/`、`project/`、`contracts/`、
  `tools/`、`scripts/`、`.github/` 九个目录**零修改、零新增**（含
  product-gates.yml 在内未触碰任何 `.github/` 文件）。
- 未触碰 tag `v0.1.0-rc` 与历史提交；无 force push；未调任何真实
  claude/codex（全部测试 hermetic：临时目录/注入 io/模块 mock，无浏览器、
  无网络、无真实 CLI）。
- 既有拒绝语义零变更：全 diff 无校验规则/错误分类/断言语义改动；
  `repo-audit.test.ts` 一字未动，其全部断言（35 workspace 包、84 外部依赖、
  扫描三项计数、reservation 前缀）在全量中原样通过。
- 备案（不在本批次实施）：未来一个经审查的批次可考虑把 gitignored 的
  `.zcode/` 加入 secrets-scan 默认 `excludeDirNames`（与 node_modules 同类
  的工具目录），避免本机工具工件再入扫描树；该改动属扫描语义变化，需按
  治理流程独立披露。

## 8. 风险与边界（如实）

- T1 的 ENOENT 容错只在「目录在遍历中途消失」这一竞态下生效；其他 readdir
  错误（权限、盘故障等）仍照抛——这是有意收紧而非疏漏，有第二阶段注入断言
  钉住。
- T3 的接线失败用例依赖模块 mock 的 `rmSync` 门控；mock 只作用于该测试文件
  的模块图且默认直通（其余用例路径不变）。若未来 dogfood evidence 层改用
  其他删除原语，该用例会如实转红提示更新。
- T4 消除的是「时钟回拨到 fixture 基准之前」这一窗口依赖；若机器时钟回拨
  到 2020-01-01 之前（极端场景）依赖仍在——属可接受的剩余风险，如需彻底
  免疫须注入时钟，超出本批次轻量范围。
- T5 的锚定向量是两份相同字面量（非共享模块）：单侧修 bug 忘同步时靠测试
  diff 暴露，不靠编译器；这是轻量版的设计边界。
- 满载（`turbo --force`）轮未在本批次重跑：本批次无任何时序敏感的产品路径
  改动（对照 POLISH-1 P2 的满载验证理由），全量常规轮 68/68 绿。
