# M11-06 批报告:角色配置模型选择(每角色 CLI×供应商模型)

批次日期:2026-10-08(本文件不入冻结面,历批同口径)。本批按 ask 分任务推进;
本文件随任务增量补写,提交形态以后续任务的批报告 §1 终稿为准。

## 1. Summary(随任务更新)

- **任务 1(model 传递链端到端核实,本批功能成立前提)**:**结论①——链路
  完整**,`profile.model` 从 profiles 文件到 CLI 子进程 argv 旗标逐层贯通、
  零断环,任务 2 可直接做。每层证据见 §2;与保存语义直接相关的四条既有
  语义(M9-04 同 id 改模型不生效→id 约定是生效必要条件/drift 门七字段不含
  model/A02 模型只经 snapshot 通道/无热重载重启生效)见 §3。一个**非传递链
  断环**的观察面缺口如实登记:fake-cli 对 `--model`/`-m` 静默忽略、全仓无
  `_argv` 断言面,见 §4——属测试夹具层缺口,不影响链路成立。
- **任务 2(角色配置模型选择交付)**:Settings「Agent 团队」与新任务向导
  绑定步升级为每角色 (CLI×模型) 选择;保存=(CLI,模型)→**add-only diff-
  merge upsert** 经既有 PUT /api/v1/profiles/full 原子写回→既有事务式绑定
  PUT;新 profile 未载入时绑定诚实**待重启**(不发注定 422 的 PUT),重启
  后再保存即切换;同 id 冲突/非法标识在 UI 侧人话拒绝。**零新增端点、服务
  端 src 零触碰、零新增外部 npm 依赖**。e2e(app-model-flow)以夹具式
  argv 记录 wrapper(§4 候选 4 落地,非 engine 改动)实证全链:改 开发→
  (Claude, sonnet)→保存(文件 3 条目、既有逐字节保留、绑定不动)→重启
  →再保存(绑定切换)→建任务→**子进程 argv 逐项等于
  `["-p","--output-format","stream-json","--verbose","--model","sonnet"]`**。
  设计与矩阵见 §8;门禁实跑见 §6。

## 2. model 传递链逐层证据(任务 1)

链路:profiles 文件 → serve 启动载入 → 内存 profilesById →(GET /profiles
投影)→ (CLI,模型) 绑定写 → profile_revisions → run 冻结快照 → engine
argv → spawn。逐层:

1. **文件层(契约)**:`packages/contracts/src/schema/profiles.ts:20` —
   `model: z.nullable(z.string().min(1).max(200))`;`:8` 头注明确语义
   「`model: null` means "use the CLI default model"」,且「schema 接受任意
   model 字符串从不代表供应商支持它」(策展清单只是 UI 建议的契约依据)。
2. **启动载入层**:`packages/local-api/src/serve.ts:155-192`
   (loadProfilesOrchestration)— `--profiles <file>` 读文件经
   `parseProfilesFile`(`packages/local-api/src/orchestrator.ts:220-222`,
   即 `ProfilesFileSchema.parse(JSON.parse(json))`,**既有解析器、无第二解
   析**)得到含 `model` 的 `ProfileConfig[]`;ENOENT=首启态零 profile
   (serve.ts:161-169)。
3. **组合根层**:`orchestrator.ts:206-217` createOrchestrator →
   `packages/orchestration/src/run-driver.ts:88-89` 把 profiles 装入内存
   `profilesById` Map——**进程生命周期内载入一次**(无热重载的机制根源)。
4. **投影层(GET /api/v1/profiles)**:
   `packages/orchestration/src/driver-contract.ts:115-122` ProfileSummaryView
   五字段 `id/runtime/executionTarget/model/timeoutSeconds`——**model 在投影
   内**(M11-05 审查发现复核无误:仅五字段、含 model);投影实现
   `run-driver.ts:172-181`(`model: profile.model`);路由
   `packages/local-api/src/server.ts:768-778`。UI 侧消费端:
   `apps/desktop-ui/src/api.ts:327-334` ProfileSummary 客户端类型含
   `model: string | null`,`fetchProfiles`(api.ts:336-357)防御式读取。
5. **绑定写层(事务式 PUT role-bindings → 物化)**:
   `packages/orchestration/src/run-creation.ts:297-305` 绑定只能指向本进程
   已载入 profile(UNKNOWN_PROFILE 422,「add it to the profiles config and
   restart serve」——重启生效语义在绑定入口同样成立);`:323` 逐绑定
   `ensureProfileRow`(find-or-create,`:404-443`:新 profile 建行+首
   revision;已存在则 `:423-433` 七字段漂移比对→409)→
   `ensureProfileRevision`(`:450-464`:仅当无任何 revision 时铸
   revision 1,携带 `model: definition.model`,`:461`)→ 事务式绑定 PUT
   (run-creation.ts:343-349 withTransaction,全落或全不落)。
6. **revision 层**:`packages/runtime-profile/src/entities/profile-revisions.ts:111-121`
   — `profile_revisions` 表 INSERT 含 `model` 列;`:169-182`
   `profileRevisionToSnapshot` 把 `requestedModel: revision.model`
   (:178)放進冻结 `ProfileSnapshot`;schema 运行时体 `:198`
   (`requestedModel: z.string().min(1).max(200).nullable()`)。
7. **run 冻结层(A34)**:`packages/runtime-profile/src/entities/role-bindings.ts:250-319`
   resolveRoleBinding → `:303` 取绑定所钉 revision → `:317`
   `profileRevisionToSnapshot`;`packages/runtime-profile/src/entities/run-snapshots.ts:137-198`
   createTaskRunWithProfileSnapshot 在建 run 同一事务冻结四角色快照
   (`:189-195` insertRunProfileSnapshot,快照 JSON+hash 入
   run_profile_snapshots);服务读路径 `:270-290` readRunRoleProfile **只读
   快照行**且 hash 校验失败即 SnapshotIntegrityError(`:299-335`)。
8. **engine 准备层**:`packages/engine/src/invocation.ts:151` 从冻结快照解析
   (readRunRoleProfile);`:163-166` — `dialectProtocolArgs(dialect,
   snapshot.requestedModel)` 并入 argv;`:68-78` — **claude dialect:
   `requestedModel !== null` → 追加 `["--model", <model>]`;codex dialect →
   追加 `["-m", <model>]`;null → 无 model 旗标**(claude 基础
   `["-p","--output-format","stream-json","--verbose"]`,codex 基础
   `["exec","--json"]`);`:185` manifestHash 载荷含 requestedModel。
9. **spawn 层**:`packages/engine/src/lifecycle.ts:191-202` startExecution →
   prepareExecutionInvocation;`:278-283` `spawn(prepared.command,
   [...prepared.argv], {cwd, stdio pipe})` — **模型旗标随 argv 进入子进程**。
10. **调度链(生产路径)**:`packages/orchestration/src/node-driver.ts:394-414`
    launchExecution → engine startExecution(claimedAttempt);invocationArgs
    通道经 `resolveExecutionSettings`(`packages/orchestration/src/execution-input.ts:68-76`)
    只取 timeoutSeconds/invocationArgs——模型不经此通道(见 §3 A02)。

**单测佐证(本会话实跑)**:
- `packages/engine/test/invocation.test.ts:56-78` — dialectProtocolArgs 双
  dialect 有/无 model 四臂直断言(`claude+"m1"→[--model,m1]`;
  `codex+"m1"→[-m,m1]`);`:80-111` — invocationArgs 夹带 `-m`/`--model` 被
  ModelOverrideArgError 拒绝。实跑:`npx vitest run test/invocation.test.ts`
  (packages/engine)→ **10/10 passed**。
- `packages/runtime-profile/test/role-bindings.test.ts:281-302` — 绑定钉
  rev2(model="glm-4.7")→ snapshot.requestedModel==="glm-4.7";
  `test/run-snapshots.test.ts:85-122` — A34 核心格:重绑后旧 run 读回
  revision 1/model null、新 run 读回 revision 2/model "glm-4.7"。实跑:
  `npx vitest run test/role-bindings.test.ts test/run-snapshots.test.ts`
  (packages/runtime-profile)→ **37/37 passed**。

## 3. 既有语义四条(与 M11-06 保存语义直接相关,逐条核实)

1. **同 id 改模型不生效(M9-04)→ M11-06 id 约定是生效的必要条件**:
   `run-creation.ts:455` — `ensureProfileRevision` 在该 profile 已有任
   意 revision 时直接 return(不铸新 revision);同 id 文件编辑哪怕 model
   变了,新任务仍用首次创建的 revision。`packages/local-api/src/profiles-config.ts:31-39`
   头注原文登记此语义(「later same-id edits (model included) neither mint
   a new revision nor affect already-created tasks — to change a model,
   create a profile with a DIFFERENT id」)。⇒ 任务 2 的 (CLI,模型)→
   profile upsert 必须落实「定制模型→新 id `<runtime>-<model>` 规范化」,
   否则模型选择静默不生效。
2. **drift 门七字段不含 model(M9-04)**:`run-creation.ts:423-433` — 漂移
   比对恰为 runtime/executable/executionTarget/configDir/credentialGroup/
   maxConcurrency/timeoutSeconds 七字段(409 PROFILE_DEFINITION_CONFLICT);
   model 不在列 ⇒ 同 id 重启重载时仅 model 不同的文件不触发 409(但依第 1
   条也不生效);不同 id 的 (CLI,模型) profile 各自首建互不冲突。ask 红线
   第 4 条「同 id 不同七字段→409 人话」与既有语义一致,零新语义。
3. **模型只经 profile snapshot 通道(A02)**:`invocation.ts:80-94,158` —
   invocationArgs 逐元素拒绝 `-m`/`--model`(ModelOverrideArgError);
   `packages/runtime-profile/src/entities/run-snapshots.ts:141` 建 run 输入
   `assertNoProfileModelOverride`(`packages/runtime-profile/src/no-override.ts:27-40`
   FORBIDDEN_OVERRIDE_KEYS 含 model/modelId/requestedModel 等十三种拼写)。
   ⇒ 任务 2 的 UI 写面只有 profiles 文件(经 PUT /profiles/full 或后续
   upsert 语义)与绑定 PUT,不存在也不得开第三条旁路。
4. **无热重载,重启生效**:`profiles-config.ts:25-30` — 写回只改文件,不触
   本进程内存 profiles(组合根载入一次);GET /profiles 与 POST /runs 在重
   启前继续应答启动时定义。⇒ 任务 2 保存后 UI 必须如实提示「重启桌面应用
   生效」(M11-05 设置页既有口径复用)。

**原语现状(任务 2 将复用,本任务零改动)**:原子写回
`writeProfilesFileAtomic`=validate→同目录临时文件→writeSync 字节数断言→
fsync→rename 单提交点(profiles-config.ts:125-229);首启 CREATE 姊妹
`createProfilesFileAtomic`(last-look 注入缝,M11-03 交付,
profiles-config.ts:248-363);事务式绑定 PUT=run-creation.ts:343-349 单事务。

## 4. fake-cli 观察面(ask 专项:_argv 断言面能否观察 model)

- **接受但丢弃**:`packages/fake-cli/src/args.ts:22-25` IGNORED_WITH_VALUE —
  claude: `["--output-format","--model"]`;codex:
  `["-m","--model","--sandbox","--output-last-message-file"]`——解析时读掉
  值后丢弃(`:186-189`),**不记录、不回显**。
- **`_argv` 断言面不存在**:`grep -rn "_argv" --include=*.ts packages apps`
  零命中(2026-10-08 本会话)。ask 设想的 fake-cli `_argv` 断言面在当前仓
  库没有对应物,如实登记,不假造。
- **既有可观察面**(任务 2/4 e2e 断言 model 透传的候选,供裁决,本任务零
  改动):
  1. 单元/集成层:engine `prepared.argv` 直断言(invocation.test.ts:113-158
     既有形态)+ dialectProtocolArgs 四臂——已覆盖旗标生成逻辑;
  2. launch-failure 事件载荷带完整 argv(`lifecycle.ts:543-556`,
     `argv: [...prepared.argv]`)——仅失败路径,不适合正常流断言;
  3. manifestHash 混入 requestedModel(invocation.ts:171-194)——哈希不可读,
     只能做不变性断言;
  4. (需改夹具)fake-cli 增设 argv 记录面(如 `--args-file` 或把忽略的
     model 值写入某可见输出)——属 **fake-cli 测试夹具改动**,不触碰
     engine/orchestration 语义;是否在本批引入由任务 2/4 按其 ask 裁决。

## 5. 真实 CLI 接受度(历史 REAL fixtures,非本会话实跑)

`packages/capability-gate/src/registry.ts` 两条 verified 记录(M0-M7 期以真
实 CLI 采集,FIX/*.real.jsonl 在库):
- `claude.model-settings.acceptance`(registry.ts:246-256):模型名不做参数
  层校验;无效名=stderr unrecognized_model 警告+init.model 透传+网关 400
  (无重试);有效名无警告且 init.model 原样回显。
- `codex.model-settings`(registry.ts:385-391):参数层不拒绝任意名;账号层
  门控——有效名成功、无效名与账号未授权名同形 turn.failed;接受度按账号
  而非二进制目录。
配 `claude.model-settings.inference`/`codex` 推理面当时被 429 阻断为
unverified(registry.ts:257-261)。⇒ 真实 CLI 对模型旗标的**接受语义**有历
史实采证据;「本产品 spawn 后模型旗标真实生效」仍属维护者真实面(红线,
与历批口径一致)。策展清单标注『以 CLI 实际支持为准』与此两条 verified/
unverified 边界相容。

## 6. 门禁实跑(2026-10-08 本会话,逐命令)

**任务 1**:pnpm typecheck 62/62 exit 0;pnpm build 37/37 exit 0;佐证
engine invocation.test 10/10、runtime-profile role-bindings+run-snapshots
37/37(当时零源码改动,产物仅本报告)。

**任务 2**(交付后全量复跑,逐命令):
- `pnpm typecheck` → **62/62 successful, exit 0**;
- `pnpm test` → **74/74 successful, exit 0**(turbo 全仓;其中 desktop-ui
  vitest 8 文件 **111/111**(+22:profileUpsert 矩阵 16 格+RoleComboEditor
  渲染 4 格+profilesFull 人话 2 格)、browser-e2e vitest 16 文件 **27/27**
  (+1:app-model-flow 1 格;app-product-flow/app-approval-flow 适配新编辑器
  后原断言全绿=零回归)、local-api 31 文件 349/349(+0,服务端零改动);
- `pnpm build` → **37/37 successful, exit 0**;
- 零新增外部依赖断言:desktop-ui package.json dependencies/devDependencies
  与批前一致(lucide-react/react/react-dom/react-router-dom 等既有面),
  `git diff pnpm-lock.yaml` 零行,git status 零 package.json 改动;
- 15 个改动/新增文件逐字节校验:BOM=False、CR=0、尾 LF(全过)。
- 提交形态:本工作流不自行提交(历批先例,批次终任务一次性提交);
  git add 显式路径由终任务执行;零 push 零 tag。

## 7. 未验证项(如实)

- 真实 Claude/Codex CLI 由本产品 spawn 后模型旗标的端到端生效——未执行
  (红线第 1 条,维护者真实面);本批自动化面的透传证据=app-model-flow 的
  wrapper argv 断言(fake-cli 面,§8.6);接受语义的历史证据见 §5。
- 策展模型清单(claude: opus/sonnet/haiku;codex: gpt-6-astra/gpt-6-sol)
  在维护者真实账号上的可接受性未验证——清单是 UI 建议非契约,自定义输入
  与『以 CLI 实际支持为准』标注即为此设计;M0-04 证据同时表明 codex 模型
  接受度按账号门控(目录内存在的名也可能被拒)。
- 真实壳(桌面应用)内的完整人机流程(点选/重启/再保存)未在真窗演练,
  归维护者;e2e 覆盖的是真 Chromium 点击链(§8.6)。
- `_argv` 断言面:ask 设想物在本仓库无对应物(grep 零命中),已如实登记;
  观察面以夹具 wrapper 落地(§4 候选 4)。

## 8. 任务 2 设计与实现(diff-merge upsert 保存流)

**文件面**(desktop-ui,零服务端改动):
- 新 `src/profileUpsert.ts` — 纯规划器(无 fetch/无 React):
  `composeProfileUpsert`/`normalizeModelToken`/`profilesFileContent`/
  `initialModelSelections`/`loadedAsComboSource`+策展清单
  `CURATED_MODELS`(claude: opus/sonnet/haiku=ask 处方;codex:
  gpt-6-astra=M0-04:36,54 真实成功实证、gpt-6-sol=M8-04:130 真实用量
  实证)与 `MODEL_CHOICES_NOTE`(『以 CLI 实际支持为准』逐渲染面携带);
- 新 `src/teamSave.ts` — 两页共享的保存编排(一处实现防语义漂移);
- `src/api.ts` — 增 `fetchProfilesFull`/`putProfilesFull`(既有 M9-03
  GET/PUT /api/v1/profiles/full 的客户端投影;**零新增端点**);
- `src/runErrors.ts` — 增 `profilesFullFailureText`(PROFILE_SOURCE_ABSENT/
  PROFILES_CONTENT_INVALID 各得一句,原子写面拒绝族);
- `src/components/RoleBindingSection.tsx` — 新 `RoleComboEditor`(每角色:
  CLI select=检测面 detected[来自 setup/status,探针未定→双 CLI+诚实注记;
  当前选择即使未检测也保留并标『未检测到』]×模型 select=[CLI 默认/策展
  清单/文件与已载入中的既有模型/自定义…]+自定义自由输入);旧
  RoleBindingEditor 保留(旧页对等先例);
- `src/pages/SettingsPage.tsx`/`NewTaskPage.tsx` — Agent 团队编辑器与向导
  绑定步接同一编辑器+同一保存流;预填=绑而载入的角色反映现组合、其余取
  defaultBindingTemplate 的 runtime+『CLI 默认』(ask:defaults 之上可选
  模型);待重启=info 态(非成功态),成功/待重启/无变化/拒绝四类文案
  分开如实。

**保存流语义**(teamSave.ts,顺序即 ask 处方):
1. `composeProfileUpsert`:(a) **组合复用先于 id 约定**——(runtime, model)
   在既有条目中已存在(首匹配,文件序)→复用其 id(first-run 的
   `claude-default` 继续作 (claude, 默认) 的目标=『同组合共用一 profile』);
   (b) 无组合→按约定铸新 id:默认 `<runtime>`、定制 `<runtime>-<token>`
   (token 规范化:小写/空白_点串→连字符/去非法字符/掐边连字符;id 需过
   冻结 IdSchema /^[a-z][a-z0-9_-]{0,63}$/——无点,model 值本身原样入文件
   仅 id 面规范化);(c) 铸新条目的非 model 字段**克隆自同 runtime 基条目**
   (优先该角色当前绑定,否则文件首条)——UI 绝不发明 executable/configDir;
2. **add-only diff-merge**:`nextFileProfiles = 既有条目逐字节不动 + 新增`
   ——UI 永不改写既有条目(改写定义是 drift 门的人的决定,409 七字段语义
   的镜像纪律),用户其他 profiles 天然保留(单测『既有保留』格+e2e 磁盘
   文件逐字段断言双证);
3. fileChanged → 既有 `PUT /api/v1/profiles/full`(冻结解析器先验、临时
   文件+rename 原子写回;失败=原文件未动);
4. **绑定可行性预检**:目标 id 全在运行进程已载入集(GET /api/v1/profiles)
   →既有事务式绑定 PUT;有未载入(新铸 profile 定义上未载入)→**不发 PUT**
   (发了必然 422 UNKNOWN_PROFILE)→`bind-pending` 待重启文案(重启后回到
   本页再点一次『保存』即切换;本次绑定没有改动);bindingFailureText 的
   422 人话臂保留为兜底(陈旧 UI 竞态);
5. 幂等:目标=现绑定且文件已含全部组合→`no-change`(零写零绑)。

**冲突/非法拒绝(UI 人话,写入前)**:铸出 id 与既有条目 (runtime, model)
不同→conflict(同 id 不同七字段会在重启时 409、同七字段不同 model 是
M9-04 静默不生效陷阱——两者 UI 都不写,如实拒绝);两个自定义写法坍缩到
同 id 但 model 值不同→conflict;未选 CLI/非法 token/无同 runtime 基条目→
invalid(指向初始设置/旧配置页)。

**无配置文件的可运行降级**(in-process 组合根/未接 --profiles,即旧
app-product-flow/app-approval-flow 形态):`mintable: false`+已载入集经
`loadedAsComboSource` 作组合源→组合复用照常、绑定照常;需新增组合→诚实
拒绝『本服务没有接入 AI 配置文件,无法新增 AI 配置』——旧流(绑已载入
profile)语义无损保留,零回归。

**e2e 观察面(任务 1 §4 候选 4 落地)**:app-model-flow.test 以测试夹具
wrapper(临时目录生成的 .mjs,记录 `process.argv.slice(2)` 后委托内建
fake-cli main)作 profiles 的 executable——engine spawn 路径零改动,fake-cli
面可见 argv;重启模拟=关服→重读文件→以载入态重启(serve --profiles 启动
语义同构,进程内无热重载)。断言链:登记→向导 (CLI×模型) 保存(组合复用,
全部已载入)→设置改 开发→(claude, sonnet)→保存(文件 3 条目/
codex-default 逐字节保留/绑定行未动=DB 双断言+待重启文案)→重启→再保存
(绑定 PUT 落地,DB 断言 developer=claude-sonnet)→建任务→终态已完成→
**argv 逐项等于 ["-p","--output-format","stream-json","--verbose",
"--model","sonnet"]**。同批适配:app-product-flow(全角色选 claude+默认)、
app-approval-flow(worker 夹具 profile 增区分用 model 值 "approval-worker"
——组合复用下同 (runtime,model) 双夹具不可区分,以模型值分化;fake-cli
忽略该旗标,行为零变化),两流的控制台滤网扩 409 臂(页面新增的
profiles/full 409 探针=设计的诚实降态,Chromium 网络注解与 403 臂同性质,
注解不含 URL 属既有局限,注释已如实登记)。

## 9. 变更文件清单(任务 1+2 合计;提交形态=本任务一次性提交)

新增(5):
- `apps/desktop-ui/src/profileUpsert.ts`(纯规划器:组合复用/铸新/冲突/
  规范化/序列化/预填);
- `apps/desktop-ui/src/profileUpsert.test.ts`(upsert 矩阵 16 格);
- `apps/desktop-ui/src/teamSave.ts`(两页共享保存编排);
- `packages/browser-e2e/test/app-model-flow.test.ts`(模型透传 e2e,含
  wrapper 观察面与重启模拟);
- `reports/M11-06-BATCH.md`(本报告,不入冻结面)。

修改(10):
- `apps/desktop-ui/src/api.ts`(fetchProfilesFull/putProfilesFull 客户端
  投影,既有端点);
- `apps/desktop-ui/src/runErrors.ts`(profilesFullFailureText);
- `apps/desktop-ui/src/runErrors.test.ts`(+2 格);
- `apps/desktop-ui/src/components/RoleBindingSection.tsx`(RoleComboEditor);
- `apps/desktop-ui/src/pages/SettingsPage.tsx`(Agent 团队升级);
- `apps/desktop-ui/src/pages/NewTaskPage.tsx`(向导绑定步升级);
- `apps/desktop-ui/src/shell.test.tsx`(+4 渲染格);
- `apps/desktop-ui/src/app.css`(role-combo 编辑器样式);
- `packages/browser-e2e/test/app-product-flow.test.ts`(新编辑器适配);
- `packages/browser-e2e/test/app-approval-flow.test.ts`(新编辑器适配)。

任务 4 冻结面同步(4):`PROPOSALS.md`(治理披露节)、`docs/BACKLOG.md`
(M11-06 完成态)、`project/backlog.json`(deliveryNotes.M11-06)、
`CHECKSUMS.sha256`(三行重算)。合计 19 文件,git add 全部显式路径零 -A。

## 10. 后续批交接

- **model 传递链无缺失层**(任务 1 结论①):不存在『UI 已就绪、生效依赖
  某缺失层修复』的交接项;唯一登记过的观察面缺口(fake-cli 不记录 argv)
  已由任务 2 的夹具式 wrapper 落地(app-model-flow),非 engine/orchestration
  改动。
- 交接归后续批/维护者:①真实 CLI 模型行为(改模型→重启→真实任务按所选
  模型执行)=维护者环境(红线,§7);②策展清单在维护者账号的可接受性
  验证(清单为 UI 建议非契约);③10 轮审查属批次后续流程,未开始;④tag/
  Release 页/归档/推送=审查通过后维护者链,本批零 push 零 tag。

## 11. 审查拦截记录(第 1 轮)

第 1 轮审查以两条**阻断(blocker)**拦截本批;本节登记原文要点+实证+
返修处置。两条均已在本会话修复并独立复核(判别力双向实证),门禁见 §11.5。

### 11.1 B1(写砖级):『同组合共用一 profile』在同次保存内失效

**原文要点**。profileUpsert.ts 的组合复用查找只扫原始文件集(拦截时
HEAD 6fab4d8 的 :247,`input.fileProfiles.find`);同 id 互检只拦『模型值
不同』的坍缩(:283-291);第二个角色再次 mint 同 id 重复 push(:316-318)
→ PUT 写出含重复 id 的 profiles.json;服务端两级均放行(冻结
ProfilesFileSchema 无 id 唯一性约束 profiles.ts:23-26;writeProfilesFullAtomic
仅 parse,profiles-config.ts:125,133),下次 serve 启动必炸
『profile X is defined more than once』(orchestrator.ts:134-141)——桌面
应用拒绝启动,且 bind-pending 文案恰恰引导用户『重启后再点一次保存』=
直通砖死。审查实证:developer+reviewer 同选 (claude,sonnet) → 文件
2× claude-sonnet。

**返修处置(客户端双层,零服务端改动)**:
1. **同次保存组合注册表**(profileUpsert.ts:289-293):`comboRegistry`
   Map,键=(runtime,模型值) 规范化键,启动时按文件序播种(首条优先,
   与旧 find 复用语义完全一致);每次 mint 后把新条目登记进注册表
   (:378)。组合复用查找改查注册表(:305)——同组合(无论条目来自文件
   还是本批 mint)全批共用同一条目,第二个及后续角色不再重复 mint。
   『不同写法、不同模型值坍缩同 id』的既有冲突格保留不变(值不同=不同
   组合,注册表不命中,照旧 conflict)。
2. **写前 id 唯一性断言(防御纵深,两道)**:①规划器返回 ok 前对
   nextFileProfiles 断言(profileUpsert.ts:382-390,原语
   `firstDuplicateProfileId` :235)——发现重复即返回 conflict 人话
   (`duplicateProfileIdMessage`:指向旧工作台清理、明写『本次没有写入
   任何内容』),零字节落盘;②teamSave.ts:83-87 在发 PUT 前对同一集合
   再断言一次(最后一道闸,PUT 永不发写出重复 id 的载荷)。可达的防御
   格=输入文件已被旧实现写坏(盘上已有重复 id)时,连幂等保存也拒绝并
   指向清理,绝不把砖文件再 PUT 回去。
3. **契约不动**:服务端 ProfilesFileSchema 加 id 唯一性约束属契约变更,
   本批登记为提案(PROPOSALS.md『提案:服务端 ProfilesFileSchema 增加
   profile id 唯一性约束』),归后续批/维护者裁决——含『历史砖文件启动
   即拒会把桌面应用锁死在不可修复态』的迁移问题,提案内如实列明。

**矩阵测试补格**(profileUpsert.test.ts 新 describe『同次保存的组合注册
表』,每格注明旧实现怎么红):
- **两个角色同选一个文件中尚不存在的新组合 → 恰一个新条目**(旧实现红:
  复用只扫原文件集 → 第二角色再 mint → addedProfiles 2 条、合并集 2×
  claude-sonnet;本格断言恰 1 条+序列化体恰 1 处);
- **三个角色跨两个新组合 → 恰两个新条目**(旧实现红:addedProfiles
  ['claude-opus','claude-opus','claude-sonnet'] 三条含重复;本格断言恰
  两条、合并集恰 4 条、目标两两相等);
- **同批 mint 后遇『不同写法、相同模型值』→ 共用一条**(值相同=同组合,
  非冲突格;旧实现红:2 条);
- **输入文件已含重复 id(先前砖文件)→ conflict 拒绝零写入**(旧实现红:
  返回 ok 原样透传砖集;本格断言 conflict+人话含 id 与『没有写入任何
  内容』);
- **firstDuplicateProfileId / duplicateProfileIdMessage 原语格**。
既有格(共用既有条目/分化/同 id 冲突两形态/幂等/既有保留含序列化回读/
规范化与 IdSchema 预算/预填三态)零回归。

**判别力双向实证(本会话实跑)**:
- 新测试对旧实现跑:`git checkout HEAD -- <五个源文件>` 后 desktop-ui
  vitest → **11 格红 / 2 文件红**(恰含 B1 四行为格:2 条 added/
  ['claude-opus','claude-opus',…]/2 条同值写法/'ok' 非conflict,外加
  `firstDuplicateProfileId is not a function` 与预填 custom 字段缺失败)
  → 复原后 120/120 绿。
- 旧 vs 新同场景脚本(esbuild 打包 HEAD 源与本批源对照,scratch 用后即
  删不入库)关键输出:
  - OLD(B1 场景 developer+reviewer 同选 (claude,sonnet)):`addedProfiles
    ids = ["claude-sonnet","claude-sonnet"]`、合并集/PUT 体各 2×
    claude-sonnet——与审查实证一致;
  - FIXED:同场景 `addedProfiles ids = ["claude-sonnet"]`、合并集/PUT 体
    各恰 1 处、`firstDuplicateProfileId = null`;三角色跨两新组合
    `added ids = ["claude-opus","claude-sonnet"]`、合并集唯一(OLD 对照
    同场景 `["claude-opus","claude-opus","claude-sonnet"]` 三条含重复)。

**临时目录自证(ask 点名,本会话实跑)**:FIXED 规划器对 B1 场景的 PUT
体写入临时目录
`C:\Users\star\AppData\Local\Temp\ro-b1-repro-93wzGk\profiles.json`
(1078 字节、3 条目),回读 JSON:claude-sonnet 恰 **1** 条
(`{"id":"claude-sonnet",…,"model":"sonnet","extraArgs":[]}`),全部 id
唯一=read-back ids unique = true。

### 11.2 B2(验收面不可达):『自定义…』点不出输入框的不可达闭环

**原文要点**。模型下拉『自定义…』的 onChange 被映射为 `model:""`
(RoleBindingSection.tsx :296-302),而自由文本输入的渲染条件 isCustom
要求 model≠空且不在选项表(:263-266)——点『自定义…』输入框永不出现、
下拉弹回 CLI 默认,构成不可达闭环;『自定义输入』是验收原文点名要素且
四处治理面宣称已交付。

**返修处置(三面一致,一处实现)**:
1. **显式 UI 状态标记,非 model 值派生**:`ModelSelection` 增
   `custom: boolean`(profileUpsert.ts:67-82,头注写明 B2 语义),渲染
   条件改为 `selection.custom`(RoleBindingSection.tsx:295),输入框揭示
   不再依赖 model 值;
2. **输入提交=自定义模型值;清空=回到 CLI 默认**:两个纯转换函数
   `onModelSelectChange`(:237-244,选『自定义…』→ `{model:"",custom:
   true}` 输入框空态揭示;选清单项 → custom:false)与
   `onCustomModelInput`(:247-253,输入值原样作 model;清空("")→
   `{model:"",custom:false}` 回 CLI 默认),组件 onChange 全走纯函数
   (:325,:342)——node 环境可逐态断言;
3. **三处一致**:NewTaskPage/SettingsPage/向导绑定步本就共用
   RoleComboEditor+ModelSelection(一处实现),状态字面量统一改
   `EMPTY_MODEL_SELECTIONS`;预填 `initialModelSelections` 增 knownModels
   参数,绑而载入的**清单外模型**预填即带 `custom:true`(输入框揭示并
   载值),CLI 默认与清单内模型恒 `custom:false`;两页重复的 knownModels
   内联构造收敛为共享纯函数 `knownModelsOf`+`isListedModel`(三面同源,
   防再漂移)。

**渲染/交互测试钉住**(shell.test.tsx,旧实现下必红,已双向实证):
- 显式标记格:`{model:"",custom:true}` 渲染含
  `id="role-model-custom-developer"` 且下拉选中项为 `__custom__`(旧实现
  红:值派生 isCustom=false,输入框缺席、下拉弹回 CLI 默认);
- 交互链格(纯转换分四台):点自定义→`custom:true`→输入框出现→输入
  "sonnet-4-5"→输入框带 `value="sonnet-4-5"`→**保存写出该值**(规划器
  mint claude-sonnet-4-5 且文件体含 `"model": "sonnet-4-5"`)→清空→
  回 CLI 默认(输入框消失)(旧实现红:状态无 custom 字段、输入框不可达,
  该值根本进不了 selections);
- 判别力双向实证:旧源下 shell.test 2 格红(恰含
  `expected '<div class="role-editor role-combo-ed…' to contain
  'id="role-model-custom-developer"'`);旧 vs 新渲染对照脚本输出:OLD
  编辑器在其自身 onChange 产生的『点了自定义』状态下游
  `custom input present = false`、`__custom__ selected = false`;FIXED
  同链四台全真(input present/selected/value/clear)。

### 11.3 提案登记(红线第 1 条的契约面)

服务端 ProfilesFileSchema id 唯一性约束=契约变更,本批不改;已登记
PROPOSALS.md『提案:服务端 ProfilesFileSchema 增加 profile id 唯一性
约束(2026-10-08)』(含历史砖文件迁移问题与多写方互补面),是否立项归
维护者。CHECKSUMS.sha256 的 PROPOSALS.md 行已按盘上纯 LF 字节重算。

### 11.4 变更文件清单(返修,10 文件;git add 显式路径零 -A)

- `apps/desktop-ui/src/profileUpsert.ts`(B1 注册表+双断言原语;B2
  ModelSelection.custom/EMPTY/initialModelSelections(knownModels)/
  knownModelsOf/isListedModel);
- `apps/desktop-ui/src/teamSave.ts`(PUT 前第二道 id 唯一性断言);
- `apps/desktop-ui/src/components/RoleBindingSection.tsx`(B2 显式
  custom 渲染+纯转换函数);
- `apps/desktop-ui/src/pages/SettingsPage.tsx`、`apps/desktop-ui/src/
  pages/NewTaskPage.tsx`(EMPTY_MODEL_SELECTIONS/knownModelsOf/预填传
  knownModels——两页+向导三面同源);
- `apps/desktop-ui/src/profileUpsert.test.ts`(B1 注册表 describe 5 格+
  预填 custom 标记格+knownModelsOf/isListedModel 格,旧实现必红注记逐格);
- `apps/desktop-ui/src/shell.test.tsx`(B2 显式标记格+交互链格);
- `reports/M11-06-BATCH.md`(本节);
- `PROPOSALS.md`+`CHECKSUMS.sha256`(提案登记与校验和,冻结面 2 文件)。
合计 10 文件(7 源+1 报告+2 冻结面)。零 orchestration 语义变化(服务端
src 零触碰);零新增外部依赖;零 push 零 tag。

### 11.5 返修门禁实跑(2026-10-08 本会话,逐命令)

- `pnpm typecheck`(turbo 全仓):62/62 exit 0;
- desktop-ui `pnpm test`:8 文件 **120/120 exit 0**(111→+9:B1 五格+
  预填标记格+原语格+knownModelsOf 格+B2 两格,历格零回归);
- 判别力双向:旧源(HEAD 五文件 checkout)下 **11 格红** → 复原后全绿
  (§11.1/§11.2 引失败断言原文);
- local-api `pnpm test`:31 文件 349/349 exit 0(0 新格,服务端零触碰
  的回归面);
- browser-e2e `pnpm test`:16 文件 27/27 exit 0(app-model-flow 全链含
  `--model sonnet` argv 断言零回归——自定义值写出的文件同链,见
  §11.2 交互链格的规划器断言);
- `pnpm build`(turbo 全仓):37/37 exit 0;
- `node planning-check.mjs`:exit 0——(a) `checksum verification OK:
  80/80 files match CHECKSUMS.sha256`+(b) `validate_bundle.py --self-test
  (in temp copy) exited with code 0`(CHECKSUMS.sha256 的 PROPOSALS.md 行
  按盘上纯 LF 字节重算后,sha256=cefe9494…ac4012,旧值 f4bee456…);
- 10 文件逐字节 BOM=False、CR=0、纯 LF、尾 LF(§11.6 实际检查命令与
  输出)。

### 11.6 LF/字节检查(返修 10 文件,本会话实跑)

命令(逐文件):`tr -cd '\r' < <file> | wc -c`(CR 字节数)、
`head -c 3 <file> | od -An -tx1`(BOM)、`tail -c 1 <file> | od -An -tx1`
(尾字节);另以 `git show HEAD:<file> | tr -cd '\r' | wc -c` 对照 HEAD
blob(=0)。结果:7 个源文件首三字节均 `2f2a2a`(`/​**`)、报告 `23204d`
(`# M`)、PROPOSALS `232050`(`# P`)、CHECKSUMS `386437`(首行哈希首三
字节)——**均无 BOM**;尾字节均 `0a`(尾 LF);CR 字节数均 **0**(纯
LF)。注:先用的 `grep -c $'\r'` 在本 git-bash 下按行误报非零,已换字节
级计数为准并如实登记。
