# M6-03 · 执行发布安全与许可核对

状态：已完成（Reviewer 视角核对，含可执行复核包）。日期：2026-09-24。
对应任务：`docs/BACKLOG.md` M6-03（依赖 M6-01/M6-02，验收 A30/A32/A36/A42；完成标准「无 release-blocking 项，身份/许可字段由维护者确认」）。
交付物：本报告 + 可执行核对包 `packages/release-audit`（扫描/审计逻辑固化为 vitest 测试与 `ro-release-audit` CLI，经 turbo `build`/`test`/`typecheck` 任务自动纳入）。

## 0. 实测环境与冻结面（本会话真实执行）

| 项 | 值 | 命令与退出码 |
|---|---|---|
| OS / Node / pnpm | Windows 10.0.26100 x64 / v25.0.0 / 10.14.0 | `node -v`、`pnpm -v` |
| 冻结面完整性 | 通过：78/78 冻结文件 sha256 一致；干净副本 self-test exit 0 | `node planning-check.mjs` → exit 0 |
| 冻结脚本哈希 | `scripts/validate_bundle.py` sha256 `f829d28605441cdb3dd80de7b4f7c99d60bc10e6b5070984dbc03980f2342a6c`（未触碰） | `sha256sum scripts/validate_bundle.py` |
| 仓库内 self-test | exit 1（`node_modules` 断链扫入，已知保留问题，如实记录） | `python scripts/validate_bundle.py --self-test` → exit 1 |
| 变更前基线（真实执行，非缓存） | `pnpm exec turbo run test --force`：56/56 任务成功、0 缓存、全部测试通过 | exit 0 |
| git 纪律 | 本仓库保持非 git；会话内对本仓库未执行任何写类 git 操作 | 目录无 `.git` |

本任务新增/修改文件：新增 `packages/release-audit/**`（源码、测试、fixture、README）、`reports/M6-03-release-security.md`（本文件）；`package.json`/`pnpm-lock.yaml` 因新包登记而由 `pnpm install` 更新（自建工程文件，不属冻结面）。未触碰任何冻结文件（`planning-check` exit 0 为证）。

## 1. secrets 核对（A42 / A36）

### 1.1 扫描方法与清单

执行：`node packages/release-audit/dist/cli.js secrets .`（exit 0，verdict `known-reservations-only`）。

扫描范围：全仓递归，排除 `node_modules` / `dist` / `.turbo`（另含 `.git`/`coverage`/`.vitest`/`__pycache__`/`.plan-venv`）。实际盘点：

| 计数 | 值 |
|---|---|
| 扫描文件总数 | 1980（最终状态审计运行；E2E 证据目录随测试强制跑再生，数量随之增长） |
| 文本文件（内容逐行扫描） | 1057 |
| 二进制文件（仅文件名规则；内容不扫描） | 923 |
| 超限跳过 | 0 |
| 已知保留目录内文件 | 1260（E2E 证据 1235 + `packages/cli-events/fixtures-real/` 12 + `packages/fake-cli/fixtures/` 13） |

规则面（`packages/release-audit/src/secrets-scan.ts`）：

1. 值形态规则（高置信度）：`sk-ant-`、OpenAI 形态 `sk-`、`ghp_/gho_/ghu_/ghs_/ghr_`、`github_pat_`、`AKIA`+16 位、`xox*`、Google `AIza`、`npm_`、PEM 私钥块、JWT 三段式、`Bearer <token>`（16 字符以上）。
2. 结构规则：凭据形态文件名（`id_rsa`/`credentials.json`/`auth.json`/`.claude.json`/`.netrc`/`.git-credentials`/`.pypirc`/`*.pem`/`*.key`/`*.p12` 等）；`.env` 文件存在即结构性发现并逐行核对内容（`.env.example` 豁免）；`.npmrc` 仅在含 `_authToken`/`_password` 时报告；配置类扩展名（yaml/json/ini/toml/sh/ps1/cmd/bat）上的密钥形键赋值规则。
3. 分类（防止把已知保留误报为发布阻断）：`desensitized-fixture`（fixtures-real 脱敏真实流）、`evidence-screenshot`（E2E 截图）、`synthetic-fixture`（fake-cli）、`test-sentinel`（测试目录内故意投放的脱敏哨兵）、`known-fake-sentinel`（逐字匹配已知假凭据字面量，如 A36 红线测试统一使用的 `livecred…`，见 `packages/engine/test/persistence.test.ts:58`）、其余一律 `needs-judgment`。预览一律掩码，扫描器不输出完整匹配值。

### 1.2 逐项结论（全部 21 条命中）

verdict：`known-reservations-only`；`needs-judgment` 计数：**0**。无任何一条需要人工裁决的真实凭据形态。

| `.zcode/workflow-drafts/M1-batch2-fix-a36.dwf.ts:23` | bearer-credential | known-fake-sentinel |
| `.zcode/workflow-runs/dwfrun-5b60eeb2-50b3-4d98-a698-cd65453c5527.mjs:9` | bearer-credential | known-fake-sentinel |
| `packages/cli-events/test/redact.test.ts:37` | bearer-credential | test-sentinel |
| `packages/context-e2e/test/a36-diagnostic-export.test.ts:31` | openai-style-key | test-sentinel |
| `packages/engine/test/persistence.test.ts:58` | bearer-credential | known-fake-sentinel |
| `packages/engine/test/persistence.test.ts:102` | bearer-credential | test-sentinel |
| `packages/local-api/test/helpers.ts:135` | bearer-credential | test-sentinel |
| `packages/local-api/test/page.test.ts:77` | bearer-credential | test-sentinel |
| `packages/local-api/test/page.test.ts:102` | bearer-credential | test-sentinel |
| `packages/local-api/test/page.test.ts:125` | bearer-credential | known-fake-sentinel |
| `packages/local-api/test/server-dogfood.test.ts:62` | bearer-credential | known-fake-sentinel |
| `packages/release-audit/test/cli.test.ts:37` | anthropic-key | test-sentinel |
| `packages/release-audit/test/secrets-scan.test.ts:22` | anthropic-key | test-sentinel |
| `packages/release-audit/test/secrets-scan.test.ts:36` | github-token | test-sentinel |
| `packages/release-audit/test/secrets-scan.test.ts:46` | bearer-credential | test-sentinel |
| `packages/release-audit/test/secrets-scan.test.ts:94` | bearer-credential | test-sentinel |
| `packages/release-audit/test/secrets-scan.test.ts:103` | anthropic-key | test-sentinel |
| `packages/release-audit/test/secrets-scan.test.ts:104` | github-token | test-sentinel |
| `packages/release-audit/test/secrets-scan.test.ts:105` | aws-access-key-id | test-sentinel |
| `packages/release-audit/test/secrets-scan.test.ts:116` | bearer-credential | known-fake-sentinel |
| `packages/release-audit/test/secrets-scan.test.ts:117` | bearer-credential | test-sentinel |

判定依据：

- `test-sentinel`：命中行位于 `**/test/**`，是脱敏测试的输入哨兵（测试断言该值必须被替换/脱敏，例如 `packages/engine/test/persistence.test.ts:78` 断言落盘行不含该假值）。删除或替换它们会破坏既有测试，属于「必须保留」项。
- `known-fake-sentinel`：逐字包含 `livecred1234567890` 这一已知假字面量（A36 测试统一假值）；其中两条位于 `.zcode/`（本机 agent 工作流的草稿/运行记录，同字符串逐字复制自 A36 测试），非仓库产品内容。
- `packages/cli-events/fixtures-real/` 内容扫描 **0 命中**：脱敏真实流中无任何值形态命中，与各 `manifest.json` 声明的脱敏规则（session_id/uuid → 占位符、用户名路径 → `<user>`、hook 输出 → `[hook output redacted…]`）一致。
- `packages/browser-e2e/evidence/` 923 个 PNG 为二进制，仅文件名规则；作为 M5 验收证据保留（该目录由 browser-e2e 测试按次再生，本会话两次全量强制跑后为 1235 个文件）。

### 1.3 结构性核对（文件名 / .env / .npmrc）

| 检查 | 结果 |
|---|---|
| `.env`/`.env.*` 文件 | 0 个（仓库内无；`.gitignore` 亦排除） |
| 凭据形态文件名（id_rsa/credentials.json/auth.json/*.pem/*.key…） | 0 个命中 |
| `.npmrc` | 根目录 1 个，仅 `auto-install-peers`/`strict-peer-dependencies` 两行，无 `_authToken`/`_password` |
| 根 `.gitignore` 凭据卫生 | 已覆盖 `.env`/`.env.*`/`**/auth.json`/`**/.credentials.json`/`*.db` 等 |

A42 结论：当前仓库树不含 auth 文件、API key、原始用户 transcript 形态内容；全部命中均为已判定的测试哨兵/已知假值。A36 的落盘脱敏证据见 §4。

## 2. 依赖来源核对（lockfile vs package.json / registry / license / notices）

执行：`node packages/release-audit/dist/cli.js dependencies .`（exit 0，blocking 空）。

### 2.1 一致性与来源

| 检查 | 结果 |
|---|---|
| lockfile | `pnpm-lock.yaml`，lockfileVersion 9.0 |
| workspace 项目 | 30（根 + 29 包，含本任务新增 `packages/release-audit`） |
| 外部依赖（`@role-orchestrator/*` 之外，name@version 去重） | 84 |
| package.json specifier ↔ lockfile importer 不一致 | **0** |
| 无 resolution integrity 的 lockfile 条目 | **0**（84/84 全部 integrity 钉住） |
| 非默认 registry（lockfile `tarball:` 条目） | **0**（lockfile 内无任何 registry URL；`.npmrc` 无 `registry=` 覆盖 → 全部来自默认 `https://registry.npmjs.org/`） |
| 运行时（runtime 可达）外部依赖 | 恰为 `ws@8.21.3`、`yaml@2.9.1`、`zod@4.6.5`；其余 81 个均为 dev/test 工具链（vitest/vite/rolldown/typescript/turbo/@types 等），不进入 `files: ["dist"]` 交付面 |

### 2.2 第三方许可表（84/84 全覆盖，0 unknown）

license 来源两级：`manifest` = 本机 `node_modules/.pnpm` 安装清单（54 个，即实际所用比特）；`registry(npm view)` = 本机未安装的平台可选二进制（30 个，`npm view <name>@<version> license --json` 批查，exit 0）。汇总：MIT 65（44 manifest + 21 registry）、Apache-2.0 4（`playwright-core`/`typescript`/`detect-libc`/`expect-type`）、ISC 3、BSD-3-Clause 1、MPL-2.0 11（lightningcss 全家族）。

| 依赖 | license | 来源 | runtime | 直接/传递 |
|---|---|---|---|---|
| @jridgewell/sourcemap-codec@1.6.0 | MIT | manifest | dev/test | transitive |
| @oxc-project/types@0.150.0 | MIT | manifest | dev/test | transitive |
| @rolldown/binding-android-arm-eabi@1.2.9 | (本机未安装) | registry(npm view) | dev/test | transitive |
| @rolldown/binding-android-arm64@1.2.9 | (本机未安装) | registry(npm view) | dev/test | transitive |
| @rolldown/binding-darwin-arm64@1.2.9 | (本机未安装) | registry(npm view) | dev/test | transitive |
| @rolldown/binding-darwin-x64@1.2.9 | (本机未安装) | registry(npm view) | dev/test | transitive |
| @rolldown/binding-freebsd-x64@1.2.9 | (本机未安装) | registry(npm view) | dev/test | transitive |
| @rolldown/binding-linux-arm-gnueabihf@1.2.9 | (本机未安装) | registry(npm view) | dev/test | transitive |
| @rolldown/binding-linux-arm64-gnu@1.2.9 | (本机未安装) | registry(npm view) | dev/test | transitive |
| @rolldown/binding-linux-arm64-musl@1.2.9 | (本机未安装) | registry(npm view) | dev/test | transitive |
| @rolldown/binding-linux-ppc64-gnu@1.2.9 | (本机未安装) | registry(npm view) | dev/test | transitive |
| @rolldown/binding-linux-s390x-gnu@1.2.9 | (本机未安装) | registry(npm view) | dev/test | transitive |
| @rolldown/binding-linux-x64-gnu@1.2.9 | (本机未安装) | registry(npm view) | dev/test | transitive |
| @rolldown/binding-linux-x64-musl@1.2.9 | (本机未安装) | registry(npm view) | dev/test | transitive |
| @rolldown/binding-openharmony-arm64@1.2.9 | (本机未安装) | registry(npm view) | dev/test | transitive |
| @rolldown/binding-win32-arm64-msvc@1.2.9 | (本机未安装) | registry(npm view) | dev/test | transitive |
| @rolldown/binding-win32-x64-msvc@1.2.9 | MIT | manifest | dev/test | transitive |
| @rolldown/pluginutils@1.0.1 | MIT | manifest | dev/test | transitive |
| @standard-schema/spec@1.1.0 | MIT | manifest | dev/test | transitive |
| @turbo/darwin-64@2.11.2 | (本机未安装) | registry(npm view) | dev/test | transitive |
| @turbo/darwin-arm64@2.11.2 | (本机未安装) | registry(npm view) | dev/test | transitive |
| @turbo/linux-64@2.11.2 | (本机未安装) | registry(npm view) | dev/test | transitive |
| @turbo/linux-arm64@2.11.2 | (本机未安装) | registry(npm view) | dev/test | transitive |
| @turbo/windows-64@2.11.2 | MIT | manifest | dev/test | transitive |
| @turbo/windows-arm64@2.11.2 | (本机未安装) | registry(npm view) | dev/test | transitive |
| @types/chai@5.2.3 | MIT | manifest | dev/test | transitive |
| @types/deep-eql@4.0.2 | MIT | manifest | dev/test | transitive |
| @types/estree@1.0.9 | MIT | manifest | dev/test | transitive |
| @types/node@25.9.8 | MIT | manifest | dev/test | direct |
| @types/ws@8.18.1 | MIT | manifest | dev/test | direct |
| @vitest/expect@4.1.11 | MIT | manifest | dev/test | transitive |
| @vitest/mocker@4.1.11 | MIT | manifest | dev/test | transitive |
| @vitest/pretty-format@4.1.11 | MIT | manifest | dev/test | transitive |
| @vitest/runner@4.1.11 | MIT | manifest | dev/test | transitive |
| @vitest/snapshot@4.1.11 | MIT | manifest | dev/test | transitive |
| @vitest/spy@4.1.11 | MIT | manifest | dev/test | transitive |
| @vitest/utils@4.1.11 | MIT | manifest | dev/test | transitive |
| assertion-error@2.0.1 | MIT | manifest | dev/test | transitive |
| chai@6.2.2 | MIT | manifest | dev/test | transitive |
| convert-source-map@2.0.0 | MIT | manifest | dev/test | transitive |
| detect-libc@2.1.2 | Apache-2.0 | manifest | dev/test | transitive |
| es-module-lexer@2.3.2 | MIT | manifest | dev/test | transitive |
| estree-walker@3.0.3 | MIT | manifest | dev/test | transitive |
| expect-type@1.4.0 | Apache-2.0 | manifest | dev/test | transitive |
| fdir@6.5.0 | MIT | manifest | dev/test | transitive |
| fsevents@2.3.3 | (本机未安装) | registry(npm view) | dev/test | transitive |
| lightningcss@1.33.0 | MPL-2.0 | manifest | dev/test | transitive |
| lightningcss-android-arm64@1.33.0 | (本机未安装) | registry(npm view) | dev/test | transitive |
| lightningcss-darwin-arm64@1.33.0 | (本机未安装) | registry(npm view) | dev/test | transitive |
| lightningcss-darwin-x64@1.33.0 | (本机未安装) | registry(npm view) | dev/test | transitive |
| lightningcss-freebsd-x64@1.33.0 | (本机未安装) | registry(npm view) | dev/test | transitive |
| lightningcss-linux-arm-gnueabihf@1.33.0 | (本机未安装) | registry(npm view) | dev/test | transitive |
| lightningcss-linux-arm64-gnu@1.33.0 | (本机未安装) | registry(npm view) | dev/test | transitive |
| lightningcss-linux-arm64-musl@1.33.0 | (本机未安装) | registry(npm view) | dev/test | transitive |
| lightningcss-linux-x64-gnu@1.33.0 | (本机未安装) | registry(npm view) | dev/test | transitive |
| lightningcss-linux-x64-musl@1.33.0 | (本机未安装) | registry(npm view) | dev/test | transitive |
| lightningcss-win32-arm64-msvc@1.33.0 | (本机未安装) | registry(npm view) | dev/test | transitive |
| lightningcss-win32-x64-msvc@1.33.0 | MPL-2.0 | manifest | dev/test | transitive |
| magic-string@0.30.21 | MIT | manifest | dev/test | transitive |
| nanoid@3.3.19 | MIT | manifest | dev/test | transitive |
| obug@2.2.1 | MIT | manifest | dev/test | transitive |
| pathe@2.0.3 | MIT | manifest | dev/test | transitive |
| picocolors@1.1.1 | ISC | manifest | dev/test | transitive |
| picomatch@4.0.7 | MIT | manifest | dev/test | transitive |
| playwright-core@1.61.0 | Apache-2.0 | manifest | dev/test | direct |
| postcss@8.5.28 | MIT | manifest | dev/test | transitive |
| rolldown@1.2.9 | MIT | manifest | dev/test | transitive |
| siginfo@2.0.0 | ISC | manifest | dev/test | transitive |
| source-map-js@1.2.1 | BSD-3-Clause | manifest | dev/test | transitive |
| stackback@0.0.2 | MIT | manifest | dev/test | transitive |
| std-env@4.2.0 | MIT | manifest | dev/test | transitive |
| tinybench@2.9.0 | MIT | manifest | dev/test | transitive |
| tinyexec@1.3.1 | MIT | manifest | dev/test | transitive |
| tinyglobby@0.2.17 | MIT | manifest | dev/test | transitive |
| tinyrainbow@3.1.1 | MIT | manifest | dev/test | transitive |
| turbo@2.11.2 | MIT | manifest | dev/test | direct |
| typescript@5.9.3 | Apache-2.0 | manifest | dev/test | direct |
| undici-types@7.24.6 | MIT | manifest | dev/test | transitive |
| vite@8.3.0 | MIT | manifest | dev/test | transitive |
| vitest@4.1.11 | MIT | manifest | dev/test | direct |
| why-is-node-running@2.3.0 | MIT | manifest | dev/test | transitive |
| ws@8.21.3 | MIT | manifest | runtime | direct |
| yaml@2.9.1 | ISC | manifest | runtime | direct |
| zod@4.6.5 | MIT | manifest | runtime | direct |

MPL-2.0 说明：MPL-2.0 为弱 copyleft，对「未修改、以依赖形式使用」的库不传染本仓库（Apache-2.0 候选）许可；11 个 MPL-2.0 全部是 lightningcss/vite 工具链传递依赖，runtime 交付面（ws/yaml/zod）不含它。仍列入「待维护者确认」供发布决策复核，不构成本地核心的阻断。

### 2.3 THIRD_PARTY_NOTICES 覆盖核对

按精确包名计算（词边界匹配，避免 `PyYAML` 误判 npm `yaml`）：**covered = 0 / 84**。`THIRD_PARTY_NOTICES.md` 当前只记录了 Python 静态检查依赖（PyYAML、jsonschema）并声明「产品依赖将在 M0 锁定后另行记录」；M0 已锁定而该文件尚未更新，是**发布前必办项**（该文件属冻结根目录 `.md`，本任务只能如实报告，不能代改）。见 §6 清单第 2 项。

## 3. LICENSE 候选核对

执行：`node packages/release-audit/dist/cli.js license .`（exit 0，blocking 空）。

| 项 | 值 |
|---|---|
| 候选文件 | `LICENSE.proposed.txt`，sha256 `af975c9737b3bdcdcf7ec3512b3dc936f91cc58a3c9152a8e4b0803f667df6b9` |
| 官方原文 | Apache License 2.0（http://www.apache.org/licenses/LICENSE-2.0.txt ，本会话 `curl` 实取），sha256 `cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30`；已作为 fixture 存于 `packages/release-audit/fixtures/apache-2.0-canonical.txt` |
| 字节级 | 不一致（官方文本有前导空行与 3 空格段首缩进；候选为左对齐排版） |
| 措辞级（空白归一化逐行对比） | **完全一致：0 行差异，逐词一致** —— 候选即标准 Apache-2.0 文本，无任何字句改动 |
| 正式化状态 | **候选未正式化**：仓库无 `LICENSE` 文件；`project/LICENSING.md` 明确「当前文件不是正式仓库 LICENSE，不代表维护者已作法律授权决定」「公开发布前由维护者确认」 |

结论：候选文本与官方原文措辞逐字一致，可作为正式化输入；但 LICENSE 正式化（放置 `LICENSE`、填写版权/NOTICE 字段）是维护者专属决定，本任务不代行，列入 §6 清单第 1 项。`test/repo-audit.test.ts` 已钉住：措辞一致、字节不一致、`pending-maintainer-confirmation`。

## 4. A30 / A32 / A36 回归核对（引用既有证据 + 本会话真实复跑）

A30（外部网页请求 localhost API/WS → Host/Origin/会话检查阻止）：

- 代码事实：`packages/local-api/src/guard.ts:78`（DNS-rebinding 安全的精确 Host 检查）、`guard.ts:117`（Origin 检查，mutating 请求强制 loopback Origin）、`guard.ts:153`（Bearer 会话令牌常数时间比较）、`guard.ts:173`（会话绑定 CSRF）、`guard.ts:67`（loopback 远端地址纵深防御）。
- 本会话复跑：`pnpm exec vitest run test/guard.test.ts test/token.test.ts test/sanitize.test.ts test/server-matrix.test.ts test/diagnostics-export.test.ts`（packages/local-api）→ **59/59 通过，exit 0**。

A32（CLI 不能证明强沙箱 → UI 标记 Local Trusted 或拒绝对应模式）：

- 代码/配置事实：`config/policies.yaml:13` `mode: local-trusted`；`packages/contracts/src/schema/policies.ts:27` 仅允许 `local-trusted`/`hardened` 枚举；M6-01 补测的姿态不变量 `packages/capability-gate/test/registry.test.ts:217`（「A31/A32 posture」：沙箱相邻格保持 unverified 且不可用，不得宣称 Hardened）。
- 本会话复跑：packages/capability-gate 全量 → **18/18 通过，exit 0**；packages/contracts 全量（含 policies 示例校验）→ **44/44 通过，exit 0**。本仓库无任何 Hardened 宣称，与 `docs/SECURITY_MODEL.md` 一致。

A36（日志含伪造 HTML/secret/escape → 渲染消毒、落盘前脱敏）：

- 代码事实：落盘前脱敏单一事实来源 `packages/cli-events/src/redact.ts:40`（`DEFAULT_REDACTION_PATTERNS`，幂等、fail-closed）；engine 全部事件写入经 `appendRedactedEvent`（`packages/engine/src/persistence.ts:54`，调用点 `packages/engine/src/lifecycle.ts:479/534`）；渲染消毒 `packages/local-api/src/sanitize.ts`（`escapeHtml` 先于 DOM）。
- 本会话复跑：packages/cli-events 全量（含 redact + 脱敏真实流 contract 测试）→ **147/147 通过，exit 0**；`packages/engine` `test/persistence.test.ts` → **3/3 通过，exit 0**（测试直接读回原始行断言「库内已脱敏」）；`packages/context-e2e/test/a36-diagnostic-export.test.ts` → **3/3 通过，exit 0**（导出脱敏二次扫描）。local-api 子集（sanitize/diagnostics-export）含于上述 59 项。

回归结论：A30/A32/A36 现有实现无回退，验收证据可复跑。

## 5. Codeowners 与私密渠道现状盘点（如实记录，绝不伪造已配置）

执行：`node packages/release-audit/dist/cli.js governance .`（exit 0；治理 pending 项按设计不计入阻断）。

| 项 | 现状（机器可核） |
|---|---|
| `.github/CODEOWNERS` | 存在；**生效规则 0 条**（全部 9 行为注释）；含模板标记「Replace with verified GitHub handles before public release」→ `placeholder-only`，当前不强制任何 ownership |
| 私密安全报告渠道 | `SECURITY.md` 明文「公开仓库发布之前，维护者必须启用并验证 GitHub private vulnerability reporting」「当前文档不虚构邮箱」「渠道未配置前不要公开发布」；文档中 0 个具体联系点 → `not-configured-documented` |
| 维护者身份字段 | `MAINTAINERS.md` 明文「GitHub handle、正式仓库组织、公开联系渠道、安全私密渠道尚未填写」 |
| 发布批准 | 不存在任何发布批准记录；`project/RELEASE_PROCESS.md` 要求「维护者批准 → 签名或发布校验摘要 → 发布」。Agent 不是发布批准主体 |

以上全部为**待维护者确认**项（§6）；本报告与核对包中没有任何把它们标记为「已确认」的路径（`packages/release-audit/src/governance.ts` 的状态机只输出 pending/placeholder/not-configured）。

## 6. release-blocking 项清单与待维护者确认清单

### 6.1 release-blocking（M6-03 门内）

**空。** A42 类内容阻断（auth/API key/原始 transcript）：0（§1）；A30/A32/A36 回归：全部通过（§4）；依赖一致性与完整性：0 缺陷（§2）；LICENSE 候选文本：与官方原文逐字一致（§3）。

### 6.2 待维护者确认清单（本任务不代行、不伪造）

1. **LICENSE 正式化**：将逐字一致的 Apache-2.0 候选文本放置为正式 `LICENSE`，确认版权归属与附录版权行；确认前仓库不得对外宣称已可按开源许可使用（`project/LICENSING.md` 既有约束）。
2. **THIRD_PARTY_NOTICES.md 更新**：当前对 84 个 npm 外部依赖覆盖为 0/84；发布前按冻结文档治理流程补记产品/工具链依赖的许可与使用路径，并同步 `CHECKSUMS.sha256`。
3. **Codeowners**：以真实维护账号替换 `.github/CODEOWNERS` 模板（当前 0 条生效规则）。
4. **私密安全报告渠道**：启用并验证 GitHub private vulnerability reporting 或等效私密渠道；渠道未配置前不公开发布（`SECURITY.md` 既有约束）。
5. **维护者身份字段**：真实 handle/组织/联系渠道（`MAINTAINERS.md`）。
6. **发布批准（M6-05）**：人工批准 + 候选 SHA 冻结 + 签名/校验摘要；本报告不是发布权限。
7. **MPL-2.0 复核**（供发布决策）：确认以未修改依赖形式使用 lightningcss 家族（11 个，全部 dev/test 工具链）符合其许可与发行预期。
8. **建议（非许可事项）**：`.zcode/`（本机 agent 工作流草稿/运行记录）未列入 `.gitignore`，公开仓库前建议维护者决定其归属（忽略或不随仓库发布）；本任务未改动 `.gitignore`。

## 7. 可执行核对（固化）

- 包：`packages/release-audit`（strict TS、ESM、`.js` 相对导入、zod `strictObject` 输入、类型化错误 + `cause`）。
- 测试：`pnpm exec vitest run`（packages/release-audit）→ **42/42 通过，exit 0**。其中 `test/repo-audit.test.ts` 对本仓库跑真实审计并钉住全部结论（secrets verdict、84 依赖 license 表、runtime 外部依赖恰为 ws/yaml/zod、notices 0 覆盖、license 措辞一致、治理四项 pending）；断言失败即仓库出现新阻断项或审计规则变化，需人工复核。
- CLI：`ro-release-audit [secrets|dependencies|license|governance|all] [repoRoot]`，JSON 输出，退出码 0/1/2。
- turbo 自动登记：`pnpm build` / `pnpm test` / `pnpm typecheck` 均含本包（见 §8）。

## 8. 本会话验证命令与真实退出码

| 命令 | 退出码 | 说明 |
|---|---|---|
| `pnpm exec turbo run test --force`（变更前基线） | 0 | 56/56 任务真实执行（0 缓存），既有测试全绿 |
| `pnpm exec vitest run`（packages/release-audit） | 0 | 42/42 |
| `pnpm typecheck`（全仓） | 0 | 52/52 任务成功 |
| `pnpm build`（全仓） | 0 | 29/29 任务成功 |
| `pnpm test`（全仓） | 0 | 58/58 任务成功（56 个为基线强制跑的 turbo 缓存回放，2 个真实执行） |
| `pnpm exec turbo run test --force`（最终状态全量强制复跑） | 0 | **58/58 任务、0 缓存、真实执行；1311 个测试全部通过（164 个测试文件、29 包），0 failed / 0 skipped（fault-matrix 平台门控 15/15 allPassed）** |
| `node planning-check.mjs` | 0 | 78/78 冻结文件一致；干净副本 self-test exit 0 |
| `python scripts/validate_bundle.py --self-test`（仓库内） | 1 | 已知保留问题（node_modules 断链扫入），如实记录 |
| A30/A32/A36 回归子集（§4） | 全部 0 | 59 + 18 + 147 + 3 + 3 + 44 |
| `node packages/release-audit/dist/cli.js all .` | 0 | blocking 空 |

测试计数说明：任务描述引用的「既有 1232 个测试」为较早里程碑的计数；本次最终状态全量强制跑为 **1311 个测试通过**，其中 42 个为本任务新增（release-audit），**既有测试 1269 个全部通过、零跳过、零删除**（1269 > 1232，差额来自 M6-01/M6-02 已交付的合法新增，如 M6-01 披露的 capability-gate 15→18 与 M6-02 的 maintenance 25 项）。变更前基线强制跑 exit 0（56/56），但其逐包计数因日志截断未留存，如实声明；最终状态的全量真实执行以上行为准。

## 9. 未验证项与偏离声明

- 本机未安装的 30 个平台可选二进制（rolldown/turbo/lightningcss 平台包、fsevents）：license 取自 npm registry（本会话实查），其二进制内容与运行行为本机未执行、未验证；registry 返回值反映 2026-09-24 查询时点。
- `packages/browser-e2e/evidence/` 的 923 个 PNG 为二进制证据，按设计未做内容级 secret 扫描（仅文件名规则）；其作为 M5 验收证据的图像内容未逐帧人工复核。
- LICENSE「措辞一致」基于空白归一化对比；法律效力确认（正式化、版权归属）属维护者职责，本报告不构成法律意见。
- 仓库内 `validate_bundle.py --self-test` exit 1 为既有已知保留问题（`node_modules` 断链扫入），未修复（冻结脚本不可触碰）；干净副本中 exit 0。
- 本会话早期曾以只读 `git status` 探测仓库状态一次，返回 not a git repository（未做任何写类 git 操作；此后未再执行）。
