# 开发启动入口

当前最先执行的工作是 M0，而不是完整界面或商业版。
先在新的开发仓库中放入本包，确认仓库身份、许可证候选和本机认证边界。
没有获准时不操作用户原有项目目录、不创建远程分支或发布。

## 可交给开发 Agent 的首个任务

```text
读取 AGENTS.md、docs/REQUIREMENTS_BASELINE.md、DEVELOPMENT_PLAN.md、
docs/CLI_ADAPTERS.md 和 docs/BACKLOG.md。

仅执行 M0-01 与 M0-02：
1. 建立 TypeScript monorepo 的最小骨架与版本锁。
2. 移植本包的配置约束与 TypeScript 契约，保持四角色单选 Profile，
   不增加 Workflow/Task/Node Profile/model 覆盖。
3. 实现可脚本化 Fake CLI，覆盖正常 stream、截断 JSONL、错误结果、
   超时和孙进程。明确标记 synthetic，不冒充真实 CLI 事件。
4. 提供实际运行的 typecheck/test/build 结果与证据。
5. 真实 Claude/Codex 登录、第三方模型联调和系统权限变更不在本任务范围。
6. 不自动合入 main，不修改治理/安全策略以使测试通过。
7. 输出变更摘要、测试、未验证项、风险和下一任务依赖。
```

## M0 结束后才决定的实现细节

CLI 版本兼容范围、Windows launcher 的具体实现、哪种能力需要受控桥接、
是否可保证原生子进程终止和凭据隔离。
这些通过探测和测试决定，不以模型“认为支持”作为结论。
