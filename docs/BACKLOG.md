# 首批开发任务


本清单可直接转为 Issue，但本次没有向 GitHub 创建任何 Issue、分支或 PR。


建议角色仅表示职责，不是节点模型/Profile 覆盖；所有任务状态为 planned。


P0 表示该阶段门禁任务，P1 表示功能完善或后续工作，不代表未做 P1 就可以宣称全功能。


机器可读版本：[backlog.json](../project/backlog.json)。

## M0

| ID | 任务 | 角色 | 依赖 | 验收 |
|---|---|---|---|---|
| M0-01 | 初始化 TypeScript monorepo 与公共契约 | architect | 无 | A01, A02 |
| M0-02 | 创建双方言 Fake CLI 与事件样本 | developer | M0-01 | A05, A06 |
| M0-03 | 验证 Claude 非交互接入 | developer | M0-02 | A05, A19, A33, A35 |
| M0-04 | 验证 Codex 非交互接入 | developer | M0-02 | A05, A19, A33, A35 |
| M0-05 | 验证 Windows launcher 与进程树终止 | developer | M0-02 | A26, A27, A28, A29 |
| M0-06 | 确定 capability gate 与平台兼容基线 | architect | M0-03, M0-04, M0-05 | A31, A32, A33 |

### M0-01 · 初始化 TypeScript monorepo 与公共契约
范围：建立 apps/packages 边界、依赖锁与 contracts；避免一次引入商业端或桌面壳。
完成标准：可执行基础 typecheck/test/build；契约与 Schema 的命名和语义一致。

### M0-02 · 创建双方言 Fake CLI 与事件样本
范围：模拟 Claude/Codex 流式协议、错误、截断、超时、子进程与中断。
完成标准：JSONL 分片与非零/假成功样本测试通过；所有样本标记 synthetic。

### M0-03 · 验证 Claude 非交互接入
范围：用用户自行认证的 Claude CLI 记录版本、stream、权限、resume、配置加载和模型设置。
完成标准：提供脱敏真实 fixture 与 verified/unsupported/unverified 报告，不写用户凭据。

### M0-04 · 验证 Codex 非交互接入
范围：记录 Codex exec 的事件、结果、权限、模型、恢复与错误协议。
完成标准：真实 smoke 与结构化事件 parser 合约测试通过，缺失能力明确拒绝。

### M0-05 · 验证 Windows launcher 与进程树终止
范围：处理原生 CLI、npm cmd 包装器、Unicode/空格路径与孙进程；WSL 单独验证。
完成标准：退出、取消、daemon 丢失和 PID 复用有可观测结果；不拼接用户输入。

### M0-06 · 确定 capability gate 与平台兼容基线
范围：汇总认证、权限、文件/网络边界、原生子 Agent 与外部配置控制能力。
完成标准：能力未知不标记支持；不支持的危险模式被阻止；更新 ADR 与兼容矩阵。

## M1

| ID | 任务 | 角色 | 依赖 | 验收 |
|---|---|---|---|---|
| M1-01 | 落地 SQLite schema、迁移与 outbox | developer | M0-01 | A23, A41 |
| M1-02 | 实现 Profile 与角色绑定快照 | developer | M1-01, M0-06 | A01, A02, A03, A29, A34 |
| M1-03 | 实现单执行生命周期与结果落盘 | developer | M1-02, M0-05 | A06, A23, A24 |
| M1-04 | 实现本地鉴权 API 与最小事件页面 | developer | M1-03 | A30, A36 |
| M1-05 | 实现启动 reconcile 与中断列表 | developer | M1-03 | A22, A23, A24, A27 |

### M1-01 · 落地 SQLite schema、迁移与 outbox
范围：实现 Project/TaskRun/Execution/Lease/Event 等最小表与唯一约束。
完成标准：认领与 outbox 原子提交，重放幂等，迁移可备份与验证。

### M1-02 · 实现 Profile 与角色绑定快照
范围：实现四角色单选、Profile revision、target 检查与宿主配置漂移检测。
完成标准：不存在节点覆盖入口；修改绑定不影响已有 run。

### M1-03 · 实现单执行生命周期与结果落盘
范围：以 PreparedInvocation 启动 CLI、保存事件、处理超时与 FINALIZING。
完成标准：exit 0 且结果有效/证据齐备后才成功；中断现场可保存。

### M1-04 · 实现本地鉴权 API 与最小事件页面
范围：添加 loopback 认证、Host/Origin/CSRF、任务详情与日志订阅。
完成标准：外部网页无法调用执行接口，日志脱敏和渲染消毒测试通过。

### M1-05 · 实现启动 reconcile 与中断列表
范围：扫描非终态 execution、识别进程身份和不确定启动结果。
完成标准：重启不重复创建 writer；不确定对象显示恢复需求。

## M2

| ID | 任务 | 角色 | 依赖 | 验收 |
|---|---|---|---|---|
| M2-01 | 实现 DAG 校验与节点状态机 | developer | M1-02 | A03, A08 |
| M2-02 | 实现三级并发、凭据锁与公平队列 | developer | M2-01, M1-01 | A07, A33 |
| M2-03 | 实现 Execution worktree 生命周期 | developer | M1-03 | A11, A28, A40 |
| M2-04 | 实现多父基线与单 writer 集成 | developer | M2-02, M2-03 | A09, A10, A25 |
| M2-05 | 实现固定 SHA 审查与验证目录 | developer | M2-04 | A12, A13 |
| M2-06 | 建立并行开发端到端基准 | reviewer | M2-05 | A09, A11, A12 |

### M2-01 · 实现 DAG 校验与节点状态机
范围：图合法性、角色解析、依赖完成条件与 blocked/ready 转换。
完成标准：循环/缺失依赖/未知角色在调用 CLI 前报错。

### M2-02 · 实现三级并发、凭据锁与公平队列
范围：配额事务与 fencing；配置 global/project/profile 和 credentialGroup。
完成标准：多项目压力测试不超配额，单 Profile 满额不阻塞其他 Profile。

### M2-03 · 实现 Execution worktree 生命周期
范围：从固定 SHA 建立独立分支/工作树，保留用户 dirty 状态。
完成标准：两 writer 不共用目录，异常不清理未交付改动。

### M2-04 · 实现多父基线与单 writer 集成
范围：拓扑组合 parent commit set、inputSha 与 candidateSha，冲突保留。
完成标准：后继包含所有父输出，集成中断不重复提交或丢分支。

### M2-05 · 实现固定 SHA 审查与验证目录
范围：创建 Reviewer 上下文与临时测试目录，保存 verdict/evidence。
完成标准：旧 SHA 的 pass 不适用于新候选；测试不能改被审源码。

### M2-06 · 建立并行开发端到端基准
范围：运行 plan/design/frontend/backend/review 示例，验证两种 CLI 协作。
完成标准：无原目录改动；图、产物、代码基线和日志均可追溯。

## M3

| ID | 任务 | 角色 | 依赖 | 验收 |
|---|---|---|---|---|
| M3-01 | 实现 context bundle 与 manifest | developer | M2-06 | A15, A16 |
| M3-02 | 实现 Memory 提案、类型权限与 CAS | developer | M3-01 | A14, A16 |
| M3-03 | 实现检索、过期与跨项目隔离 | developer | M3-02 | A15, A16 |
| M3-04 | 验证跨 CLI 上下文协作 | reviewer | M3-03 | A15, A36 |

### M3-01 · 实现 context bundle 与 manifest
范围：按项目/角色/任务/依赖装配上下文，保存来源、顺序与 hash。
完成标准：任意片段能追溯到 artifact/SHA/revision，预算截断不丢规则。

### M3-02 · 实现 Memory 提案、类型权限与 CAS
范围：实现 proposed/verified/disputed 生命周期与分类型写入。
完成标准：冲突不覆盖，project_rule 仅用户提升为 active。

### M3-03 · 实现检索、过期与跨项目隔离
范围：文本检索与依赖过滤，sourceSha 过期标记和 scope 检查。
完成标准：项目间数据不可见，旧证据不无提示复用。

### M3-04 · 验证跨 CLI 上下文协作
范围：测试 Claude 设计产物由 Codex 消费，不复制 session/credentials。
完成标准：共享的是结构化、版本化事实与产物，诊断导出不含秘密。

## M4

| ID | 任务 | 角色 | 依赖 | 验收 |
|---|---|---|---|---|
| M4-01 | 实现风险分级与一次性审批 | developer | M3-04 | A17, A18, A19 |
| M4-02 | 实现审批检查点与有限续行 | developer | M4-01, M0-06 | A19, A22 |
| M4-03 | 实现有界修复与复审扩图 | developer | M4-01, M2-05 | A20 |
| M4-04 | 实现重试分类与资源/费用预算 | developer | M4-02 | A21, A22, A37 |
| M4-05 | 实施恢复故障注入矩阵 | reviewer | M4-03, M4-04, M1-05 | A22, A23, A24, A25, A26, A27 |
| M4-06 | 验证 CLI 隐式配置与代理预算 | reviewer | M4-05 | A34, A35 |

### M4-01 · 实现风险分级与一次性审批
范围：actionDigest、基线、权限增量、过期与单次消费。
完成标准：重放/改变命令/改变 SHA 均无法复用审批。

### M4-02 · 实现审批检查点与有限续行
范围：能力不足的 CLI 使用结束/安全停止后的新 execution，不伪造中途暂停。
完成标准：未审批的副作用不发生；新尝试仍使用原 Profile revision。

### M4-03 · 实现有界修复与复审扩图
范围：Reviewer fail 生成修复/复审节点，最大三轮总审查。
完成标准：图保持无环，第四轮不启动，超限等待用户。

### M4-04 · 实现重试分类与资源/费用预算
范围：最多三次总尝试、原 Profile 冷却、节点/执行预算与 unknown usage。
完成标准：不可知费用不写 0；副作用不明不自动重试。

### M4-05 · 实施恢复故障注入矩阵
范围：在 DB/进程/Git/artifact 每个关键边界注入失败。
完成标准：无重复 writer/提交；未提交代码和审批证据保留。

### M4-06 · 验证 CLI 隐式配置与代理预算
范围：测试原生 subagents、hooks、MCP 和用户配置变化。
完成标准：不能通过 CLI 原生功能绕过图预算、角色绑定或权限。

## M5

| ID | 任务 | 角色 | 依赖 | 验收 |
|---|---|---|---|---|
| M5-01 | 实现 DAG 可视化与节点编辑 | developer | M4-06 | A02, A38 |
| M5-02 | 实现受控动态扩图与失效传播 | developer | M5-01 | A04, A08, A38 |
| M5-03 | 实现审批、diff 与上下文视图 | developer | M5-01, M4-01 | A12, A17 |
| M5-04 | 实现事件重放与安全诊断导出 | developer | M5-03 | A36, A39, A42 |
| M5-05 | 完成五类浏览器 E2E | reviewer | M5-02, M5-04 | A20, A22, A38, A39 |

### M5-01 · 实现 DAG 可视化与节点编辑
范围：画布、依赖编辑、角色选择、graphRevision 乐观锁。
完成标准：编辑表单/API/导入均不能覆盖 Profile/model；运行节点不可原地修改。

### M5-02 · 实现受控动态扩图与失效传播
范围：显示 Proposal、校验创建权限、预算与对后继的影响。
完成标准：禁权请求被拒绝；过时图 revision 更新报冲突。

### M5-03 · 实现审批、diff 与上下文视图
范围：审批影响范围、候选 SHA、测试证据、记忆来源可见。
完成标准：审批不诱导全局放权，候选修改后 UI 不显示旧通过。

### M5-04 · 实现事件重放与安全诊断导出
范围：游标重连、事件去重、长日志背压、脱敏导出。
完成标准：断线不丢终态；导出无凭据/可执行 HTML。

### M5-05 · 完成五类浏览器 E2E
范围：顺序、并行、返工、审批、恢复五条用户流程。
完成标准：对应测试带真实截图/日志证据，未验证环境不标通过。

## M6

| ID | 任务 | 角色 | 依赖 | 验收 |
|---|---|---|---|---|
| M6-01 | 完成 Windows 与扩展平台矩阵 | reviewer | M5-05 | A28, A29, A31, A32, A33 |
| M6-02 | 实现备份、迁移与安全清理 | developer | M5-05 | A40, A41 |
| M6-03 | 执行发布安全与许可核对 | reviewer | M6-01, M6-02 | A30, A32, A36, A42 |
| M6-04 | 受控 dogfood 与使用文档 | developer | M6-03 | A11, A17, A22 |
| M6-05 | 维护者审核本地版候选 | coordinator | M6-04 | A42 |

### M6-01 · 完成 Windows 与扩展平台矩阵
范围：原生 Windows 重点验证，macOS/Linux/WSL 分别记录能力。
完成标准：路径、取消、权限、认证与 CLI 版本矩阵有证据。

### M6-02 · 实现备份、迁移与安全清理
范围：备份恢复、升级失败路径、worktree/产物保留。
完成标准：不删除未交付改动，失败迁移有可执行恢复步骤。

### M6-03 · 执行发布安全与许可核对
范围：核对 secrets、依赖来源、LICENSE 候选确认、Codeowners 与私密渠道。
完成标准：无 release-blocking 项，身份/许可字段由维护者确认。

### M6-04 · 受控 dogfood 与使用文档
范围：在自己的隔离分支上执行一个小功能，记录失败与恢复。
完成标准：流程可回滚，Agent 没有修改治理策略或自批合并。

### M6-05 · 维护者审核本地版候选
范围：汇总证据、支持范围、已知限制与回退方案；提交人类审核。
完成标准：维护者人工批准才交付/发布；不把提案当发布权限。

## M7

| ID | 任务 | 角色 | 依赖 | 验收 |
|---|---|---|---|---|
| M7-01 | 设计 GitHub/GitLab 受控集成 | architect | M6-05 | A17, A42 |
| M7-02 | 设计受控插件与工具扩展 | architect | M6-05 | A16, A35 |
| M7-03 | 验证可选容器/Remote Worker | architect | M6-05 | A22, A26, A31 |
| M7-04 | 冻结独立团队商业版接口边界 | architect | M6-05 | A01, A02 |

### M7-01 · 设计 GitHub/GitLab 受控集成
范围：SCMProvider 读取与远程写权限分离，独立 ADR 与测试。
完成标准：PR/MR/CI 接口不泄露凭据，远程写必须明确授权。

### M7-02 · 设计受控插件与工具扩展
范围：版本化 manifest、权限 scope、可信来源与禁用策略。
完成标准：插件无法绕过角色、图预算或审批控制面。

### M7-03 · 验证可选容器/Remote Worker
范围：传输认证、租约、取消、网络/文件系统边界和 secret 最小暴露。
完成标准：不把独立 worker 当多租户安全；按 target 提供故障证据。

### M7-04 · 冻结独立团队商业版接口边界
范围：团队控制平面单独产品化，不改变开源本地功能与单选绑定。
完成标准：商业依赖不进入开源核心启动/构建路径；条款经发布前核查。

## M8

立项依据：维护者 2026-09-26「123全做」指示（真实 CLI 联调 / 模型性能统计 / 桌面壳三项全部立项）；
治理披露见 PROPOSALS.md 2026-09-28 节。开发协议与 M0-M7 一致（Flash 开发 + 10 轮连续审查）。

| ID | 任务 | 角色 | 依赖 | 验收 |
|---|---|---|---|---|
| M8-01 | 真实 CLI 受控联调窗口 | developer | M6-05 | A28, A29 |
| M8-02 | 模型性能统计与预算细化 | developer | M8-01 | 不引入未经批准的自动切换模型 |
| M8-03 | 桌面壳体验增强 | developer | M6-05 | 独立 ADR；不重写核心 |
| M8-04 | 模型统计收尾（预算建议填充 + engine usage tee） | developer | M8-02 | 建议只读不改变调度决策；tee fail-open |
| M8-05 | 壳 serve 侧车捆绑（干净 Windows 开箱即用） | developer | M8-03 | 无捆绑资源时开箱运行；安全边界零变化 |
| M8-06 | 壳与统计包维护清理（脚本加固/测试补充/文档措辞） | developer | M8-05 | 全量门禁绿；历批 minor 闭合或归属 |

### M8-01 · 真实 CLI 受控联调窗口
范围：维护者完成 claude/codex 登录与配额授权后，在授权窗口内执行受控 smoke——
stdin/JSONL/权限拒绝/取消/会话恢复/子进程终止/账号隔离采集，脱敏 fixtures
入 packages/cli-events/fixtures-real，更新 M6-01 矩阵相应格。
完成标准：M6-01 §3.2 第 5-9 项 unverified 格逐项闭合或如实降级；
配额消耗记录在案；不新增自动跳过权限的参数。

### M8-02 · 模型性能统计与预算细化
范围：基于 M8-01 采集的真实 usage 数据实现模型性能统计
（token/时长/费用，费用不可知保持 unknown 语义）；预算阈值细化。
完成标准：统计只读、不改变调度决策；费用不可知显示 unknown；
不引入未经批准的自动切换模型。

### M8-03 · 桌面壳体验增强
范围：桌面壳包装现有本地页面（技术选型 Electron/Tauri 另行 ADR 与威胁建模）。
完成标准：不重写核心；复用 local-api 回环 + 令牌 + CSRF 全部安全边界；
壳进程不获得超出页面的任何权限。

### M8-04 · 模型统计收尾（2026-09-30 登记，M8-02 遗留两项收口）
范围：其一，BudgetRefinement 从 M8-01 补窗口采集的真实 usage 分布产出
只读阈值建议（status 由 stub 转 ready；建议值附推导口径与样本量标注；
不触碰 @role-orchestrator/budget 与 scheduler 的任何执行面——建议的
采纳与否属维护者策略决定，另批处理）；其二，engine 持久化路径
（persistDrainedEvents/appendRedactedEvent 脱敏后数据）tee usage 事件到
model-stats PerformanceStore（fail-open：统计旁路任何失败不影响执行主
流程；只追加；store 文件路径显式传入；方言解析复用现有 claude/codex
提取器）。
完成标准：建议只读且不改变调度决策（既有决策词表检查回归）；费用
不可知保持 unknown 语义；tee 以 fixtures-real 做 hermetic 契约测试；
engine 既有执行语义零改动（全量回归绿）。

### M8-05 · 壳 serve 侧车捆绑（2026-09-30 登记，兑现 M8-03「干净 Windows」验收的现存缺口）
范围：esbuild 把 packages/local-api 的 serve 入口 bundle 为单文件 JS
（node: 内置保持 external）；构建脚本从 nodejs.org 官方下载便携手
zip（版本对齐 mise 工具链、SHA256 校验、URL 与体积写入披露）；NSIS
extraFiles 把 bundle 与 node.exe 捆入安装包；壳侧资源定位链改为安装
目录捆绑资源优先，RO_SHELL_SERVE_BIN / RO_SHELL_NODE 环境变量保留
覆盖能力；README 打包节与「已知边界」随之收口。
完成标准：不设任何环境变量、仓库 dist 不可用的前提下，安装版壳完成
serve 拉起 + 健康检查 + 窗口加载回环页面（本机模拟干净机器验证）；
NSIS 产物含捆绑资源且体积变化入披露；守卫/令牌/serve 语义零变化。

### M8-06 · 壳与统计包维护清理（2026-09-30 登记，M8-04/05 审查移交项集中收口）
范围：其一脚本/构建加固——fetch-node-runtime 先比对 exeHash 再写盘、
失实注释修正；bundle-serve 钉 esbuild absWorkingDir；turbo 缓存不携带/
不还原 serve-bundle.mjs（outputs 排除或任务化，dev 按调研定）；.gitignore
补 .git-commit-msg* 模式；新克隆 cargo 构建前置与 dev cargo run 遮蔽在
README 构建节如实登记。其二测试补充——决策词表 outcome 级断言恢复、
A36 tee 对照（含可脱敏字符串）或注释收窄、双 suggestion/双 gap 排序
用例、取整整倍数用例与措辞、attribution 入口早校验。其三文档措辞——
README 数字/排版/定位链措辞、integration.rs 与 source_invariants.rs
注释、两份 BATCH 报告行号/陈旧行、PROPOSALS 两处精度（冻结面，披露性
同步）、MIN_SAMPLES 推导算术三处、ADR 行号引用改按节名。
完成标准：全量门禁绿（typecheck/test/build/cargo test/planning-check）；
历批审查 minor 逐条闭合或显式归属；行为语义零变化（除脚本加固的
fail-closed 增强）。

### M8-03 实现子任务拆分（2026-09-28 细化，等价于 ADR 批准后的实现路线图）

| 子任务 | 内容 | 前置 |
|---|---|---|
| M8-03a | Tauri v2 脚手架 + local-api 连接（自动启动/健康检查/WebView 加载回环页面） | Rust 工具链 + ADR 批准 ✓ |
| M8-03b | 安全加固（令牌流验证/CSP 导航锁定/capability 收敛/进程树审计——对照 ADR 四项待实测） | M8-03a |
| M8-03c | 系统托盘 + 窗口管理 + 打包分发 | M8-03b |
