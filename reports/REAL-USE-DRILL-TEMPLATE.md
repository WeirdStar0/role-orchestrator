# 真实使用演练模板(V031-02 备料,v0.3.1 维护者主线)

v0.3.1 最重要的未验证项是**产品内 Claude+Codex 真实 E2E**(BACKLOG「维护者环境
动作①」)。本模板把该主线落成可执行的记录格式:5 类真实任务 × 13 项指标
(指标定义见 docs/BACKLOG.md v0.3.1 节 V031-02 行;聚合口径与 13 项指标的
可导出/unknown 判定见 `scripts/usage-stats.mjs` 头注释)。

本模板属演练留档面,不入冻结面;填写后的副本由维护者归档(建议
`reports/` 下按日期另存,或在项目外留存——含真实任务内容,自行决定脱敏程度)。

## 1. 一次性准备(每台机器一次)

1. **安装与启动**:运行 NSIS 安装包,打开壳(壳自动拉起本地 serve,仅回环);
   关闭按钮 = 隐藏到托盘。详见 README「开箱即用」节。
2. **令牌获取(壳令牌文件模式)**:serve 启动即生成 256-bit 会话令牌写入
   当前用户临时目录下 0o600 令牌文件(默认
   `%TEMP%\role-orchestrator-local-api\session-token-<随机>.txt`);托盘菜单
   「打开令牌文件」用系统默认程序打开,把令牌粘贴进工作台页面完成登录。
   壳不经手令牌内容;API 无令牌一律 403。
3. **profiles 配置**:把符合冻结 ProfilesFileSchema 的严格 JSON 放到
   `%LOCALAPPDATA%\role-orchestrator\profiles.json`(可由
   `config/profiles.example.yaml` 转换),或在页面「配置」页签查看/原子写回
   (写回不热重载,**重启壳生效**;同 id 改 model 不产生新 revision,要换模型
   请新建不同 id)。至少准备:claude 系 profile 一个、codex 系 profile 一个,
   真实凭据留在各自 CLI 的自有认证里(产品不接触凭据)。
4. **角色绑定**:在「配置」页签为目标项目目录一次性保存四角色绑定
   (`PUT /api/v1/projects/:id/role-bindings`);未绑定目录首次创建任务会以
   422 引导先绑定。任务创建对绑定零副作用(只读并冻结快照)。
5. **验证环境就绪**:浏览器打开工作台,能看到任务列表空态页即就绪。

## 2. 每次演练的操作步骤(通用 SOP)

1. **选一类任务**(下方 D1–D5 之一),在真实项目仓库(绝对路径、已存在、
   git 仓库、无未提交修改)上定义 objective。
2. **建任务**——单节点与多节点 workflow 两种方式都应覆盖:
   - 单节点:工作台表单填 objective 与项目目录,直接创建
     (引擎按裸 objective 驱动单节点)。
   - 多节点:`POST /api/v1/runs` 带 `workflow` 字段声明 DAG。body 严格校验
     (未知字段一律 400 拒绝):`workflow` 只接受 `nodes`,其 id/name 由系统
     派生、不接受传入;每节点必填 id/role/kind/objective/dependencies 五个
     字段。角色从四角色(coordinator/architect/developer/reviewer)选;
     依赖用节点 id;kind 取 agent|integration|review——**v1 限制:每任务
     至多一个 integration 节点**(integration 节点须至少一个依赖;review
     节点须恰好一个依赖且 role 必为 reviewer)。示例体为 v1 支持的汇聚形
     (两 developer 并行 + 单 integration 汇聚,D3 验证意图):
     ```json
     {
       "objective": "<一句话任务目标>",
       "projectDir": "<绝对路径>",
       "workflow": {
         "nodes": [
           { "id": "plan", "role": "architect", "kind": "agent", "objective": "<设计目标>", "dependencies": [] },
           { "id": "impl-fe", "role": "developer", "kind": "agent", "objective": "<前端实现目标>", "dependencies": ["plan"] },
           { "id": "impl-be", "role": "developer", "kind": "agent", "objective": "<后端实现目标>", "dependencies": ["plan"] },
           { "id": "integrate", "role": "architect", "kind": "integration", "objective": "<集成目标:合并各路产出为 candidateSha>", "dependencies": ["impl-fe", "impl-be"] },
           { "id": "review", "role": "reviewer", "kind": "agent", "objective": "<审查目标>", "dependencies": ["integrate"] }
         ]
       }
     }
     ```
     带 workflow 时各节点由自身 objective 驱动(顶层 objective 仍作为任务
     记录)。要演示 D5 的受控返工扩图(reviewer fail → fix/re-review 节点
     对),审查节点须声明 `kind: "review"`(约束见上)。请求体形状权威描述:
     `docs/API_AND_EVENTS.md` §1。
3. **实时观测**(演练期间随手记,最终填入「人工介入点」与观察栏):
   - 任务列表实时进度(WS 直播事件);节点进入 WAITING_APPROVAL 时出现
     审批卡片——一次性 actionDigest,批准/拒绝都只针对单个动作;
   - 记录每次人工动作:何时批准/拒绝、为何拒绝、是否出现「等用户」挂起
     (三轮审查耗尽)或阻塞徽标(outcome=blocked);
   - 失败/中断时截图或抄录失败徽标(status+outcome 双字段呈现)。
4. **跑完留档**(run 结束或到达稳定终态后):
   ```bash
   node scripts/usage-stats.mjs --db "%LOCALAPPDATA%\role-orchestrator\orchestrator.db" --format md --run <runId> > <归档路径>/usage-<日期>-<任务类>.md
   ```
   脚本只读打开库(node:sqlite `readOnly: true`,即 SQLITE_OPEN_READONLY),
   绝不写用户库;输出含 13 项指标与 unknown
   说明。JSON 形态(`--format json`)适合程序化汇总。
5. **登记**:把导出中的 13 项指标抄入对应任务节的登记表;⑨⑪两项
   (unknown——库中无持久记录)用人工观察补记;六个观察维度逐项打分。

## 3. 13 指标登记表(空表模板,每任务复制一份)

| # | 指标 | 来源 | 记录值 |
|---|---|---|---|
| ① | 任务成败 | 导出:status/outcome | status= ______ / outcome= ______ |
| ② | 用到的角色 | 导出:节点角色计数+冻结快照 | ______ |
| ③ | DAG 实际展开 | 导出:节点/边数+扩图标注 | ______ 节点 / ______ 边(扩图 ______) |
| ④ | executions 数 | 导出 | ______ |
| ⑤ | 失败/重试次数 | 导出:终态分类+attempt≥2 | FAILED ___ / INTERRUPTED ___ / 重试 ___ |
| ⑥ | 审批次数 | 导出:approvals+checkpoints | ______(状态分布 ______) |
| ⑦ | Reviewer fail 次数 | 导出:review_records verdict=fail | ______(pass ___ / blocked ___) |
| ⑧ | 上下文命中 | 导出:context_bundles 行数 | ______(v1 产品路径现状预期 0——读侧注入不落新 bundle 行,见脚本头注释) |
| ⑨ | Memory 命中 | **unknown**——库中无持久记录 | 人工补记:prompt 中「相关记忆」块是否出现/条数/是否相关: ______ |
| ⑩ | 总耗时 | 导出:执行区间近似 | ______(起 ______ 止 ______) |
| ⑪ | CLI usage | **unknown**——库中无持久记录 | 人工补记:CLI 侧会话/token 估计、模型名: ______ |
| ⑫ | 人工介入点 | 导出:介入时间线 | ______ 次(明细见导出明细节) |
| ⑬ | 最终 diff 指针 | 导出:integration branch+candidateSha | ______ |

## 4. 人工观察栏(每任务必填——维护者评估提的六个真实问题维度)

| 维度 | 观察要点 | 评分(1–5,5=好) | 证据/备注 |
|---|---|---|---|
| Coordinator 拆任务质量 | objective 是否被合理分解;拆分粒度/边界/顺序是否恰当 | | |
| Architect 冗余度 | 设计产物是否过度设计/空转;产出物对下游是否真的有用 | | |
| 依赖上下文适量度 | 下游节点拿到的上游产物引用是否适量(过少/淹没) | | |
| Developer 重复工作 | 实现节点是否重复造轮子/重复改同一处;返工是否聚焦 | | |
| Reviewer 严苛度 | 审查发现是否真实有效;过松/过严/风格化否决各占多少 | | |
| Memory 噪声 | 注入的相关记忆块是否有噪声;无关记忆是否被误注入(对照⑨补记) | | |

## 5. 五类任务演练节(每类复制第 3/4 节两张表填写)

### D1 · 小 bug 修复

- 日期/仓库/分支基线: ______
- objective(原文): ______
- 建任务方式:单节点 / 多节点(圈选)
- run id: ______
- [在此粘贴第 3 节 13 指标登记表]
- [在此粘贴第 4 节人工观察栏]
- 意外与偏差(超时/取消/恢复/审批拒绝等): ______

### D2 · 小功能新增

- 日期/仓库/分支基线: ______
- objective(原文): ______
- 建任务方式:单节点 / 多节点(圈选;建议至少跑一次多节点 workflow 面)
- run id: ______
- [在此粘贴第 3 节 13 指标登记表]
- [在此粘贴第 4 节人工观察栏]
- 意外与偏差: ______

### D3 · 跨前后端功能

- 日期/仓库/分支基线: ______
- objective(原文): ______
- 建任务方式:单节点 / 多节点(圈选;本类预期多节点——前后端两 developer
  节点并行 + integration 单节点,验证 v1 集成限制下的真实协作)
- run id: ______
- [在此粘贴第 3 节 13 指标登记表]
- [在此粘贴第 4 节人工观察栏]
- 意外与偏差: ______

### D4 · 架构重构

- 日期/仓库/分支基线: ______
- objective(原文): ______
- 建任务方式:单节点 / 多节点(圈选)
- run id: ______
- [在此粘贴第 3 节 13 指标登记表]
- [在此粘贴第 4 节人工观察栏]
- 意外与偏差: ______

### D5 · Reviewer 首轮 fail 返工

- 日期/仓库/分支基线: ______
- objective(原文): ______
- 建任务方式:单节点 / 多节点(圈选)
- 编排面预期:Reviewer 首轮 fail → 引擎受控扩图出 fix/re-review 节点对
  (review_expansions 落库,导出③的「扩图」计数 >0);若三轮耗尽出现
  「等用户」挂起(⑫时间线 run-hold),人工显式处置
- run id: ______
- [在此粘贴第 3 节 13 指标登记表]
- [在此粘贴第 4 节人工观察栏]
- 意外与偏差: ______

## 6. 留档与如实记录纪律

- ⑨Memory 命中、⑪CLI usage 当前在库中**无 run 级持久记录**(unknown-deny,
  见 `scripts/usage-stats.mjs` 头注释 ⑨⑪ 口径)——登记表以人工观察补记,
  不伪造成导出值;后续批若补持久记录,导出会自动改为真实值。
- ⑧上下文命中在 v1 产品编排路径现状预期 0(bundle 的 assemble+persist
  当前只有 dogfood/browser-e2e 驱动面写入)——照实记 0,不是故障。
- 真实数据含仓库内容与任务内容:归档副本自行决定脱敏程度;不要把令牌、
  凭据或 CLI 认证内容写进任何留档(A36/安全要求边界)。
- 演练中发现的产品缺陷按常规提案渠道登记(PROPOSALS/维护者清单),
  不在本模板内修问题。
