# 开发启动入口

本仓库已是可运行的产品：本地任务工作台（桌面壳 + 回环 serve + 浏览器页面），
把 Claude Code CLI 与 Codex CLI 编排进四个固定角色。产品现状与上手路径见
[README.md](README.md)；当前里程碑与任务清单见 [docs/BACKLOG.md](docs/BACKLOG.md)。
历史规划期（0.1-draft，M0-M7）的「从这里开始写代码」任务已全部完成——
[docs/REQUIREMENTS_BASELINE.md](docs/REQUIREMENTS_BASELINE.md)、
[DEVELOPMENT_PLAN.md](DEVELOPMENT_PLAN.md) 与 project/ 规划期文件保留为
历史记录（文件头已标注 historical），不再是执行清单。

## 可交给开发 Agent 的首个任务

```text
读取 AGENTS.md、docs/BACKLOG.md（当前里程碑行）、reports/ 最新批报告的
交接节与 PROPOSALS.md 最新披露节。

按 BACKLOG 当前未完成任务工作：
1. 确认该任务的输入、验收、依赖与允许路径；范围外问题提交提案，不自行扩大。
2. 修改冻结面（CHECKSUMS.sha256 在册）文件后，按盘上纯 LF 字节重算对应行。
3. 提供实际运行的门禁结果与退出码（typecheck/build/test、planning-check），
   未执行项如实标注；缺失命令或环境无法运行时明确报告。
4. 不自动合入 main，不 push/tag（发布属维护者流程），不修改治理/安全策略。
5. 输出变更摘要、实际变更文件、测试及退出结果、未验证项、风险与下一任务依赖。
```

## 实现细节的裁决口径

CLI 版本兼容范围、平台能力与"是否支持"的结论一律以仓库内实测证据为准
（docs/ACCEPTANCE.md 验收矩阵、reports/ 能力报告、fixtures-real 脱敏样本），
不以模型"认为支持"作为结论；能力未知按 unknown-deny 处理。
编排运行时的行为契约见 docs/ORCHESTRATION.md（含接缝勿动清单）与
docs/API_AND_EVENTS.md（已实现 API）。
