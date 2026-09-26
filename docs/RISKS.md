# 风险、验证缺口与发布阻断

当前没有真实 CLI 联调证据。本包的静态 schema/文档测试不是执行兼容性保证。

| 风险 | 影响 | 处理与验证 | Owner |
|---|---|---|---|
| 两 CLI 事件/权限能力变化 | 错误调度、无法拦截动作 | M0 fixtures + capability gate + 升级 smoke | Maintainer |
| 配置目录与凭据隔离不等价 | 账号串用、刷新竞争 | 双账号隔离实测；credentialGroup 锁 | Maintainer |
| 任意模型协议不兼容 | 模型可配置但工具不能用 | 每 Profile 逐项 smoke；不支持就拒绝 | Maintainer |
| Worktree 共享 Git 元数据 | 跨执行破坏 refs/config | Git Service 单 writer、保护公共目录 | Architect |
| 测试/构建脚本执行任意代码 | 泄露 secret、越界写入 | Trusted/Hardened 明示；OS boundary 测试 | Reviewer |
| daemon 崩溃后残留进程 | 二次执行、并发写冲突 | PID identity + manifest + reconcile | Developer |
| DAG 动态修改破坏历史 | 旧结果错误复用 | revision/CAS、后继失效 | Architect |
| 记忆污染或跨项目泄露 | 错误事实、数据暴露 | 类型授权、来源、scope、注入测试 | Reviewer |
| CLI 自带 subagent/插件 | 绕过预算与权限 | 清单/hash、禁用或纳管 | Architect |
| 订阅 usage 不完整 | 预算失真 | unavailable 标签，资源上限硬控制 | Maintainer |
| Windows 路径与进程树 | 注入、孤儿进程、取消失败 | 专门 launcher，路径矩阵和子进程测试 | Developer |
| 本地 API 被网页调用 | 本机任意操作 | loopback + auth + Host/Origin/CSRF | Reviewer |
| 开源/商业边界不清 | 授权争议、社区误解 | 许可候选确认、归属追踪、独立扩展 | Maintainer |
| 任务范围膨胀 | 无法形成可用闭环 | milestone gate，不提前做 SaaS | Maintainer |

## 发布前需由维护者填写的具体信息

工作名/仓库地址、维护者 GitHub handle、许可证与版权主体、安全报告渠道。
这些是仓库身份与法律配置，不会阻塞本规划包生成，也不以猜测填入。
依赖版本、真实 CLI/OS 兼容矩阵由 M0 的证据决定，不能在文档里杜撰。

## 首版安全声明

仅承诺已经实测的功能。若只提供 Local Trusted，就明确提示它适用于可信项目，
不宣称是抵御恶意仓库的沙箱。角色 Prompt 与 YAML 权限字段不是独立安全边界。
