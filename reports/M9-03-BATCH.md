# M9-03 批次报告:角色与模型配置页 + 壳侧接线收口(M9-03-BATCH)

日期:2026-10-03 · 执行角色:Developer · 性质:**M9 第三个功能批次交付,
非发布动作**——不打 tag、不发 Release、不动远端;发布动作按
`project/RELEASE_PROCESS.md` 由维护者决定。

## 1. Summary

配置文件面与壳侧接线在同一个批次收口。新增 `GET /api/v1/profiles/full`
(来源路径 + 当前文件全文 + 经既有解析器得出的解析结果)与
`PUT /api/v1/profiles/full`(body 为 `{content: <全文>}`,经**既有**冻结
ProfilesFileSchema 解析器严格校验,通过后以「临时文件 + fsync + rename」
原子写回来源路径;校验失败 422 带解析器可读原因、原文件一字不动);无
来源路径的进程对 GET/PUT 都以 409 PROFILE_SOURCE_ABSENT 诚实拒绝(不猜
路径、不隐式重建被删文件)。页面新增第三个页签『配置(profiles)』:查看
当前配置(sourcePath + 解析摘要:runtime 的 claude/codex 映射、
maxConcurrency×timeoutSeconds 预算)+ 编辑器全文写回(PUT,失败只写状态
文本、编辑器内容逐字保留,成功提示「不热重载、重启 serve 生效」);409
时渲染『壳未接线/未传 --profiles』引导。壳侧接线:`serve_child_argv`/
`spawn_serve` 增加 `profiles_path: Option<&str>`(Some 时 argv 追加
`--profiles <路径>`——传的是**配置文件路径**,非令牌),`main.rs` 按
M9-01 语义传默认 per-user 约定路径
`%LOCALAPPDATA%\role-orchestrator\profiles.json`(与默认库同目录;**存在
才传**,不存在或约定路径无法确定时不传旗标,serve 行为与 v0.1.1 完全
一致)。`bundle:serve` 增加指名前置检查(fail-loud):全部 workspace 依赖
的 dist 必须已构建,否则指名报错退出 1(M9-02 审查移交的构建顺序约束
机械化)。零新增外部 npm 依赖(格式纪律:配置文件按 M9-01 契约是严格
JSON,不引入 YAML 解析)。

## 2. 设计要点

### 2.1 格式纪律:PUT body 是配置文件全文(严格 JSON),不是 YAML

ask 原文写「body=yaml 文本」;勘察后按 M9-01 既有事实对齐(ask 自身亦
要求「约定路径与 serve.ts/M9-01 的读取路径一致——勘察后对齐」):

- M9-01 的 `--profiles <file.json>` 契约是**严格 JSON**(冻结
  ProfilesFileSchema);serve.ts 的 usage 行明示「YAML is not parsed
  because no yaml dependency may be added」,`config/profiles.example.yaml`
  是人工参考(转换来源)。
- 写回目标是 serve 下次启动要读的**同一个文件**——写 YAML 进去会让
  重启必然失败。文件格式由消费者(M9-01 serve)决定,即 JSON。
- 硬红线「写回校验必须复用既有解析器(不重写解析)」唯一指向既有
  `parseProfilesFile`(ProfilesFileSchema over JSON.parse)——仓库产品
  运行时不存在任何 YAML 解析器(runtime-profile 包零 `yaml` import;
  `yaml` 仅是 contracts 的 devDep 与 release-audit 的内部工具依赖,
  引入 local-api 即新增外部 npm 依赖,踩红线)。
- 结论:GET/PUT 的「全文」= 该 JSON 文件原文字节;PUT 校验复用
  `parseProfilesFile`,422 带其可读原因。本偏离在 PROPOSALS 披露同节
  显式登记。

### 2.2 原子写回(profiles-config.ts,临时文件+fsync+rename)

顺序即安全:

1. **先校验**(`parseProfilesFile`,既有解析器):拒绝内容在触碰文件系统
   之前就 422 返回,原文件必然未动;
2. **来源存在性**:源文件被外部删除(或目录消失)→ 409
   PROFILE_SOURCE_ABSENT——与 GET 对同一状态的视图一致(不 silent
   recreate 一个维护者可能故意删除的配置;serve 不隐式建文件/目录);
3. **临时文件**:同目录 `.<名>.m9-03-tmp-<pid36>-<6hex>`(rename 不得跨
   文件系统;`wx` 独占创建,随机后缀撞名即响亮失败);write+fsync 后
   rename 覆盖源文件(POSIX 原子;Windows 上 node rename 走
   MoveFileEx+MOVEFILE_REPLACE_EXISTING,同样替换现有文件);
4. 任一失败路径清理临时文件并传播(rename 前的失败原文件未动,rename
   即唯一原子提交点)。

测试逐格断言目录清单不变(无临时文件残留)与原文件字节不变。

### 2.3 来源路径贯穿与「无来源」语义

`OrchestrationOptions` 增 `profilesSourcePath?: string`;
`loadProfilesOrchestration`(serve --profiles 路径)把它置为该文件;
`Orchestrator.profilesSourcePath` 暴露给路由。进程内组合根(测试/嵌入
方)直接传 profile 定义、无文件 → 409 PROFILE_SOURCE_ABSENT——不发明
「db 目录下猜一个」的第二事实源。GET 对「启动后文件被外部改坏」仍返回
200 + rawText + parseError(profiles=null):坏文件也是可查看的配置,
编辑器能精确修复盘上字节,并可经 PUT 原子修复。

**写回不热重载**(诚实边界,响应 note 与 UI 双重声明):运行中进程继续
使用启动时载入的定义,重启 serve 生效;同 id 不同定义的文件在 run 创建
时撞 M9-01 漂移门(409 PROFILE_DEFINITION_CONFLICT)——漂移是显式的人的
决定,不是 upsert,本批不改变该语义。

### 2.4 壳侧接线(存在才传)

- `serve_child_argv(node, serve_bin, db, port, profiles_path: Option<&str>)`:
  None 时 argv 与 v0.1.1 逐字节一致(6 元素);Some 时恰追加
  `--profiles`+路径两元素(8 元素)。凭据不变式单测在两种形态下都跑
  (路径是配置文件路径,无任何令牌词汇)。
- `main.rs::default_profiles_path`:`%LOCALAPPDATA%\role-orchestrator\
  profiles.json`,与默认库同目录;与 db 共用同一条 LOCALAPPDATA
  fail-closed 出口(未设置/空串/非绝对路径,抽为
  `local_app_data_base`,错误文案逐字不变)。
- **对齐勘察**(README 同步披露):serve 侧没有内置默认读取路径——只读
  `--profiles` 显式传入的路径。「约定路径与 serve 的读取路径一致」的
  落地 = 壳把该约定路径作为 `--profiles` 的值传入,单一事实源即约定。
  文件不存在(或 LOCALAPPDATA 不可用且用了显式 --db)时不传旗标,serve
  行为与 v0.1.1 完全一致;页面配置页以 409 引导接线,壳侧不猜路径。
- `spawn_serve` 新参经**真实 spawn 回显格**覆盖:含空格与 Windows 元字符
  的 profiles 路径逐元素无损到达子进程 argv。

### 2.5 配置页(三页签)与 bundle 前置检查

- 页签结构:工作台(默认)/配置/高级;`showPageTab` 三态互斥,高级页签
  全部观测面元素 id 零改动(既有 e2e 选择器不受影响,browser-e2e 9 文件
  20/20 全回归佐证)。写回 payload 走显式单字段 allowlist
  (`PROFILES_WRITE_FIELD_ALLOWLIST=["content"]`,A02 UI 层同纪律);
  敌意 sourcePath/rawText/profile id 全部经 esc,textarea 内容先转义
  再入 `</textarea>`(vm 测试断言零活 script/img、无 textarea 逃逸)。
  **失败不覆盖编辑器**:保存失败只写状态 span 的 textContent,面板
  innerHTML 不重渲染(结构保证)。
- `bundle:serve` 前置检查(M9-02 审查移交机械化):遍历 local-api 的
  `workspace:*` 依赖,经本包 node_modules 链接逐个校验其 manifest main
  (即 dist 产物)存在,缺失则指名报错「run pnpm build at the REPO ROOT
  first」并退出 1。正路径实跑(当前树 exit 0,产出 1,589,775 字节
  bundle)+ 负路径实证(临时挪走 engine/dist → exit 1 指名
  @role-orchestrator/engine → 还原复跑 exit 0)。构建顺序同步写入
  apps/desktop-shell/README.md 两处(纯新克隆前置 + 打包分发构建顺序)。

## 3. 变更文件(git status 实录)

新增:
- `packages/local-api/src/profiles-config.ts` — 读/原子写回载体
  (readProfilesFull / writeProfilesFullAtomic);
- `packages/local-api/test/profiles-full.test.ts` — 端点端到端 7 格 +
  loadProfilesOrchestration 源路径 1 格(共 8);
- `reports/M9-03-BATCH.md` — 本报告(不入冻结面清单,M9-01/02 同口径)。

修改:
- `packages/local-api/src/orchestrator.ts` —
  OrchestrationOptions.profilesSourcePath + Orchestrator.profilesSourcePath;
- `packages/local-api/src/serve.ts` — loadProfilesOrchestration 置来源
  路径;
- `packages/local-api/src/server.ts` — GET/PUT /api/v1/profiles/full 路由
  与两 handler、严格 body schema、模块文档;
- `packages/local-api/src/errors.ts` — GraphEditRejectionError.statusCode
  并入 422(域类型化拒绝载体扩展,PROFILES_CONTENT_INVALID);
- `packages/local-api/src/page.ts` — 三页签 + 配置页(视图/编辑器/写回/
  409 引导纯函数 + wireConfigDom)+ putJson/requestJson + CSS + 模块文档;
- `packages/local-api/src/index.ts` — 导出 profiles-config + 文档;
- `packages/local-api/test/page.test.ts` — M9-03 配置页 6 格(骨架/引导/
  转义与 textarea 逃逸/解析错误态/allowlist/失败文案);
- `packages/local-api/scripts/bundle-serve.mjs` — workspace dist 前置检查
  (fail-loud);
- `apps/desktop-shell/src/serve_child.rs` — serve_child_argv/spawn_serve
  增 profiles_path + 3 个新测试格(含真实 spawn 元字符回显);
- `apps/desktop-shell/src/main.rs` — local_app_data_base 抽取、
  default_profiles_path、run() 接线(存在才传)+ 1 个新测试格;
- `apps/desktop-shell/tests/integration.rs` — spawn 调用补 None 参数;
- `apps/desktop-shell/README.md` — spawn 形态 + profiles 接线节 + 构建顺序
  (全 workspace 先行,bundle 前置检查)两处;
- `reports/M9-02-BATCH.md` — §7『401/403 守卫』勘误为『403
  (TOKEN_REQUIRED/CSRF)』(ask 预授权直改,注明勘误);
- `CHANGELOG.md` — Unreleased/Added 条目(冻结面,LF 重算同步);
- `CHECKSUMS.sha256` — CHANGELOG/PROPOSALS 行同步(纯 LF 重算);
- `PROPOSALS.md` — 治理披露节(归属变更 + 措辞现状 + 格式偏离登记)。

## 4. 实际执行的测试及退出码(2026-10-03 本会话实跑)

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `pnpm --filter @role-orchestrator/local-api run typecheck` | 0 | 通过 |
| `pnpm --filter @role-orchestrator/local-api run test` | 0 | 22 文件 241/241(批前 21 文件 227,恰增 14:profiles-full.test.ts 8 格(端点 7 + loadProfilesOrchestration 源路径 1)、page.test.ts +6 配置页格) |
| `pnpm --filter @role-orchestrator/local-api run build` | 0 | dist 构建成功 |
| `pnpm --filter @role-orchestrator/local-api run bundle:serve` | 0 | 前置检查正路径通过,bundle 1,589,775 字节(含 M9-03 面);负路径(挪走 engine/dist)exit 1 指名报错后还原复跑 exit 0 |
| `cargo test`(apps/desktop-shell) | 0 | lib 28 + bin 18 + source_invariants 3 全绿(integration 1 格按设计 ignored);新增 argv 接线 2 格 + default_profiles_path 1 格 |
| `node packages/release-audit/dist/cli.js secrets .` | 0 | verdict known-reservations-only;排除 .zcode 复测(scanSecrets excludeDirNames+.zcode):1684 文件,findings 35=31 test-sentinel+4 known-fake-sentinel,**needs-judgment=0** |
| `pnpm --filter @role-orchestrator/browser-e2e run typecheck` | 0 | 通过(本批触及 page.ts 的回归面) |
| `pnpm --filter @role-orchestrator/browser-e2e run test` | 0 | 9 文件 20/20(flow-1..6+a38+a39+evidence-rotation 全回归;三页签改构对既有选择器零破坏) |
| `node planning-check.mjs` | 0 | (a) CHECKSUMS 逐文件 +(b) 干净副本 self-test(本批触及冻结面 CHANGELOG/PROPOSALS/CHECKSUMS 故加跑) |

新增测试内容(全 hermetic,零真实 CLI 调用;profiles-full 端点不驱动
任何 run,纯文件面):

- **profiles-full.test.ts(8 格)**:①GET 200 = sourcePath+逐字节
  rawText+解析结果(含 executable 等全字段——rawText 已全文出站,解析
  视图与之同步,精简下拉端点 GET /api/v1/profiles 形态不变);②无编排
  进程 GET/PUT 409 PROFILE_SOURCE_ABSENT;③守卫:无 token 403 TOKEN_
  REQUIRED/无 CSRF 403/查询参数 400/POST·DELETE 405(Allow: GET, HEAD,
  PUT);④PUT 往返:200+盘上字节==提交字节+bytesWritten+目录清单不变
  (无临时文件残留)+note 含 restart;⑤422 四形态(坏 JSON/profile 内
  未知字段/顶层形状错/空 profiles)逐一断言原文件字节不变;⑥400 六形态
  (非 JSON/空体/缺 content/多字段/非字符串/空串+查询参数);⑦盘上文件
  被改坏 → 200+parseError(可修复视图)→ 经 PUT 修复成功 → 文件被删
  → GET/PUT 均 409。
- **page.test.ts(6 格)**:三页签骨架(tab-config 默认隐藏)+app.js 含
  showPageTab/putJson;409 引导(壳未接线/未传 --profiles、per-user 约定
  路径、存在才传);配置视图敌意输入零活 script/img、无 textarea 逃逸;
  解析错误态 role=alert + 原文保留;写回 payload 单字段 allowlist 拒
  model 载体与空内容;typed 422/409/403 文案(「原文件未改动」「编辑器
  内容保留」)。
- **serve_child.rs(+2)**:argv 接线两形态(None=6 元素逐字节同
  v0.1.1/Some=8 元素含 --profiles+路径)+ 凭据不变式双形态跑 + 含元字符
  profiles 路径经真实 spawn 回显逐元素无损。
- **main.rs(+1)**:default_profiles_path 与默认库同目录、file_name=
  profiles.json、与 db 共用 LOCALAPPDATA fail-closed 出口。

## 4.1 安装包重建与本机端到端实录(2026-10-03 同日补充批,全部命令本会话实跑)

**构建链(README「打包分发」五步,exit 0 逐格)**:

| 步骤 | 命令 | 退出码 | 结果 |
| --- | --- | --- | --- |
| 1 | `pnpm build`(仓库根,全 workspace turbo) | 0 | 35/35 tasks(全缓存命中) |
| 2 | `pnpm --filter @role-orchestrator/local-api run bundle:serve` | 0 | 前置检查(本批新增)通过;bundle 1,589,775 字节 |
| 3 | `node scripts/fetch-node-runtime.mjs` | 0 | node.exe 已在且 sha256 匹配钉值 98843732…,幂等跳过零网络 |
| 4 | `node scripts/sync-shell-sidecar.mjs` | 0 | sidecar/serve-bundle.mjs 1,589,775 字节入树(与 dist 逐字节相等,脚本断言) |
| 5 | `cd apps/desktop-shell && cargo tauri build` | 0 | release 38.38s;`Info Target: x64`;NSIS `role-orchestrator-shell_0.1.0_x64-setup.exe` **26,025,935 字节(24.82 MiB),sha256 8bd2eb396197ff519c178e8dc10746b4d243092c2e7626bf82ac07b8f7ddd990**;VersionInfo 仍 0.1.0(壳版本未抬升,如实记录) |

**本机验证(按 v0.1.1 先例口径)**:

- **静默卸载旧壳**:`uninstall.exe /S` → exit 0;安装目录
  `%LOCALAPPDATA%\role-orchestrator-shell\` 移除、HKCU Uninstall 键移除;
  数据目录 `%LOCALAPPDATA%\role-orchestrator\`(orchestrator.db 4096 +
  wal/shm)原样保留(卸载前快照核对)。
- **约定路径配置**:按 ask(『若约定路径无配置文件,先创建一份最小合法
  profiles』)在 `%LOCALAPPDATA%\role-orchestrator\profiles.json` 创建
  475 字节严格 ProfilesFileSchema JSON(id=fake-claude-e2e,runtime=claude,
  timeoutSeconds=120,maxConcurrency=1)。**格式仍为严格 JSON 而非 ask
  字面的 yaml**——理由见 §2.1(M9-01 契约 + 既有解析器红线),与前批
  披露一致。executable 指向临时目录的一个 **wrapper 脚本**(先向
  process.argv 前插 `--scenario success` 再 import 仓库
  fake-cli dist/bin/fake-claude.js):frozen 文件 schema 无 invocationArgs
  通道(仅进程内组合根可用),fake-cli 的 `--scenario` 为必填,wrapper
  是文件驱动 e2e 唯一诚实通道(测试脚手架,不入仓库)。
- **静默安装**:`setup.exe /S` → exit 0;安装目录四载荷在位
  (exe/serve-bundle.mjs/node-runtime\node.exe/uninstall.exe);安装的
  serve-bundle.mjs 1,589,775 字节=新 bundle(含
  PROFILES_CONTENT_INVALID/profilesSourcePath 标记);node.exe sha256=钉值;
  HKCU 键恢复。**观察(如实)**:静默安装完成时 NSIS 自动拉起一次壳
  (装完即运行的安装器行为),该实例与其serve 同样正确携带
  `--profiles`(命令行实证);为避免与本批受控验证双实例并存,验证前以
  `taskkill /T /F` 结束该树(含 WebView 子进程,树杀干净)。
- **无环境变量启动**:显式核空 `RO_SHELL_NODE`/`RO_SHELL_SERVE_BIN` 后
  启动安装壳。

**端到端断言(全部 PASS)**:

- **① 壳+serve-bundle 链**:shell pid 44096 → direct child serve pid
  95308(Win32_Process ParentProcessId 断言),serve 命令行逐字=
  `…\node-runtime\node.exe …\serve-bundle.mjs --db …\orchestrator.db
  --port 0 --profiles …\role-orchestrator\profiles.json`——argv 数组、
  无 shell、无任何令牌参数,`--profiles` 传的是约定路径(配置文件路径)。
- **② GET /api/v1/profiles/full**:无 token 403 TOKEN_REQUIRED、错 token
  403 TOKEN_INVALID(守卫先于路由);带 token 200,`sourcePath`=
  `C:\Users\star\AppData\Local\role-orchestrator\profiles.json`(壳传入的
  约定路径),`rawText` 与盘上 475 字节逐字节相等,`parseError: null`,
  解析 ids=[fake-claude-e2e];查询参数 400。写回面同机实证:PUT 无
  CSRF → 403 CSRF_REQUIRED;带 CSRF → 200(bytesWritten 475,盘上字节
  不变);PUT 非法内容 → 422 PROFILES_CONTENT_INVALID 且盘上字节仍不变
  (原子写回+守卫+既有解析器在生产安装形态下全部生效)。
- **③ 工作台 API 完整建任务(fake-cli 路径)**:GET /api/v1/session 取
  CSRF → POST /api/v1/runs(objective=『M9-03 安装包端到端验证(fake-cli):
  202→执行→结果可查』,profileId=fake-claude-e2e,projectDir=临时 git
  仓库)→ **202** `{runId: run-muse4pch-11b8ced2, status: "queued",
  statusEndpoint}` → 轮询 statusEndpoint:run **READY_FOR_DELIVERY**,
  执行 exec-d3511657… **SUCCEEDED**(attempt 1,pid 85876)→
  GET /api/v1/executions/:id/events 200 共 10 事件(started/
  message_delta/tool_started/tool_completed/artifact_reported/
  result_reported/usage_reported/process_exited)→ GET /api/v1/runs 列表
  含该行(objective 正确回显)。**M9 工作台端到端贯通证明完成:壳→serve
  --profiles→守卫→建任务→引擎调度→worktree 隔离→fake-cli 执行→事件
  落库→REST 可查,全链在生产安装形态下闭环。**
- **④ 页面渲染**:GET / 200,HTML 含三页签(tab-workbench/tab-config/
  tab-advanced)+工作台三区块(workbench-create/workbench-list/
  workbench-detail)+配置页元素(load-profiles-full-button/
  profiles-full-panel)。

**收尾与残留(如实)**:验证后 `taskkill /T /F` 结束受控壳树
( survivors=0,serve/node 无孤儿);**测试 profiles.json 已从约定路径
移除**——壳下次启动回到无编排态(v0.1.1 行为),维护者把真实
claude/codex profiles(严格 JSON,可由 config/profiles.example.yaml 转换)
放到约定路径即接线;临时 fixtures(ro-m903-e2e wrapper/git 仓库)已删除。
数据目录残留=本次 e2e 的持久产品证据,如实保留:orchestrator.db(WAL
至 1,215,432 字节)+ worktrees\run-muse4pch-11b8ced2\execute\1\(该 run
的 worktree 隔离证据)——不删库不改证(v0.1.1 探针行同口径)。

本节为同日补充批:触及冻结面 PROPOSALS(『治理披露:M9-03 交付』节追加
安装包/端到端实录小节)与 CHECKSUMS(PROPOSALS 行按盘上纯 LF 字节重算),
`node planning-check.mjs` 复跑 exit 0((a) CHECKSUMS 逐文件 +(b) 干净副本
self-test);提交与 candidateSha 见 PROPOSALS 同节。

## 5. 归属变更记录(审查移交,显式)

**壳侧接线(--profiles 传入 serve 子进程)的归属由 M9-01 批次披露的
「M9-02」调整为「M9-03」,本批完成。** 原因:工作台 UI(M9-02,纯页面
层,不触 bundle/spawn)与壳 bundle/spawn 接线是不同工序;接线依赖
`--profiles` 语义(M9-01 交付)先行,且需要 M9-03 的配置文件面
(GET/PUT /profiles/full)才有端到端意义。M9-01 报告 §6.4/§8 与 M9-02
报告 §5.1 的历史表述按「历史批次报告不改」纪律保留原文,以本节与本批
PROPOSALS 披露为准。

## 6. 措辞修正(审查移交)

- M9-02-BATCH §7『401/403 守卫』勘误为『403(TOKEN_REQUIRED/CSRF)』
  (守卫管道不用 401;ask 预授权直改,已在原位注明勘误)。
- M9-02 交付时『壳内工作台当前诚实 503』的现状表述,按本批落地后的
  事实更正为:**壳内页面暂为 v0.1.1 旧观测台(旧 bundle 未含新页面与
  --profiles);重打包后若未接 --profiles 才会看到工作台 503
  ORCHESTRATION_NOT_CONFIGURED / 配置页 409 PROFILE_SOURCE_ABSENT(均为
  诚实拒绝并带接线引导)**。历史批次报告不改,本节与本批 PROPOSALS
  披露按现状表述。

## 7. 未验证项(如实登记)

1. **真窗(GUI)交互未验证**:本机端到端(§4.1)以 API 级断言 + 进程/
   文件证据完成;真实桌面窗口内的交互(配置页签点击、编辑器输入、焦点
   切换、高 DPI 下的表格布局、输入法)未验证,归维护者(v0.1.1 先例)。
   **干净机(纯新克隆/未装开发工具链的机器)卸载-安装-冒烟未跑**——本机
   验证带有开发环境(pnpm/node/git 均在);安装包自身载荷自足(§4.1
   实证),但干净机行为归维护者清单。
2. `RO_SHELL_*` 环境变量覆盖语义不变(node/serve 入口);profiles 无
   覆盖变量(约定路径即单一事实源,如需覆盖变量属新提案)。
3. 真实 CLI(claude/codex)下的配置页写回→重启→建任务全流程未冒烟
   (M9-01 §5 上游 503 语境延续;本批端到端走 fake-cli,hermetic 纪律
   不变)。
4. browser-e2e 未新增『配置页签』专用浏览器格(本批配置页 UI 验证为
   vm 级 DOM 断言;既有 9 文件 20/20 全回归证明三页签改构零破坏)。
5. 原子写的 Windows 断电/崩溃窗口(fsync 后 rename 前掉电)未做掉电
   注入测试——rename 单提交点语义由 OS 保证,临时文件残留时可手动删除
   (`.<名>.m9-03-tmp-*` 命名约定)。
6. PUT 的 1 MiB HTTP body 上限内 envelope `content` 上限 1,000,000 字符;
   超过即 413/400——64 profile × 每条 2048 字符的理论上限文件
   (~1.3 MB)无法经端点写入(手改文件 + 重启仍可用)。如实登记,
   现实配置文件为 KB 量级。

## 8. 风险

- **写回与运行态的窗口一致性**:写回成功后、重启前,GET /api/v1/profiles
  (下拉)与 POST /api/v1/runs 仍按启动定义应答——UI 已声明;运行中
  改定义 + 立即建任务可能撞 409 漂移门(M9-01 语义,非本批引入)。
- **配置文件面出站范围**:GET /full 返回全文(含 executable/configDir/
  credentialGroup)——该面本来就是配置文件本体,经完整守卫管道
  (Bearer+Origin+CSRF)且仅回环;与精简下拉端点的「不出进程」边界并存
  (后者形态未动)。
- **壳 profiles 接线的存在才传**:操作者删掉 profiles.json 后重启壳 =
  静默回到无编排态(v0.1.1 行为),页面 409/503 引导可见;壳不为此
  额外弹窗(与「存在才传」的简单语义一并披露)。

## 9. M9-04 交接说明

- 配置面契约:GET 200 `{schemaVersion, sourcePath, rawText, parseError,
  profiles}` / GET·PUT 无来源 409 PROFILE_SOURCE_ABSENT / PUT 400
  INPUT_REJECTED(envelope)/ 422 PROFILES_CONTENT_INVALID(原文件不动)/
  200 `{schemaVersion, sourcePath, bytesWritten, profiles, note}`(note
  声明重启生效);非 GET/PUT 405(Allow: GET, HEAD, PUT)。
- 壳侧约定路径:`%LOCALAPPDATA%\role-orchestrator\profiles.json`
  (apps/desktop-shell/README.md「运行」节);存在才传。
- 被拒审批死端/失败 run 状态语义/串行泵单用户取向沿用 M9-01 §7 登记;
  取消/重排入口仍留后续里程碑。
