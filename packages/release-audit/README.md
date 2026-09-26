# @role-orchestrator/release-audit

M6-03「执行发布安全与许可核对」的可执行核对包：secrets 全仓扫描、依赖来源/许可审计、
Apache-2.0 候选文本核对、治理项盘点。所有结论以本包 API/CLI 的真实输出为准；
维护者专属决定（LICENSE 正式化、Codeowners、私密渠道、发布批准）只能出现在
「待维护者确认」状态里，本包没有任何把它们标记为「已确认」的代码路径。

## 组成

- `scanSecrets`（`src/secrets-scan.ts`）：全仓扫描（默认排除 `node_modules` / `dist` /
  `.turbo` 等）。文本文件按行匹配高置信度 secret 值形态（`sk-ant-`、`ghp_`、`AKIA`、
  `xox*`、JWT、`Bearer <token>` 等）；二进制文件只做文件名规则；`.env` 存在即结构性
  发现并逐行核对内容（`.env.example` 豁免）；`.npmrc` 只在含 `_authToken`/`_password`
  时报告；凭据形态文件名（`id_rsa`、`credentials.json`、`*.pem`、`*.key` 等）独立成发现。
  每条发现都分类：`desensitized-fixture` / `evidence-screenshot` / `synthetic-fixture`
  （已知保留，见 `KNOWN_RESERVATIONS`）、`test-sentinel`（测试目录内故意投放的脱敏
  哨兵值）、`known-fake-sentinel`（逐字匹配已知假凭据字面量，如 A36 测试的
  `livecred1234567890`）、其余一律 `needs-judgment` 并把 verdict 翻为 `findings`。
  预览一律掩码（前 6 字符 + 长度），扫描器从不输出完整匹配值。
- `auditDependencies`（`src/dependency-audit.ts`）：解析 `pnpm-lock.yaml`，对每个外部
  包（`@role-orchestrator/*` 之外）记录 name/version/registry/integrity/license/
  runtime 可达性；逐 workspace `package.json` 的 specifier 与 lockfile importer 交叉
  核对；`.npmrc` registry 覆盖与 lockfile `tarball:` 非默认来源单独上报。license 优先
  从 `node_modules/.pnpm` 安装清单读取（离线、即所用比特）；本机未安装的平台可选二进制
  包如实标 `not-installed-locally`，绝不猜测。`THIRD_PARTY_NOTICES.md` 覆盖面按精确包名
  计算（covered/uncovered 两个清单）。
- `checkLicenseCandidate`（`src/license-check.ts`）：把根目录 `LICENSE.proposed.txt` 与
  随包 fixture 中的 Apache-2.0 官方原文（`fixtures/apache-2.0-canonical.txt`，
  sha256 `cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30`）做两级
  对比：字节级与「措辞级」（空白归一化）。正式化状态只由 `LICENSE` 文件是否存在决定，
  不存在即 `pending-maintainer-confirmation`。
- `inventoryGovernance`（`src/governance.ts`）：`.github/CODEOWNERS` 生效规则数
  （非注释行）与模板标记；`SECURITY.md` 私密报告渠道的「文档声明未配置」状态与具体
  联系点（email）；`LICENSE` 正式化；发布批准恒为 `pending-maintainer`（结构性事实，
  本包不能批准发布）。
- `runReleaseAuditCli`（`src/cli.js` bin `ro-release-audit`）：
  `ro-release-audit [secrets|dependencies|license|governance|all] [repoRoot]`，
  JSON 输出；退出码 0 = 无阻断性审计结果（已知保留与待维护者项不算阻断）、
  1 = 存在阻断项、2 = 用法/前置错误。

## 测试

`pnpm vitest run`（turbo `test` 任务自动纳入）：

- 临时目录 fixture 树验证扫描/审计规则的正反两面（不碰真实仓库）；
- `test/repo-audit.test.ts` 对本仓库跑真实审计并钉住结论：secrets verdict、
  84 个外部依赖的完整 license 表、runtime 外部依赖恰为 `ws`/`yaml`/`zod`、
  候选文本与官方原文措辞一致、治理四项全为 pending/placeholder 现状。
  断言失败 = 仓库出现新的阻断项或审计规则变化，需要人看，不允许机械放宽。

## 边界

- 本包只读；不修改任何被扫描/审计对象。
- license 字段、身份字段、发布批准由维护者最终确认（见 `MAINTAINERS.md`）。
