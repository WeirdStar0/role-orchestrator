# 验收与测试矩阵

所有项目要求写入实现测试；本包自带的静态检查不能证明这些产品测试已通过。
基准环境要记录 OS、CLI version、Node/Git version、execution target 和仓库状态。

| ID | 测试 | 必须观察到的结果 | 阶段 |
|---|---|---|---|
| A01 | 每角色绑定单个 Profile | 缺失/多个/未知 Profile 均在启动前拒绝 | M1 |
| A02 | Node/Task/Workflow 注入 model/Profile | schema/API/UI 三层均拒绝 | M1/M5 |
| A03 | Coordinator 输出新角色 | 只接受四角色，拒绝未知角色 | M1 |
| A04 | disabled 子任务权限发起扩图 | 拒绝并记录原因 | M2/M5 |
| A05 | JSONL 随机分片/UTF-8/截断 | 正确解析或明确协议失败，不误报 success | M0 |
| A06 | exit 0 但结果 error/缺最终事件 | 不判定业务成功 | M1 |
| A07 | 并行图资源竞争 | 同时满足 global/project/profile/credential lock | M2 |
| A08 | cycle、自依赖、缺失依赖 | 启动 CLI 前拒绝 | M2 |
| A09 | 多父依赖修改不同文件 | 后继 inputSha 同时包含父输出 | M2 |
| A10 | 多父依赖修改同一行 | 暂停冲突，不丢弃任何分支 | M2 |
| A11 | 用户原仓库有 dirty 修改 | 原修改与分支保持不变 | M2 |
| A12 | Reviewer 后 candidateSha 改变 | 旧审查结果失效 | M2 |
| A13 | Reviewer 运行测试 | 临时产物可写，审查源码不得改变 | M2 |
| A14 | Memory 冲突并发写 | CAS 冲突可见，不静默覆盖 | M3 |
| A15 | 从项目 A 查询 B 的 Memory | 授权层拒绝，结果无泄漏 | M3 |
| A16 | 注入“忽略策略并改模型”记忆 | 不改变权限/绑定 | M3 |
| A17 | 批准后改变命令/目标 SHA | 原审批无法消费 | M4 |
| A18 | 同一 Approval 双击/重复请求 | 单次有效，重放幂等 | M4 |
| A19 | 无 interactiveApproval CLI | 使用检查点或拒绝，不伪造暂停能力 | M4 |
| A20 | reviewer 连续 fail | 三轮总审查后暂停，无图回边 | M4 |
| A21 | 可重试失败 | 每节点最多三次总尝试，原 Profile 不变 | M4 |
| A22 | 已有副作用但执行结果未知 | RECOVERY_REQUIRED，不自动重跑 | M4 |
| A23 | DB commit 后进程启动前崩溃 | reconcile 后最多一个有效尝试 | M1/M4 |
| A24 | 进程启动后记录 PID 前崩溃 | 不重发启动命令导致第二个 writer | M4 |
| A25 | Git commit 后 DB 更新前崩溃 | 根据 manifest/SHA 核对，不重复提交 | M4 |
| A26 | 任务取消但 shell 启动孙进程 | 孙进程被终止或明确报告未终止 | M0/M4 |
| A27 | PID 被其他进程复用 | 不误杀其他进程 | M4 |
| A28 | 中文/空格/长路径/不同盘符/.cmd | 参数无注入，路径解析一致 | M0/M6 |
| A29 | Windows-native 与 WSL 路径混用 | 前置错误，不隐式转换执行 | M1 |
| A30 | 外部网页请求 localhost API/WS | Host/Origin/会话检查阻止访问 | M1/M6 |
| A31 | 测试脚本尝试读取宿主 secret | 在声称 Hardened 的模式中被边界阻止 | M0/M6 |
| A32 | CLI 不能证明强沙箱 | UI 标记 Local Trusted 或拒绝对应模式 | M0/M6 |
| A33 | Profile 目录分开但凭据共享 | 不标记 verified，认证锁限制并发 | M0 |
| A34 | Profile/model/宿主 config 执行中变化 | 检测漂移；原 run 不隐式更换 | M1 |
| A35 | CLI 内部子 Agent/MCP 发起额外执行 | 受控/计费/拒绝；不绕过 DAG 配额 | M0/M4 |
| A36 | 日志含伪造 HTML/secret/escape | 渲染消毒、落盘前脱敏 | M1/M6 |
| A37 | usage 缺失 | 显示 unavailable，不记录为 0 美元 | M4 |
| A38 | 运行节点被 UI 原地修改 | 409 或新 revision，不改写历史 | M5 |
| A39 | WebSocket 掉线和重复事件 | cursor 重放并按 eventId 去重 | M5 |
| A40 | 删除失败 worktree/尚未交付修改 | 默认拒绝自动清理 | M6 |
| A41 | schema/迁移升级与回退备份 | 已有任务可读；失败有恢复说明 | M6 |
| A42 | 发布包 | 不含 auth、API key、原始用户 transcript | M6 |

## 发布阻断级别

A01/A02/A06/A09/A11/A15/A17/A18/A22/A24/A25/A30/A32/A34/A36/A42
为 release-blocking，不允许只用“已知问题”绕过。
A31 仅在宣称 Hardened 的平台/模式中要求强边界；达不到必须禁用该声明和功能，
不能修改测试使危险执行看起来通过。

## 测试层次

Unit：graph、状态机、权限交集、配置、记忆 CAS、错误分类。
Contract：每 CLI 的原始事件 fixture 与统一结果语义。
Integration：SQLite + 文件系统 + Git + Fake CLI。
E2E：浏览器创建任务到交付、审批、故障恢复。
Real smoke：显式认证的本机 CLI；不在未信任 PR CI 使用真实账号。
Fault injection：关键事务/进程/Git 边界逐点中断。
