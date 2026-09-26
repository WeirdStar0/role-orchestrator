# 维护者验收记录（2026-09-25）

执行人：维护者委托审查会话代跑（GLM-5.3，独立执行、未复用审查轮次缓存结果）。
环境：Windows 10.0.26100 x64 / Git Bash / Node v25.0.0 / pnpm 10.14.0。
本文件为新增记录，未触碰冻结面；全部退出码为当次真实执行所得。

## 1. 五门自检

| 命令 | 退出码 | 关键输出 |
|---|---|---|
| `pnpm install --frozen-lockfile` | 0 | Already up to date（35 workspace projects） |
| `pnpm typecheck` | 0 | 57 tasks（55 cached） |
| `pnpm test` | 0 | 68 tasks（64 cached），30.9s |
| `pnpm build` | 0 | 34 tasks（32 cached） |
| `pnpm exec turbo run test typecheck build --force` | 0 | **102 tasks / 0 cached / 4m31s 全量真实执行** |
| `turbo run test --force`（单独统计） | 0 | **34 个带测试包，合计 1503 通过**（剥离 ANSI 后逐包求和） |

分包核对：scm-contracts 74、plugin-registry 51、remote-worker 36、boundary-audit 26；1503 = 1316（M6 基线）+ 187（M7 新增）。

## 2. 冻结面与审计门

| 检查 | 结果 |
|---|---|
| `pnpm run planning:check` | exit 0：(a) 78/78 校验和一致（.gitignore 行按设计跳过）；(b) 干净副本 self-test exit 0 |
| `sha256sum scripts/validate_bundle.py` | `f829d28605441cdb3dd80de7b4f7c99d60bc10e6b5070984dbc03980f2342a6c`（与冻结记录逐字一致） |
| `python scripts/validate_bundle.py --self-test`（仓库内直跑） | **exit 1（预期）**：Broken local link（node_modules 断链，PROPOSALS.md 登记的已知保留问题） |
| `node packages/release-audit/dist/cli.js all .` | exit 0，`blocking: []`，secrets verdict `known-reservations-only` |
| `node packages/boundary-audit/dist/cli.js .` | exit 0，`verdict: "pass"`，violations 0，workspacePackageCount 34（packages/ 口径） |

## 3. 端到端演示实测

| 套件 | 退出码 | 结果 |
|---|---|---|
| `packages/dogfood`（M6-04 全链路+失败注入+恢复） | 0 | 1 测试通过，12.9s，8 次真实 fake-cli 子进程 |
| `packages/e2e-baseline`（M2 并行开发基准） | 0 | 6 文件 21 测试通过，97s 测试时间 |
| `packages/browser-e2e`（五条用户流程） | 0 | 7 测试通过，真实 Chromium，60s 浏览器时间 |

## 4. 运维演练

| 命令 | 退出码 | 结果 |
|---|---|---|
| `node packages/maintenance/dist/cli.js upgrade-drill` | 0 | 12 步完成：干净失败重试与备份恢复两条恢复分支均在真实迁移链（001..017）上证明 |

## 5. 结论

全部验收命令通过，无一项失败、无一项跳过。交付声明（1503 测试/34 带测试包/35 workspace 项目、冻结面完好、四审计 blocking 空、三条端到端基准真实跑通、升级演练可重复）全部独立复现。本记录构成维护者对 M0-M7 全部 41 项任务交付状态的验收确认依据；正式发布仍按 `project/RELEASE_PROCESS.md` 与 M6-05 §6 清单由维护者逐项决定。

*执行附带产物：`.zcode/acceptance-ra.json`、`.zcode/acceptance-ba.json`（审计 CLI 原始输出）；dogfood/browser-e2e 的 evidence 目录按既有机制按次再生。*
