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
| POLISH-4 | 全仓维护态 minor 终审（M8-06 移交族 + 历批扫描） | developer | M8-06 | 全量门禁绿；移交族闭合；终审清单披露 |

## M9

立项依据：维护者 2026-09-30 批准 M9 提案「任务工作台」——把引擎变成打开即用的产品
（创建任务/选角色/启动执行/实时进度），CLI 引擎 claude 与 codex 两者都接。
开发协议与既有批次一致（Flash 开发 + 10 轮连续审查）。

| ID | 任务 | 角色 | 依赖 | 验收 |
|---|---|---|---|---|
| M9-01 | 点火：POST /api/v1/runs 创建执行并驱动引擎编排（dispatch 骨架转真实） | developer | M8-06 | hermetic 端到端：建任务→调度→fake-cli 执行→事件/结果可查；安全边界零变化 |
| M9-02 | 工作台 UI v1：新建任务表单/任务列表/实时进度，观测台保留为高级页 | developer | M9-01 | 壳打开即是工作台；建任务到看结果全程 UI 操作；10 轮审查 |
| M9-03 | 角色与模型配置页：Profile 查看/选择（claude/codex 映射与预算） | developer | M9-02 | 配置页生效且经守卫；错误配置显式拒绝 |
| M9-04 | 打磨与 v0.2.0 发布：端到端体验/错误呈现/新安装包 | developer | M9-03 | 端到端演练 + v0.2.0 发布（维护者批准） |


## M10

立项依据：维护者 2026-10-02 批准外部深度评估路线「编排产品化」——暂停外围
扩展，把 dogfood/browser-e2e 已跑通的完整多角色链路收敛为正式产品运行时
（统一 RunDriver composition root,消除 test/product path divergence)。
开发协议与既有批次一致(Flash 开发 + 10 轮连续审查)。

| ID | 任务 | 角色 | 依赖 | 验收 |
|---|---|---|---|---|
| M10-01 | 修复创建任务的 RoleBinding 副作用:任务创建只读绑定并冻结,profile 配置与任务创建彻底分离 | developer | M9-04 | 预置差异化绑定→建任务→绑定零变化且 run 用项目 developer profile;无绑定时显式引导;10 轮审查 |
| M10-02 | 抽取正式 RunDriver(packages/orchestration):run/node 驱动、依赖基线解析、集成/审查/扩图/恢复——dogfood/browser-e2e/local-api 共用 | developer | M10-01 | 三方 composition root 统一;多节点依赖基线正确(B 基于 A 的 accepted SHA);10 轮审查 |
| M10-03 | 生产入口支持任意合法 DAG 多节点编排(声明层 v1 限制:每任务至多一个集成节点):角色 prompt+依赖产物上下文注入执行 | developer | M10-02 | Coordinator→Architect→多 Dev→Integration→Reviewer→返工链经工作台端到端;10 轮审查;v1 限制:每任务一个集成节点——链式/并行集成将在后续版本支持(M7 集成服务为 per-run 单写,声明层 WORKFLOW_INTEGRATION_NODE_COUNT 拒绝 ≥2 个 integration 节点;2026-10-05 第 1 轮审查返修登记) |
| M10-04 | Memory/Context 接入真实执行链 + TaskRun 状态模型修正(FAILED/outcome)+ 按 scheduler 打开并发 | developer | M10-03 | 执行 prompt 含 memory/context/角色职责;FAILED 呈现正确;并发由 scheduler 决定;10 轮审查 |
| M10-05 | 文档大收口:README/AGENTS/START_HERE/MANIFEST 重写,历史规划文档标注 historical,API_AND_EVENTS 对齐实际 | developer | M10-04 | 文档与代码零矛盾;10 轮审查;**2026-10-06 交付**(交付摘要见下方 M10-05 节) |
| M10-06 | v0.3.0 发布:托盘加固/端到端演练/新安装包/Release | developer | M10-05 | 端到端演练 + v0.3.0 发布(维护者批准);**2026-10-06 交付**(交付摘要见下方 M10-06 节;tag/Release 页归维护者批准链) |

### M10-05 · 文档大收口(2026-10-06 交付摘要)

- **任务 1 文档大收口(commit f924d90,11 文件)**:README 重写为开箱即用
  任务产品口径(安装→启动→令牌→profiles→建任务→观测/托盘;能力边界按
  RELEASE_PROCESS 四分 implemented/experimental/unverified/unsupported);
  AGENTS.md 事实性更新(『安全要求』节逐字保留);START_HERE/MANIFEST 对齐
  产品现实;docs/API_AND_EVENTS.md 对齐已实现端点与 outcome 双字段/
  parallel dispatchJoin/迁移链 001..018;docs/ORCHESTRATION.md 增补新现实
  与接缝勿动清单;docs/MEMORY_AND_CONTEXT.md 补读侧注入指针;历史规划文档
  (REQUIREMENTS_BASELINE/DEVELOPMENT_PLAN/project/LICENSING)文件头
  historical 标注;CHECKSUMS 十行重算。
- **任务 2 审查承接修复(commit 2b9a733,11 文件)**:redact/计账两行换位
  (预算度量即出货文本)+判别测试;两个显式冻结形状决策(①记忆区块头
  『已脱敏』→『经形状脱敏管线脱敏』;②零注入尾注去陈旧接缝半句,双锚测试
  同步);陈旧生产注释收口六处(迁移链版本表述版本无关化/serial→parallel
  措辞/聚合注释补例);测试注释精度三处。
- **任务 3 治理披露**:PROPOSALS 同日节(含勘误三条与测试缺口提案登记七项)、
  本标记、project/backlog.json 顶层 deliveryNotes 同步、
  reports/M10-05-BATCH.md。
- 验收对照:『文档与代码零矛盾』以本批同步后的文档面为准(逐文档对齐代码
  实况,勘误如实登记);『10 轮审查』属批次后续流程,未在本交付内完成。

### M10-06 · v0.3.0 发布批(2026-10-06 交付摘要)

- **任务 1 M10-05 十轮审查承接(commit 512c61d,7 文件)**:六条 minor
  逐条收口——ORCHESTRATION §11.7 改写为决策②落地后新形状直接陈述;
  LICENSING.md 头注指针勘误(改指 PROPOSALS/MAINTAINERS 真实出处,不在
  GOVERNANCE.md 补录——属维护者发布前治理复核);AGENTS.md 范围与事实
  持久化(『安全要求』逐字保留);backlog.json deliveryNotes 增 M10-06
  条目注明 commits 链结构性缺口;M10-05 批报告 §6 计数勘误(26 实为 27)
  登记入 M10-06 批报告;diff-view.test.ts 钩子预算注释精确化
  (60s/90s 仅 beforeAll)。
- **任务 2 托盘加固收口(commit 0ded64e,2 文件)**:desktop-shell README
  冒烟清单 v0.3.0 化——可自动化证据本机收口(进程链/HTTP 200+403/窗口
  存在性/WM_CLOSE 关闭拦截/KILL_ON_JOB_CLOSE 强杀兜底),真窗交互逐项
  降级(托盘图标/菜单点击/双击恢复/真实 X/导航提示观感);孤儿核验
  命令双模式扩三模式(增 serve-bundle[.]mjs)。
- **任务 3 v0.3.0 版本抬升与演练(commit fa19a60,9 文件)**:版本 0.3.0
  四处+lockfile 零变化断言;CHANGELOG 0.3.0 节;发布说明草稿四分类
  (reports/V0.3.0-RELEASE-NOTES.md);五步链新 NSIS(26,056,761 字节,
  SHA256 ac92cf8c…c5ee);阶段 5 全量门禁 72/72;安装面演练 A(卸 0.2.0
  →装 0.3.0→六断言+带凭据 API 200+数据保留+旧库幂等迁移)+演练 B
  (多节点 workflow 声明——实录含意外建 run:首次 POST 202 建快照冻结
  run-muvv1fw5,422 引导流程属早迭代跨迭代合并/双凭据组轮内并行——
  executions 实测两节点同刻派发、区间重叠/outcome 双字段/决策②零注入
  尾注 4/4(两个多节点 run,原 2/2 为子集口径)/单节点裸 objective
  平价/双 integration 400 拒绝/漂移门无留存凭据行,降级为 db 时间戳
  旁证;原『43ms 错峰窗重叠/2/2/漂移门跨版本活体』经第 4 轮审查返修
  勘误,reports/M10-06-BATCH.md §4.4/§9);真实 claude/codex 冒烟未执行(红线,
  维护者清单)。
- **任务 5 治理披露(本 commit)**:PROPOSALS 同日节、BACKLOG 完成标记、
  backlog.json deliveryNotes 终态、批报告 Release 执行清单、CHECKSUMS
  终同步。
- **第 4 轮审查返修(返修 commit,candidateSha 以 git log 为准,5 文件)**:
  第 4 轮审查以两条阻断拦截演练记录披露失实——B05 链被呈现为单次设计链
  (实录:首次 POST 202 意外建 run-muvv1fw5 冻结遗留 drill3 绑定,422
  引导流程属更早迭代)与逐项失实(B08 overlap 判别式无判别力/B08b 实为
  4/4/strict schema 属自动面/串行对照非设计负例/漂移门 409 无留存凭据行
  且首个通过新 id 为 drill3-*/演练脚本零断言 exit 0 不作门禁)。返修将
  reports/M10-06-BATCH.md §4.4 逐条改为留存物证实录(日志行原文+用户库
  只读时间戳),PROPOSALS §五/V0.3.0-RELEASE-NOTES/本摘要同句勘误;
  零代码行为变更;拦截原文与逐项处置见 reports/M10-06-BATCH.md §9。
- 验收对照:『端到端演练』已完成(自动面全量门禁+安装面 A/B 实录,
  证据见 reports/M10-06-BATCH.md §3-§4);『v0.3.0 发布』的 tag/Release
  页/归档/远端推送按 RELEASE_PROCESS 归维护者批准链执行,本批产出候选
  (candidateSha 以 git log 为准)并交付 Release 就绪清单。

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
（node: 内置保持 external）；构建脚本从 nodejs.org 官方下载便携
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

### POLISH-4 · 全仓维护态 minor 终审（2026-09-30 登记，M8-06 移交族收口）
范围：M8-06 十轮审查移交族（『唯一运行时行为变化』枚举改枚举式、
budget.ts 行号漂移统一为函数名/锚点引用消除行号循环、N7 测试形状
双 ready+双 gap 变体、ceil-vs-round 方向钉值 P95=4200、BATCH 笔误
与交叉引用与计数、测试注释/标题旧取整措辞残留、PROPOSALS『档』式
残留）+ 历批 POLISH 系列遗留扫描；策略:报告引用弃用裸行号改锚点
（函数名/唯一文本），消除『改文档→行号漂移』循环。
完成标准：全量门禁绿；移交族逐条闭合；终审清单（剩余维护态 minor
全量盘点+归属）入披露；行为语义零变化（测试补充除外）。

### M8-03 实现子任务拆分（2026-09-28 细化，等价于 ADR 批准后的实现路线图）

| 子任务 | 内容 | 前置 |
|---|---|---|
| M8-03a | Tauri v2 脚手架 + local-api 连接（自动启动/健康检查/WebView 加载回环页面） | Rust 工具链 + ADR 批准 ✓ |
| M8-03b | 安全加固（令牌流验证/CSP 导航锁定/capability 收敛/进程树审计——对照 ADR 四项待实测） | M8-03a |
| M8-03c | 系统托盘 + 窗口管理 + 打包分发 | M8-03b |

## v0.3.1 · Real Usage & Stabilization（2026-10-06 维护者立项）

方向裁决（维护者 2026-10-06 复核评估）：v0.3.0=第一个真正成立的本地多
Agent 编排产品版本（完成度改判 ≈85–90%，进入真实使用验证期）。下一版本
停止架构建设、不直接上 M11 大功能；v0.4.0 功能不预先锁定，由 v0.3.1 真实
使用失败数据决定（候选方向仅登记：run 级取消 / 多 integration 节点 /
workflow 创建 UX / 任务模板 / DAG 可视化编辑 / Memory 管理 UI / 成本耗时
分析 / 失败恢复 UX）。

### V031-01 · 测试稳定批（P0，仓库内面）——**2026-10-06 交付**（交付摘要见下方 V031-01 节）
范围：①并行故障专项——parallel join 下 thrown-fault/catch-per-run 专格
（兄弟 run 隔离、serve 存活、无孤儿杀）、节点超时/取消时兄弟节点行为
如实钉死、per-dispatch 隔离日志（同轮并发第二故障不再被 Promise.all
静默吞没——M10-04 审查 R4 建议落地）；②WAITING_APPROVAL>FAILED 聚合
优先级格与「其余→null」/blocked→null 复位直接断言；③409 七字段漂移门
正向用例（同 id 异七字段→HTTP 409 PROFILE_DEFINITION_CONFLICT——M10-06
审查指出现无正向断言）；④M10-05 登记其余测试缺口逐项闭合：context-refs
上限格（>5 bundle 截断）、context 侧 fail-open 复合格、未知项目降级格、
预算 halt-on-first-overflow 钉死、flatten 多行正例；⑤apps/desktop-shell/
README 三处将来时表述回指 M10-06 §4.3 已执行证据链（文档精度随批消化）。
完成标准：全量门禁绿；新格逐格判别力说明（非恒真）；10 轮审查。

### V031-01 · 测试稳定批(2026-10-06 交付摘要)

- **任务 1 并行故障专项(commit fb69e5b,4 文件)**:唯一生产改动=
  per-dispatch 隔离日志——pump-primitives 并行 join 增可选
  onDispatchFault 逐派发记录钩子(记录后原样 rethrow,join/隔离语义
  逐字节不变,benchmark 泵零触碰),run-driver 接既有 LogSink(redactText
  先行,与 drive failed 注记同面;stdout 事件协议/A36 边界/REST-WS 契约
  零改动);同轮并发第二故障不再被 Promise.all 静默吞没。parallel+
  catch-per-run 专格 2 格(58→60,变异实证非恒真:回退 bare join 两格红
  /旧 58 绿)+超时传播现状锚格;shutdown 取消快照 straddle 窗口注释登记
  (零行为);格⑥⑦零回归核实。
- **任务 2 聚合与登记缺口逐项(commit b3ac603,4 文件,零生产改动)**:
  聚合优先级格(FAILED+WAITING_APPROVAL 并存→RUNNING+blocked,detail+
  列表双面);「其余→null」直接断言(hold 双兄弟在飞);审批续行窗口
  现状锚——**发现如实登记**:登记预期的 mid-flight blocked→null 在 v1
  语义不可经 run outcome 观测(续行 round-begin 内同步跑完),naive 格
  实测超时暴露,新增 PROPOSAL_SLOW profile 后改钉现状(在飞 outcome
  保持 blocked);409 七字段漂移门正向用例(实际触发面=PUT role-bindings,
  409+PROFILE_DEFINITION_CONFLICT+stored 行保持=拒绝非 upsert);
  M10-05 登记缺口五格(context-refs 最近 5 条上限/fail-open 复合/
  未知项目降级/halt-on-first-overflow/flatten 多行,15→20)——refs 侧
  无注记与原登记「与注记」不符,按现状双侧钉死如实登记;
  desktop-shell README 三处将来时回指 §4.3 已执行证据链。
- **门禁**:orchestration vitest 65/65、local-api vitest 268/268
  (先重建 dist;267/267 为第 4 轮返修前数字,第 5 轮返修新增门范围锚格后
  终态 268/268——V031-02 审查移交精度族对齐)、typecheck 61/61、build
  exit 0;逐格判别力与三轮审查
  移交清单闭合对照见 reports/V031-01-BATCH.md;未验证项=真实 CLI 并行
  故障端到端(维护者真实使用主线)。10 轮审查属批次后续流程。

### V031-02 · 真实使用采集批（P1，为维护者环境动作备料）——**2026-10-06 交付**（交付摘要见下方 V031-02 节）
范围：①只读 usage-stats 导出脚本——从本地库导出 run 级摘要（JSON/MD）：
任务成败 / 用到的角色 / DAG 实际展开 / executions 数 / 失败与重试次数 /
审批次数 / Reviewer fail 次数 / 上下文命中 / Memory 命中 / 总耗时 /
CLI usage / 人工介入点 / 最终 diff 指针（13 项指标，维护者评估定义）；
②真实任务演练模板（reports/ 模板：5 类任务〔小 bug / 小功能 / 跨前后端 /
架构重构 / Reviewer 首轮 fail 返工〕×13 指标记录表）；③文档（README 或
START_HERE 增「真实使用验证」节）。零行为变更（只读脚本+模板+文档）。
完成标准：planning-check 绿；脚本对现库实跑出真实摘要；10 轮审查。

### V031-02 · 真实使用采集批(2026-10-06 交付摘要)

- **任务 1 备料(commit c69af36,4 文件)**:scripts/usage-stats.mjs 只读
  导出工具(node:sqlite READONLY,零外部依赖零产品包 import,13 项指标
  聚合口径按受控迁移链真实字段勘察落查询;对真实库 cmd 原样实跑 exit 0
  出 8 个真实 run 摘要)+reports/REAL-USE-DRILL-TEMPLATE.md(5 类任务×
  13 指标登记+人工观察栏六维度)+README『真实使用验证』节(冻结面,
  CHECKSUMS 该行重算)。**逐指标如实**:11 项可导出(⑧上下文命中现状
  预期 0 非故障、⑩总耗时为区间近似口径);2 项 unknown——⑨Memory 命中、
  ⑪CLI usage 当前无 run 级持久记录(014 不在产品受控链,真实库实测无该表;
  JSONL tee 契约无 runId 字段且 serve 未接线),unknown-deny 不伪造。
- **任务 2 审查精度族(commit 23a485b,6 文件)**:族A context-refs 格
  新增全量 prompt 相等断言(refs 侧『cannot land silently』半真补实);
  族C/F/G 红路径臂措辞改如实(组合层取消不使本格红/终态 wait=兜底
  省略性变异不可观测/409 双臂显式化),断言本体零改动;族I BACKLOG
  门禁 267→268/268 对齐终态。移交勘误四项(commits 结构性缺口/M10-06 §9
  引用改标/§2.1 指针盘点/『双侧钉』表述)登记于 PROPOSALS V031-02 节,
  历史文档不改写。
- **门禁**:orchestration vitest 65/65、先重建 dist 后 local-api vitest
  268/268、planning-check 79/79+self-test exit 0;逐命令退出码见
  reports/V031-02-BATCH.md(不入冻结面)。**未验证项**:5 类真实任务
  演练从未执行=维护者环境动作①主线;10 轮审查属批次后续流程。

### 维护者环境动作（v0.3.1 主线，非仓库批）
①产品内 Claude+Codex 真实 E2E——用 V031-02 模板跑 5 类真实任务并留档
（v0.3.1 最重要未验证项）；②干净 Windows 机安装验证（发布包最后环境门）；
③真窗托盘/打开令牌文件人工冒烟；④Memory 检索效果评估（机制正确→实际
有用）；⑤88 项 M10-06 文档 minor 按族随批消化（P2，不升主线）。

## M11 · v0.4.0「Desktop Product Experience」(2026-10-07 维护者立项)

方向裁决(维护者):真实使用首日反馈+Cindy(makecindy/cindy,Apache-2.0)对标——「M10 把编排内核产品化了,桌面前端仍是开发/诊断面板」。v0.4.0=产品 UI 重构版本:把 orchestration engine 藏到产品 UI 后面;**不再新增编排核心特性**。不跟风换 Electron,Tauri v2 继续,换的是 renderer。

产品基准(维护者冻结):
- 首屏=「今天想完成什么?」+ 新任务输入 + 开始执行;侧栏 220-260px 只保留 新任务/项目/历史/设置;当前项目+Agent 团队可读呈现;内部 ID(token/executionId/profileId/candidateSha/lease token)默认隐藏。
- 执行期=Agent 时间线(Coordinator/Architect/Developer/Integration/Reviewer 人话状态;节点下钻=在改文件/任务/最近操作/日志/Diff);Reviewer 产品化(问题分级→自动返工→通过);DAG 次级视图、日志三级、raw event 开发者级。
- 设置=AI 模型(已检测/已登录/默认模型)+Agent 团队(四角色映射);Profile/credentialGroup/timeout/maxConcurrency 收进「高级设置」;JSON 全文编辑只在开发者设置;观测台移出一级导航(设置>开发者:Runtime/DAG Inspector/Execution Events/Context/Memory/Raw API)。
- 首启=自动检测 Claude Code/Codex→生成默认 Profiles+默认四角色绑定(推荐组合 Coordinator/Architect/Reviewer→Claude、Developer→Codex,可改)→选项目→输任务。不能要求第一次使用就理解 Profile。
- 会话令牌从界面完全消失:壳自动建立认证会话(维护者已批准方向;安全机制保留,机制与缓解走 ADR,落 M11-01)。
- page.ts 不删,重新定位为 /debug 诊断控制台(原始事件/DAG/Context/approvals/raw JSON);正式 / 由新 desktop UI 接管。
- 视觉冻结:Light/Dark;主区最大阅读宽 ~900px;Inter/系统中文字体;极少颜色;1px 边框;8/12px 圆角;无大面积阴影;状态色仅 running/success/error/warning;Lucide 统一图标。
- 技术栈:React+TypeScript+Vite+React Router;Zustand/Radix 可选;尽量少依赖。新依赖与新包走双登记(boundary/release 审计断言同步)。

### M11-01 · Desktop Renderer 基座(自动认证+脚手架+设计系统+基础布局;orchestration 语义零变化)——**2026-10-07 交付**(交付摘要见下方 M11-01 节)
范围:①ADR:令牌自动会话机制(方案对比+红线修订+缓解:仅 loopback 来源/内存中转/不落日志不持久化/令牌文件 ACL 不变);②壳/serve 接线自动认证,旧页面令牌输入在已认证时隐藏(每个候选保持产品可用);③apps/desktop-ui 脚手架+设计 token+基础布局(侧栏/主区/路由)+新任务/项目/历史/设置四入口骨架;④壳默认加载新 UI(/app);page.ts 重定位 /debug 于新 UI 接管 / 时执行(M11-03,保持 browser-e2e 旧页测试面与产品连续性);⑤审计断言双登记(新包 37→38、新外部依赖)。
完成标准:新 UI 在壳内可用(骨架+新任务入口可达);全量门禁绿;ADR 在案;10 轮审查。

### M11-01 · Desktop Renderer 基座(2026-10-07 交付摘要)

- **任务 1 令牌自动会话(commit aa49f7c,13 文件)**:ADR
  docs/adr/010-token-auto-session.md(冻结面,CHECKSUMS 增行)——壳注入
  Authorization 选定(一次性引导码/维持手动/tauri on_web_resource_request
  三替代方案对比,后者技术不可行已核实),缓解六条(仅 loopback 来源/
  内存中转/不落日志不持久化/令牌文件 ACL 不变/壳不记日志/页面不可读令牌)
  各有测试锚;壳实现=src/session.rs 纯函数+单测+WebView2 过滤器/回调
  接线(webview2-com 0.39+windows-strings 0.5,均树内同版,锁文件零新增
  crate)+source_invariants 金丝雀(session.rs 零日志零写盘,全壳 fs 白名单
  恰两处);page.ts 唯一页面增强=探测 /api/v1/session 已认证隐藏令牌栏
  (未认证/纯浏览器零 DOM 变化,手动流零回归)。
- **任务 2 新 UI 基座(commit 7ebeb9c,43 文件)**:apps/desktop-ui 新包
  (Vite8+React19+TS+Router7+Lucide,白名单内;组件原语自建);设计 token
  落冻结规范(Light/Dark 跟随系统/中性灰阶+四状态色/1px 边框/8-12px 圆角/
  无大面积阴影/Inter-系统字体/主区 900px/侧栏 240px);侧栏四入口+/app 根;
  首页『今天想完成什么?』+项目下拉+开始执行接 POST /runs(类型化拒绝
  人话化,校验留服务端)+项目/历史(人话状态:outcome 优先派生)/设置
  占位骨架;内部 ID 不进默认视图。单文件构建(vite 本地插件内联,281.78KB
  唯一 HTML)+local-api /app 路由(内容哈希 CSP,产物缺失 302→/ 旧页)
  +壳默认 URL→/app+安装器 resource 增 desktop-ui.html。**新增只读
  GET /api/v1/projects**(范围判断如实披露:项目列表无既有端点,只回
  repoRoot+createdAt 不含内部 id)。
- **审计双登记**:boundary(manifest 36→37+R2 增 react/react-dom/
  react-router-dom/lucide-react+扫 apps/+repo 级 pin)与 release(importers
  37→38、外部依赖 111→123、THIRD_PARTY_NOTICES 增 12 名全覆盖)同步,
  PROPOSALS 治理披露节承载 count-baseline 披露。
- **门禁(逐命令退出码见 reports/M11-01-BATCH.md §8,不入冻结面)**:
  cargo test(壳)exit 0、planning-check 80/80 exit 0、pnpm typecheck 62/62、
  pnpm build 37/37、pnpm test 74/74(local-api 285/285)、desktop-ui
  build/typecheck/test 10/10、browser-e2e 直跑 12 文件 23/23(旧页零回归
  +/app smoke)、boundary-audit 36/36、release-audit 43/43。
- **未验证项**:真窗人工观察(壳内 /app 渲染+自动认证端到端+WS 握手注入
  路径)=维护者环境动作③扩展面;安装态(NSIS→壳读 desktop-ui.html)
  归 M11-05 安装态 E2E;10 轮审查属批次后续流程,未开始。

### M11-02 · 首启零配置(CLI 自动发现+默认 Profiles+默认绑定)——**2026-10-08 交付**(交付摘要见下方 M11-02 节;默认四角色绑定与壳 --profiles 接线归 M11-03 交接,范围判断见摘要)
范围:自动检测已安装 CLI(claude/codex)→生成默认 Profiles(推荐组合,可改)→默认四角色绑定;首启向导;profiles 为空引导路径。
完成标准:干净环境启动→引导→建出第一条任务的完整路径;10 轮审查。

### M11-02 · 首启零配置(2026-10-08 交付摘要)

- **任务 1 首启零配置服务面(commit a21fc58,11 文件)**:只读 CLI 自动
  发现模块(PATH 逐目录+~/.local/bin+npm 全局前缀[仅环境变量];纯函数+
  注入文件探针;零 shell/零进程执行/零提权=结构金丝雀钉死;未发现=如实
  not found);GET /api/v1/setup/status(zod 钉死:CLI 发现+profiles
  fileState 四态+默认绑定模板建议);POST /api/v1/setup/first-run(推荐
  组合生成默认 profiles,经既有原子原语落盘;幂等=拒绝 409
  PROFILES_ALREADY_CONFIGURED;双无 422 含清单;restartRequired 不热
  重载如实);serve 首启态桥(--profiles 声明但不存在=零 profile 启动,
  语义变更如实披露);API_AND_EVENTS 登记两新端点+补 GET /api/v1/projects
  行(移交族 C)。
- **任务 2 首启向导 UI+移交族收口(commit 2c70e7b,19 文件)**:desktop-ui
  新路由 /app/setup+首页探测引导卡(七态人话组件;双 CLI 未发现→如实列
  清单+手动指引;零内部 ID;侧栏四入口不变)+M11-01 审查移交族 A/B/H/
  I/J/G/F-R/K/D-E-O-P 逐项收口(旧工作台链接 basename 缺陷修复+href 钉
  死;defaultAppUiAsset 单一 fileURLToPath 惰性定位器;/app 302 补全套
  SECURITY_HEADERS;runErrors 词汇补全+死映射删除;两处注释与实际对齐;
  smoke 缺产物改硬失败[决策:套件惯例+turbo 边已在,双臂实测];
  sync-shell-sidecar serve-bundle 陈旧度守卫[stale exit 1/新鲜 exit 0
  双态实测];ADR 010 四处勘误,CHECKSUMS 行重算)。
- **范围判断(如实)**:登记范围四项交付三项+向导——**默认四角色绑定未
  在本批交付**(绑定写与项目登记存在先后依赖:项目行由首次 POST /runs
  创建,向导阶段项目尚不存在;归 M11-03 与项目登记一并处置,status 已回
  模板建议,绑定写沿既有事务式 PUT 零新增语义);壳侧 --profiles 无条件
  接线归 M11-03(生产壳链路进入首启态的前置)。
- **门禁(逐命令退出码见 reports/M11-02-BATCH.md §8,不入冻结面)**:
  pnpm typecheck 62/62、pnpm build 37/37(desktop-ui dist 291,634B 含
  向导)、local-api vitest 28 文件 325/325、desktop-ui vitest 23/23、
  browser-e2e app-shell-smoke 1/1(真实 Chromium)+缺产物硬失败臂实测、
  planning-check 80/80+self-test exit 0(历次冻结面重算后)、
  sync-shell-sidecar 守卫双态实测。
- **未验证项**:真窗首启全流程(壳→向导→first-run→重启→建任务)与真实
  CLI 存在性=维护者环境;browser-e2e 其余 11 文件与全仓 pnpm test 本批未
  跑(各包套件均直跑绿);10 轮审查属批次后续流程,未开始;安装态归
  M11-05。

### M11-03 · 项目+新任务+任务历史主界面——**2026-10-08 交付**(交付摘要见下方 M11-03 节;『维护者真实项目跑通第一个真实任务』归维护者环境动作)
范围:项目选择器(目录浏览+git 校验前置)/新任务向导/任务历史(人话状态);任务详情时间线(节点下钻:在改文件/任务/最近操作/日志/Diff)。
完成标准:维护者真实项目跑通第一个真实任务;10 轮审查。

### M11-03 · 项目+新任务+任务历史主界面(2026-10-08 交付摘要)

- **任务 1 项目流+向导(20 文件)**:POST /api/v1/projects 项目登记新面
  (严格单字段;四道 fail-closed 门与运行创建逐门一致;同 store 原语/派生
  id/平台映射=与 ensureProject 逐项对齐;幂等=不 upsert;响应零内部 id;
  登记不初始化绑定行=与被拒首运行同形态;『既有』说法勘误与 405→登记的
  唯一语义变化如实披露入 PROPOSALS/批报告)+项目页人话卡片(目录名/绑定
  状态/最近任务数,三只读面客户端 join)+登记流(四道门专属人话句+成功
  引导绑定)+新任务向导(项目下拉+内嵌登记入口→角色绑定检查[未绑定内嵌
  绑定步骤:预填 defaultBindingTemplate、既有事务式 PUT、四角色产品名
  卡片]→目标→开始执行;多节点『高级』折叠人话预检对齐 multi-node.ts
  载体)+移交族 B(notFoundMissNames 共享提取器)与 C(oneShotGate 同步
  双发守卫,NewTaskPage+SetupPage 同族)+nul 清理。
- **任务 2 历史与时间线(10 文件)**:历史页点行进详情;详情页 Agent
  时间线(声明依赖 Kahn 分代=轮内并行同排;节点人话名+状态徽标+耗时可得
  则示;下钻=尝试次数/执行日志/在改文件-Diff)+审批操作接入既有守卫面
  (ApprovalCard 全要素/失效不给按钮/local-operator)+三处不可得如实降级
  (节点 kind 专名/等待集成态/agent 节点文件活动)+内部 ID 折叠开发者
  详情+browser-e2e 新 UI 核心流(登记→绑定→建任务→详情→历史,真
  Chromium)+移交族 D(createProfilesFileAtomic 三拒绝分支原语级测试
  [last-look 探针注入缝];setup.test 声称变断言+头注修)。
- **范围判断(如实)**:目录浏览二选一裁决=纯路径输入+校验按钮,不做
  GET /api/v1/fs/list(单操作者本地产品不新增宿主目录枚举面);POST
  /api/v1/projects 为新增 mutating 面(超出『新增只读端点』字面清单,
  理由=移交的『按目录预登记』候选+零编排语义,已披露)。
- **门禁**:pnpm typecheck 62/62、pnpm test 74/74(第 1 次全量因
  beforeAll 钩子 10s hookTimeout 负载超时返修一次:同包先例 60s 显式
  钩子超时)、pnpm build 37/37、desktop-ui 62/62、local-api 30 文件
  343/343、browser-e2e 核心流 1/1+smoke 1/1、planning-check 80/80。
- **未验证项**:维护者真实项目+真实 Claude/Codex 首任务(完成标准的
  真实面,红线归维护者);审批决策浏览器内点击与真窗壳注入全流程;
  10 轮审查属批次后续流程,未开始。交接面见 reports/M11-03-BATCH.md §9。

### M11-04 · 执行可视化+Review+Approval+Diff——**2026-10-08 交付**(交付摘要见下方 M11-04 节;『多节点真实任务全流程』的自动化面已建,真实 Claude/Codex 最后一步归维护者环境动作)
范围:多 Agent 并行执行可视化(轮内并行/审批暂停/返工循环人话呈现);Reviewer 产品化(问题分级+返工循环);审批卡;Diff 查看。
完成标准:多节点真实任务全流程在产品 UI 内闭环;10 轮审查。

### M11-04 · 执行可视化+Review+Approval+Diff(2026-10-08 交付摘要)

- **任务 1 M11-03 移交优先项(18 文件)**:minor ⑧ blocked 非终态(runIsTerminal
  移 runStatus 纯层+语义修正;decide 后重拉四面+手动刷新)+⑦ WORKFLOW_* 九类
  人话句(含 cycle 专属句;头注/格题量词修真;workflowDraft 集成句与服务端
  原句消一字差)+⑤⑥ 预填句三态如实+绑而未载入/未绑定完整区分(向导+项目
  页第四态)+① 34/35 笔误(backlog.json;BACKLOG.md 无此笔误如实更正范围;
  批报告 §6 标题同笔误就地更正)+⑨⑬⑪⑫⑮⑯ 轻项(日志满页提示/ApprovalCard
  头注限定可见文本/timeline 头注修真/e2e 滤网收紧对齐 smoke/空真断言删除/
  405 漂移+派生 id 同构披露入批报告)。
- **任务 2 验收主面(11 文件,7 新)**:多节点可视化——节点图次级视图
  (时间线/节点图切换,节点 N 标签零裸 id 结构行)/轮内并行(分代同排)/
  返工轮次(复用既有 expansions 端点零改动:真实轮次+fix/re-review 节点状
  态标签+A20 hold 如实文案[处置入口不存在经勘察修真])+审批暂停高亮与
  『等待你的决定』引导;Reviewer 产品化——勘察:verdict/findings 可得、分
  级不可得如实降级;唯一服务端新增=只读 GET /runs/:id/review-records(守
  卫+zod strict+白名单投影,API_AND_EVENTS 登记);下钻呈现结论+findings
  列表+无分级句+返工状态;Diff——unified 文本既有端点可得,diffLines 纯分
  类器+UnifiedDiff 组件自有轻量渲染(零 dangerouslySetInnerHTML 零高亮库,
  双截断声明);审批 e2e app-approval-flow(action-proposal 全链;旧实现判
  别力双向实证:临时还原 blocked=终态恰红→复原绿)。
- **任务 3 实时性决策+可视化补充(4 文件,1 新)**:二选一裁决 (a) 保持 3s
  轮询+如实标注(PollRefreshBadge 唯一口径声称点+日志面板『按需加载不自动
  续拉』分口径标注;(b) one-time ticket WS 放弃理由全文入批报告 §7:新增票
  端点+WS 认证链改动伴生 ADR 010 冻结面增补与票时钟/重放边界,成本高于单
  操作者产品收益;WS 直播保留旧观测台开发者路径);可视化组件化
  (RunVisualization 三组件)+SSR 渲染契约 3 格(裸 id 泄漏/伪造空轮次/终
  态谎称三重判别力)+e2e 并行双卡真浏览器钉(『第 1 波(2 个角色并行)』+
  第一波恰 2 卡+合并依赖行正则)。
- **门禁**:pnpm typecheck 62/62、pnpm test 74/74(直跑显式计数:local-api
  30 文件 349/349+6、desktop-ui 8 文件 79/79+9、browser-e2e 15 文件 26/26
  +3 旧流零回归)、pnpm build 37/37、planning-check 80/80+self-test exit 0;
  32 文件逐字节纯 LF 无 BOM。
- **未验证项**:『多节点真实任务全流程』的自动化面=hermetic 全链已建并绿
  (app-rework-flow:双并行根→集成→评审 fail→两轮返工→hold,真
  Chromium),真实 Claude/Codex 最后一步归维护者环境动作(红线);节点级
  『在改文件』持久化评估完成=不可得,维持降级呈现(结论登记批报告 §10);
  彩色 diff 行真窗像素、hold 处置入口(无 HTTP 面)、10 轮审查(未开始)
  详见批报告 §10/§11;交接面见 reports/M11-04-BATCH.md §11。

### M11-05 · 设置+开发者模式+安装态 E2E+v0.4.0
范围:设置重写(AI 模型/Agent 团队/高级折叠);开发者模式收纳;安装态 E2E(干净机路径);版本抬升 v0.4.0+发布(维护者批准链)。
完成标准:干净机安装→零配置→首任务全流程;v0.4.0 发布就绪;10 轮审查。
