# M10-01 批次报告:修复创建任务的 RoleBinding 副作用(M10-01-BATCH)

日期:2026-10-04 · 执行角色:Developer · 性质:M10 立项(9abdfe0,后续经
a56e7ac 返修依赖引用)后首个 P0 缺陷修复批;外部深度评估核实 + 维护者
批准路线。前驱:9abdfe0 / a56e7ac;版本:local-api 0.2.0 → 0.2.1。

## 1. Summary

`POST /api/v1/runs` 在 v0.2.0 会把调用方所选 `profileId` 写到项目全部四
个角色的绑定上(`ensureRoleBindings` 的 `setRoleBinding` 循环)——创建
任务产生项目配置副作用,静默覆盖项目原有的差异化角色配置。本批将该副
作用整体移除:任务创建对项目 `role_bindings` **只读**(四角色不齐以
typed 422 拒绝,齐则照旧走 M9 冻结链,快照机制零变化);`profileId`
参数从创建请求移除(显式破坏性变更,0.2.0 → 0.2.1);项目角色绑定改经
独立守卫端点配置:`PUT /api/v1/projects/:id/role-bindings`(恰四角色、
严格 schema、整体事务、ExecutionTargetMismatch typed 422——顺手修复
M9-01 审查登记的该场景 500),另配 `GET
/api/v1/projects/role-bindings?projectDir=<abs>` 只读读面(工作台页面的
Developer 绑定显示)。工作台表单移除 profile 下拉,替换为只读绑定显示
与引导文案。11 文件 +1187/−229(含本报告与 PROPOSALS/CHECKSUMS 同步为
13 文件,见 §4);门禁全绿(§5)。

## 2. 缺陷核实引用

- 外部评估核实声明:M10 立项披露(PROPOSALS.md『治理披露:M10 立项——
  「编排产品化」(2026-10-04)』节)载明「其新发现『创建任务重写四角色
  RoleBinding』属实(orchestrator.ts:561-574 实证)」,经独立核实后由
  维护者批准为 M10-01(P0)。
- 修复前代码(9abdfe0/a56e7ac 时点,packages/local-api/src/orchestrator.ts
  561-574 行):`ensureRoleBindings(projectId, profileId)` 调
  `initializeProjectRoleBindings` 后对 `ROLE_IDS` 循环
  `setRoleBinding({roleId, profileId, canCreateSubtasks: roleId ===
  "coordinator"})`——即请求体里的单个 `profileId`(v0.2.0 schema:
  orchestrator.ts `RunCreateBodySchema` 的 `profileId: IdSchema` 字段)
  被无差别写到 coordinator/architect/developer/reviewer 四行,凡与请求
  值不同的既有绑定一律被覆写。调用点:`createRunChecked` 内
  `await ensureRoleBindings(project.id, definition.id)`。
- 危害口径:项目原有的 claude/codex 差异化四角色配置(经 M9 语义这是
  A01/A02 唯一合法的配置面)被一次普通建任务请求静默改写;冻结快照
  (A34)保护的是**已建**任务,新任务的绑定事实从此漂移。

## 3. 修复语义(前后对照)

| 面 | v0.2.0(前) | 本批(后,0.2.1) |
| --- | --- | --- |
| 创建请求体 | `{objective, profileId, projectDir}` | `{objective, projectDir}`;携带 profileId → 400 INPUT_REJECTED(严格 schema 未知字段,不静默忽略) |
| 创建对 role_bindings | **写**:initialize + 四角色 setRoleBinding(请求 profileId 覆写全部差异) | **只读**:`requireCompleteRoleBindings`(orchestrator.ts:730)——四角色任一缺行或 profileId 为 null → `GraphEditRejectionError(422, "ROLE_BINDINGS_INCOMPLETE", 引导文案, {projectId, missingRoles})`;齐则放行 |
| 项目行 | ensureProject(find-or-create,不变) | 不变(422 前仍登记项目行,details.projectId 可直接用于绑定端点) |
| 快照冻结链 | role_bindings 读取 → 冻结四 revision → run_profile_snapshots | **零变化**(createTaskRunWithProfileSnapshot 未触碰) |
| profile 定义漂移门(七字段 409) | 随创建触发(ensureProfileRow 在创建路径) | 移至绑定端点(同一 ensureProfileRow 复用);**行为变化如实披露:创建不再比对漂移,见 §7 未验证项②** |
| profile 选择面 | 创建请求(被 A02 判为 ALLOWED 之门,实践证明被滥用为覆写通道) | 唯一:`PUT /api/v1/projects/:id/role-bindings`(server.ts:1488) |
| ExecutionTargetMismatch | 创建路径可逃逸为 500(M9-01 审查登记) | typed 422 EXECUTION_TARGET_MISMATCH(映射覆盖 setRoleBinding 与 createProfile 注册期 path-form 两个抛点) |
| 工作台表单 | profile 下拉 + 载入按钮 | 只读『本项目 Developer 角色』显示 + 三态引导(已绑定/未绑定→PUT 端点/项目未登记) |

新绑定端点契约(PUT /api/v1/projects/:id/role-bindings,全守卫管线:
token + Origin + CSRF):
- body 严格:`{bindings:[{roleId,profileId}×4]}`,恰四内建角色、
  `z.array(...).length(4)` + 角色唯一 refine(server.ts:380),违者 400
  INPUT_REJECTED;
- 拒绝次序(各带 typed code):无编排 503 → query 400 → shape 400 →
  未知项目 404 PROJECT_NOT_FOUND → profileId 不在已载入 profiles 422
  UNKNOWN_PROFILE(消息列全量已载入 id)→ 七字段漂移 409 →
  EXECUTION_TARGET_MISMATCH 422 → DB 级 unknown profile/revision 422;
- 写入 `withTransaction` 整体包裹(initialize + 四次 setRoleBinding):
  任一拒绝回滚,拒绝前后绑定表字节零变化(测试实证,§5);
- `canCreateSubtasks` 沿 v0.2.0 惯例(coordinator=true),不设为 HTTP
  输入;
- 成功 200 `{projectId, bindings:[{roleId, profileId, profileRevision}
  ×4]}`(ROLE_IDS 序,各钉绑定时最新 revision)。
- 读面:GET /api/v1/projects/role-bindings?projectDir=<绝对路径>(只读,
  仅 token 守卫):恰一 query 参 → 非绝对 400 → 无项目 404
  PROJECT_UNKNOWN → 200 `{projectId, executionTarget, bindings[4]}`
  (未绑定角色 profileId/revision 为 null;未初始化项目 bindings 为空
  数组=诚实态)。查找先 resolve 形态、后原始串两形态(产品恒以
  resolve 形态入库;e2e world 以 git 正斜杠 canon 形态播种,双形态只读
  查找兼容两者,零写入)。

## 4. 变更文件(13)

| 文件 | 变更 |
| --- | --- |
| packages/local-api/src/orchestrator.ts | schema 移除 profileId;requireCompleteRoleBindings 纯校验替代 ensureRoleBindings;新 setProjectRoleBindings(392-560,含事务与 typed 映射);头注 A02 立场改写 |
| packages/local-api/src/server.ts | RoleBindingsWriteBodySchema(380-401);两路由(633-668);serveProjectBindingsPut(1488)/serveProjectBindingsByDir(1567);serveRunCreate 文案与文档更新 |
| packages/local-api/src/page.ts | 表单下拉移除→developer-binding-view 只读显示(148 行);RUN_CREATE_FIELD_ALLOWLIST 改为 objective+projectDir 两元素(第 1382 行);developerBindingHtml(第 1450 行);createRunFailureText 422 分支;工作台 DOM 接线(change + 600ms 防抖 input 双触发) |
| packages/local-api/test/runs-orchestration.test.ts | ①-⑧ 重排:核心回归/端点格/占链 rebind 格等(§5) |
| packages/local-api/test/page.test.ts | 下拉断言→绑定显示断言;allowlist/payload/失败文案/三态渲染格更新 |
| packages/local-api/test/serve.test.ts | 两处创建体移除 profileId(503 格不受影响;400 格从 INPUT_REJECTED 风险恢复为 PROJECT_DIR_MISSING 原断言) |
| packages/local-api/package.json | 0.2.0 → 0.2.1 |
| packages/browser-e2e/src/browser.ts | 删 loadWorkbenchProfiles/ProfileOptionSnapshot;增 readDeveloperBinding(期望子串确定性等待);CreateRunInput 移除 profileId |
| packages/browser-e2e/test/flow-6-workbench.test.ts | 重写为迁移序列:422 探针(登记项目行)→守卫 PUT 四绑定→只读取读→表单 202→实时进度→READY_FOR_DELIVERY |
| CHANGELOG.md | Unreleased 增 Changed(破坏性+迁移说明)/Fixed 两节 |
| CHECKSUMS.sha256 | CHANGELOG 行 2a1f4e39→373f6a36、PROPOSALS 行 235273cb→(本批重算,见 §8);纯 LF |
| PROPOSALS.md | 追加『治理披露:M10-01 交付(2026-10-04)』节 |
| reports/M10-01-BATCH.md | 本文件(不入冻结面清单,历批同口径) |

## 5. 测试及退出码(全命令实跑;判别力自查含变异记录)

- local-api typecheck:`npx tsc -p tsconfig.json` → exit 0。
- local-api test:`npx vitest run` → 23 文件 **247/247 通过** exit 0
  (终态复跑;运行期 ~52s)。核心格:
  - ①核心回归:全新项目首 POST → 422 ROLE_BINDINGS_INCOMPLETE +
    **role_bindings 零行**(创建连 initialize 都不做);经端点配置差异
    化 claude/codex 四角色 → POST(无 profileId)→ **绑定全列逐字节
    不变(SELECT * 全列含 updated_at,创建后+驱动终态后双查)** +
    run_profile_snapshots 恰为项目绑定(developer→claude、其余→codex)
    → fake-cli SUCCEEDED 全链。
  - ③端点格:合法 mix 200+落库 / 未知 profileId 422 UNKNOWN_PROFILE /
    缺角色 400 / 重复角色 400 / ExecutionTarget 不匹配 422
    EXECUTION_TARGET_MISMATCH + **回滚后绑定逐字节不变** / 未知项目 404
    PROJECT_NOT_FOUND / 无 CSRF 403 / GET 405(Allow: PUT 头精确断言)/
    by-dir 读 200·未初始化零行·404·400·无令牌 403。
  - ⑦占链格增强:占链运行 RUNNING 中经端点 rebind → 占链运行冻结
    HANG 快照、排队任务冻结 SUCCESS(创建 202 <10s 不变)——A34 从
    API 侧实证。
  - #62 model-only 回归(改经端点播种绑定):三段期望(不撞 409/不铸
    新 revision/重启仍 rev1)全保持。
- **判别力自查(变异思维,ask 红线 6)——两发变异均先红后还原**:
  1. 在 `createRunChecked` 临时恢复 v0.2.0 副作用(initialize + 四角色
     setRoleBinding)→ `npx vitest run test/runs-orchestration.test.ts
     -t "core regression"` → **红**:`expected 500 to be 422`(变异后
     创建不再产生诚实 422 拒绝)→ 还原。
  2. 临时删除 RoleBindingsWriteBodySchema 的 `.length(4)` 与唯一性
     refine → `npx vitest run test/runs-orchestration.test.ts -t
     "configures bindings ONLY"` → **红**:`expected 200 to be 400`
     (缺角色体被放行)→ 还原。
  - 另:临时探针测试(绑定端点 500→422 诊断)实证修复前后状态后删除。
- page.test(同 local-api vitest 运行):下拉元素缺席断言
  (`not.toContain('id="profile-select"')`)、allowlist/三态渲染转义格。
- browser-e2e:`npx tsc -p tsconfig.json` exit 0;`npx vitest run` →
  10 文件 **21/21 通过** exit 0(flow-6 全链:422 探针 → PUT 200 →
  只读取读含 profile-wb-claude → 202 → 列表/WS/终态徽标/敌意 objective
  惰性/高级页签完好)。
- 根门禁:`pnpm typecheck` → turbo 59/59 exit 0;`pnpm test` → 70/70
  exit 0;`pnpm build` → 35/35(初跑全缓存命中,存疑)→
  `npx turbo build --force` → **35/35 真实执行 0 缓存** exit 0(以
  force 为准;dist/page.js 含 developer-binding-view 实查)。
- 规划包门禁:`node planning-check.mjs` → exit 0(part a 校验和逐文件 +
  part b 干净副本 self-test;CHANGELOG/PROPOSALS 行重算后复跑仍 0)。
  过程中自伤一次如实登记:报告 §4 表格内 `](1382)` 形态被 check_links
  判为断链本地链接(首跑 exit 1 `Broken local link: reports\
  M10-01-BATCH.md: 1382`),改为「第 1382 行」措辞后复跑通过——最终
  状态才计数(沿 a56e7ac 批内自伤登记先例)。

## 6. 破坏性变更迁移说明(0.2.0 → 0.2.1)

`POST /api/v1/runs` 移除 `profileId`。仍在发送该字段的客户端收到
`400 INPUT_REJECTED`(绝不静默忽略)。迁移三步(CHANGELOG Changed 节同
文;工作台 flow-6 e2e 即此序列的活体):

1. 用任务目录做一次创建尝试(任意 POST /api/v1/runs):项目行自动登记;
   未绑定时响应为 `422 ROLE_BINDINGS_INCOMPLETE`,body 顶层携带
   `projectId` 与 `missingRoles`;
2. `PUT /api/v1/projects/:id/role-bindings`,body
   `{bindings:[{roleId,profileId}×4]}`(恰四内建角色、无重复;profileId
   须为本进程已载入 profiles,否则 422 UNKNOWN_PROFILE;执行目标不匹配
   422 EXECUTION_TARGET_MISMATCH;整体事务,任一拒绝不落半套);
3. 之后创建任务即按项目绑定的 developer profile 执行(冻结快照,创建
   不再携带、也不改写任何 profile 选择)。

配套:工作台表单 profile 下拉移除,显示『本项目 Developer 角色』只读
(经 GET /api/v1/projects/role-bindings?projectDir=… 读取);旧客户端
回退兼容:422/400 均为 typed 错误码 + 可操作消息。

## 7. 未验证项(如实移交)

1. **未 commit 前置说明**:本批 11 代码/文档文件在报告与披露写入前已
   按显式路径 git add(ask 任务 1 未含提交指令);本任务(任务 3)按
   ask 完成提交,candidateSha 见 §8。
2. **行为变化如实登记(a)**:七字段漂移门(409
   PROFILE_DEFINITION_CONFLICT)v0.2.0 随任务创建触发;移除 profileId
   后创建不再比对,该门原样保留在绑定端点(ensureProfileRow 复用)。
   已入 CHANGELOG Fixed 段;#62 回归格在新语义下全绿。
3. **行为变化如实登记(b)**:对已绑定且本进程未载入其定义的 profile,
   创建照常冻结执行(DB 行为准)——与 M9-03『运行中进程不热重载』文档
   语义一致,但与 v0.2.0『创建即比对』不同。
4. 根 package.json 版本未动(0.2.0):ask 明示仅 local-api 0.2.0→0.2.1;
   根版本抬升留发布批(维护者决定)。
5. 既有测试移除/替换登记:runs-orchestration 旧格『unknown profileId →
   400 UNKNOWN_PROFILE』删除(创建路径不可达),以『removed field
   profileId → 400 INPUT_REJECTED』格替代;page.test profileOptionsHtml
   两格删除,以 developerBindingHtml 三态格替代;旧 cell①-⑦ 重排为
   ①-⑧。
6. 潜在既有缺陷观察(超范围未修):page.ts `fetchJson` 不挂 error.status,
   wireConfigDom 的 `error.status === 409` 缺席面板分支恒不可达(配置页
   409 时走通用失败文案)——建议后续批收口。
7. 浏览器层未实证细节:绑定只读显示的『未绑定(未初始化)』态由服务端
   测试覆盖(by-dir 零行/404),flow-6 实证已绑定态与 404 渲染路径;
   真窗人工冒烟(输入目录看显示变化)未做。
8. pnpm build 首跑 35/35 全缓存命中(输入已变却命中,原因未深究),
   已以 `npx turbo build --force` 35/35 真实执行为准。
9. 未跑:cargo 全套(零 Rust 改动)、NSIS/壳构建链、真实 CLI 冒烟、
   serve-bundle 重建(ask 未列;dist 已由 turbo build 刷新)。
10. 临时探针(orchestrator/server 变异、两处临时测试文件、browser-e2e
    probe 及其 evidence 目录)均已删除还原;evidence 目录为 gitignore 面。

## 8. 提交与校验和

- git add 显式路径 13 文件零 -A;无 push 无 tag 无远端改动。
- CHECKSUMS.sha256 同步:CHANGELOG 2a1f4e39→373f6a36;PROPOSALS
  235273cb→(提交前按盘上纯 LF 字节重算,值见 CHECKSUMS 行)。两文件均
  LF(CRLF=0 实查)。
- candidateSha:见本次提交(git log 首行;PROPOSALS 披露节以 git log 为
  准,不在文内写死哈希——沿 M9-03 #60 教训不造悬空指针)。
