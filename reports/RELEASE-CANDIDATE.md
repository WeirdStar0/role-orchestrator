# 发布候选冻结记录（v0.1.0-rc，2026-09-26）

## 1. 候选标识

- **候选 SHA**：`79238fdb6b3d61265303bcc7ec0120f5641484a7`（main，已推送并经
  `git ls-remote` 远端确认）
- **标签**：`v0.1.0-rc`（annotated，指向上述候选提交）
- **仓库**：https://github.com/WeirdStar0/role-orchestrator（private，公开须
  在发布批准与安全渠道启用之后）

## 2. 候选时点验证状态（全部为本会话真实执行）

| 项 | 结果 |
|---|---|
| 五门（install --frozen-lockfile / typecheck / test / build / turbo --force） | 全 exit 0 |
| 测试 | **1523 通过 / 0 失败 / 0 跳过 / 34 个 vitest 套件**（1523 = 逐包求和） |
| 冻结面 | planning-check 78/78（.gitignore 为设计内跳过行，精确 diff 见 PROPOSALS 2026-09-25/26 披露）；校验器 sha256 `f829d286…` |
| 发布审计 | release-audit `blocking: []`；notices 84/84；license `formalized` + `candidate-matches-canonical`；codeowners `rules-present`（7 条 @WeirdStar0） |
| 边界审计 | boundary-audit `verdict: pass`、0 违规 |
| 迁移/备份/恢复 | `ro-maintenance upgrade-drill` 12 步 exit 0 |
| 端到端 | dogfood / e2e-baseline / browser-e2e 全绿（维护者验收日 2026-09-25，reports/MAINTAINER-ACCEPTANCE-2026-09-25.md） |
| 许可证 | 84 依赖 0 unknown；MPL-2.0 合规评估见 LICENSE-REVIEW-1（最终确认权在维护者） |
| Changelog | 0.1.0-rc 节（implemented/experimental/unverified 如实区分） |

## 3. 发布校验摘要

- 候选源码归档 sha256（`git archive --format=tar.gz v0.1.0-rc`）：
  `9d92cb62df2f15b77e7530b8cfec2392bb6474b80113b3f7047337a383e60472`
  （本地复算命令：`git archive --format=tar.gz v0.1.0-rc | sha256sum`）

## 4. 发布前剩余动作（全部为维护者动作，Agent 不代行）

1. **启用私密安全报告渠道**：仓库 Settings → Security → Private vulnerability
   reporting → Enable（SECURITY.md：渠道未配置前不公开发布）。
2. **MPL-2.0 最终确认**：签认 reports/LICENSE-REVIEW-1.md §2 的合规结论。
3. **维护者发布批准**：按 project/RELEASE_PROCESS.md 对本候选作出批准决定
   （governance.releaseApproval 当前 `pending-maintainer`，审计永不替代该批准）。
4. **GitHub 仓库设置**：main 分支保护（注意：私有仓库的分支保护需要 GitHub
   Pro；免费账户可在仓库转公开后配置，或升级账户）；required checks 视 CI
   引入情况另行决定。
5. **公开切换**：以上完成后将仓库可见性改 public（当前 private）。

## 5. 声明

本文件是冻结记录，不构成发布批准。候选内容以 SHA
`79238fdb6b3d61265303bcc7ec0120f5641484a7` 为准；其后的文档提交（含本文件）
不改变候选代码内容。

## 6. 批准记录（2026-09-26 追加）

维护者 Nick 于 2026-09-26 批准本候选（tag `v0.1.0-rc`，SHA `79238fd…`），
并确认 MPL-2.0 合规结论（LICENSE-REVIEW-1 §2）。完整记录见 PROPOSALS.md
2026-09-26 节与 M6-05 §12。本节为追加，未改 §0–§5。
