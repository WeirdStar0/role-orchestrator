# 开发计划

> 历史（historical）文档标注（2026-10-06，M10-05）：本文是 0.1-draft
> 规划期的 M0-M7 实施计划；M0-M7 已全部实现并通过验收，其后批次见
> docs/BACKLOG.md 的 M8-M10 与 reports/ 批报告。正文按历史原样保留。

基线：0.1-draft，2026-09-21。面向个人主导、AI 辅助开发。
以下是实施顺序与里程碑门禁，不是日历工期承诺。
任务清单见 [BACKLOG](docs/BACKLOG.md)，验收见 [ACCEPTANCE](docs/ACCEPTANCE.md)。

## 一、交付策略

先做可验证的最小纵向闭环，再增加并行度和自动化。
“完整目标”保留在路线图中，避免同时实现桌面壳、团队协作和分布式 Worker。
从 M0 开始贯彻权限拒绝、版本探测和测试；不能等 UI 做完再补安全。
从 M1 开始以 Fake CLI dogfood，从 M2 后在受控分支中接真实 CLI dogfood。

关键路径：

```text
M0 CLI/平台验证
 -> M1 单任务持久化闭环
 -> M2 DAG + worktree + 集成
 -> M3 可追溯上下文与记忆
 -> M4 审批、修复循环、恢复加固
 -> M5 可编辑 UI 与动态扩图
 -> M6 本地版发布门禁
 -> M7 开源扩展
```

## 二、阶段计划

| 阶段 | 核心交付 | 退出门禁 |
|---|---|---|
| M0 验证与骨架 | monorepo、契约、两 CLI spike、Windows 进程/权限/账号隔离验证 | 有版本化能力报告；所有不支持能力能拒绝而非绕过 |
| M1 持久化纵向闭环 | Profile/角色绑定、单节点执行、事件、SQLite/outbox、最小 UI | 任务可启动/停止/中断恢复，无凭据入库，无静默改模型 |
| M2 并行 DAG 与 Git | 图校验、资源租约、执行工作树、依赖基线、集成、候选审查 | 两开发分支并行、正确合流、冲突可暂停；用户目录不被修改 |
| M3 上下文与记忆 | 分层输入、Memory 提案/权限/冲突、检索、manifest | 角色能复用有来源的上下文，跨项目泄漏测试为 0 |
| M4 受控自动化 | 风险分类、一次性审批、返工展开、重试、故障核对、预算 | 返工上限生效，重复审批无效，不确定副作用不自动重跑 |
| M5 产品交互 | DAG 编辑/动态扩图、日志重放、diff、审批中心、配置管理 | 所有编辑都经图/权限校验；无 Node Profile 覆盖入口 |
| M6 本地稳定版 | Windows 重点回归、升级/备份、兼容矩阵、安全与发布治理 | 五类端到端场景全部通过，未验证平台/能力清晰标注 |
| M7 开源扩展 | GitHub/GitLab、本地插件接口、容器/Remote Worker、跨平台完善 | 每项单独 ADR、威胁建模和兼容测试，不阻塞前期里程碑 |

## 三、每阶段具体工作

### M0：先证伪不可行假设

建立 pnpm/Turbo 工程，选择实际可安装且受支持的 Node 与依赖版本，提交 lockfile。
落地 contracts、schema、Fake CLI 和三平台测试骨架。
分别验证 Claude/Codex：stdin、JSONL、退出码、错误结果、模型设置、session 恢复、
权限拒绝、取消子进程树、外部配置读取、账号刷新是否隔离。
Windows-native 是优先执行目标；WSL 单独记录，不能隐式替换。
任何关键能力不能证明时，更新 ADR 与 UI capability gate，不能开启无保护执行。

交付物：兼容矩阵、脱敏真实 fixtures、Fake CLI、失败边界报告、初始化工程。
门禁：两种 CLI 各完成只读 smoke；至少一种通过受控写入和取消测试；
另一种缺失能力必须明确 blocked，不能伪造支持。

### M1：最小可持久化任务

实现 Project、ProfileRevision、RoleBinding、Task/TaskRun、Execution 和 outbox。
先把静态单节点跑通；最小 Web 页面可查看启动、事件、最终结果、失败原因。
引入 task configuration snapshot 和 config drift 检测。
实现 daemon 单实例锁、超时、停止、重启时 INTERRUPTED/recovery 列表。
本地 API 的认证、Host/Origin 校验与脱敏从此阶段必需。

门禁：Fake CLI 和真实只读 CLI 跑通闭环；断点注入不导致重复进程启动。
M1 不是完整多 Agent 发布版。

### M2：图与代码正确性

实现静态 DAG 校验、三级并发、租约与公平调度。
每个写入 Execution 分配独立 worktree；原目录保持不变。
定义多父依赖的 inputSha 组合，集成操作单 writer，并有冲突保留。
Reviewer 消费固定 candidateSha，测试在一次性验证目录运行。

门禁：并行前后端 + 集成 + 审查示例端到端通过；依赖代码不是旧 main。
集成过程中崩溃可核对 commit set，不重复合并。

### M3：记忆可共享也可审计

实现有来源的 context bundle，按规则/任务/依赖/事实分层注入。
Memory 分类权限、proposed/verified 生命周期、CAS 冲突、撤销和过期。
文本检索先行；不引入向量库作为必须组件。
支持 UI 解释某条记忆为什么被选入上下文。

门禁：Claude 输出的设计可被 Codex 接收，且内容来源、版本和作用域可查。
冲突提案不得静默覆盖规则，恶意文本不能改变授权。

### M4：自动化必须可停止

实现风险分级、精确 Approval 和检查点恢复。
实现 reviewer fail 的有限展开，不改变图的无环性。
重试按错误分类，budget 按执行数/节点数/时长/可用 usage 共同约束。
处理 daemon 崩溃、PID 复用、残留子进程、未提交代码、半成品 artifacts、
SQLite 已提交但事件未发送、Git 已提交但 DB 未更新等窗口。

门禁：故障注入矩阵通过；3 次尝试/3 轮审查解释一致；超限进入等待用户。
货币费用不可知时显示 unknown，不按零费用继续无限执行。

### M5：编辑与交互

DAG 画布、节点编辑、暂停/取消/重试、版本冲突提示、动态扩图预览。
Profile 健康检查、四角色绑定、上下文清单、记忆提案审核、候选 diff、
审批中心、序号恢复日志、诊断导出和可访问性检查。
UI/REST/导入三个入口都不能绕过 R13；不是只隐藏一个前端字段。

门禁：运行中节点不能被原地篡改；过时 graphRevision 更新返回冲突。
断网重连恢复事件，UI 不丢最终结果或重复展示为两次执行。

### M6：本地稳定版

完成 Windows 原生重点回归、路径/权限测试、安装与升级文档、迁移备份。
macOS/Linux 达标后逐项标识支持，不以 CI 编译成功替代真实 CLI 验证。
验证保留/清理策略、许可证与归属、Codeowners、安全报告渠道、发布流程。
执行自己的小规模开发任务，只在隔离分支中 dogfood。

门禁：所有 release-blocking 项关闭；发布说明区分 implemented、experimental、
unsupported、unverified；人工批准发布，不由 Agent 单独发布。

### M7：后续开源能力

SCMProvider：GitHub/GitLab Issue、PR/MR、CI 状态，读取和远程写权限分离。
Tool/Plugin Registry：受控版本、manifest、签名或可信来源、scope。
可选容器执行与远程 worker：认证、租约、取消、网络边界、凭据最小暴露。
模型性能统计、提示模板和预算细化，不引入未经批准的自动切换模型。
桌面壳为独立体验增强，不重写核心。

## 四、个人开发与 AI 分工

Nick 为产品/架构最终维护者，Agent 是执行与辅助评审主体。
Coordinator 对齐任务范围；Architect 处理 ADR/契约；
Developer 实现小任务；Reviewer 核对 diff、测试与验收。
每个工作项有明确输入、允许文件、输出与退出条件；禁止“实现整个系统”型无限任务。
同一人维护时通过测试与书面风险记录补足流程，不声称满足双人审批。

## 五、首个开发批次

优先执行 M0-01 至 M0-06，不从完整 DAG 编辑器或团队商业版开始。
准备本机真实测试环境时由用户完成 CLI 登录；Agent 不接收密码、验证码或 auth 文件。
M0 结果允许更新“如何实现”的 ADR，不得直接改变角色单选、禁止覆盖等冻结需求。
