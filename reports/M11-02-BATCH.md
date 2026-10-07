# M11-02 批报告:首启零配置(CLI 自动发现 + setup 端点 + 首启向导 + M11-01 移交族收口)

批次日期:2026-10-08(本文件不入冻结面,历批同口径)

## 1. Summary

v0.4.0 第二批(M11-02)交付两个开发提交加一个终化提交:

- **任务 1 首启零配置服务面(commit a21fc58,11 文件)**:只读 CLI 自动发现
  模块(纯函数+注入文件探针+零进程执行金丝雀)+ GET /api/v1/setup/status
  (zod 钉死输出 shape)+ POST /api/v1/setup/first-run(默认 profiles 经既有
  原子原语落盘;幂等=拒绝)+ serve 侧首启态桥(--profiles 声明但不存在=
  零 profile 启动)+ API_AND_EVENTS.md 双端点登记+GET /api/v1/projects 行
  (移交族 C)。
- **任务 2 首启向导 UI + M11-01 审查移交族收口(commit 2c70e7b,19 文件)**:
  desktop-ui 新路由 /app/setup + 首页探测引导卡(七态纯组件)+ 旧工作台
  链接 basename 缺陷修复(A)+ defaultAppUiAsset 单一 fileURLToPath 惰性
  定位器(B)+ /app 302 分支 SECURITY_HEADERS(H)+ runErrors 词汇补全与
  死映射删除、两处注释与实际对齐(I/J/G)+ /app smoke 缺产物改硬失败
  (F/R,决策见 §6)+ sync-shell-sidecar serve-bundle 陈旧度守卫(K)+
  ADR 010 四处勘误(D/E/O/P)。
- **任务 4 批交付终化(本提交,5 文件)**:本批报告+PROPOSALS 治理披露+
  BACKLOG 完成态+backlog.json deliveryNotes+CHECKSUMS 终同步。

提交链如实(以 git log 为准):a21fc58(任务 1)→2c70e7b(任务 2)→本提交
(任务 4)。本工作流的 ask 序列为任务 1/2/4,无独立「任务 3」提交;任务 1
提交信息中「移交族其余三条归本批任务 3」的指向实际由任务 2 的 ask 承接
落地(任务 2 ask 明确载明移交族 A..Q 逐项)——V031-02/M11-01 先例口径:
ask 编号与提交编号不一一对应时以 git log 与本节为准,不虚构造数。

红线遵守:orchestration 语义零变化(既有端点/守卫/审批/调度/事件协议零
改动;任务 1 的 serve 首启态桥是编排配置的加载语义补充,run 创建/绑定/
审批链零触碰,§4 如实披露);CLI 探测零 shell 拼接、零进程执行被探测路径、
零自动提权(结构金丝雀测试钉死);新增依赖零(全部复用既有 import 面);
git add 显式路径;无 push 无 tag。

范围如实:M11-02 登记范围四项(CLI 自动检测/默认 Profiles/默认四角色
绑定/首启向导+空引导路径)中,**默认四角色绑定未在本批交付**——任务 1/2
ask 未含绑定写面,且绑定写存在真实的先后依赖(项目行由首次 POST /runs
创建,向导阶段项目尚不存在),与项目登记(M11-03 范围)一并处置更诚实;
status 端点按 ask 回「默认绑定模板建议」,既有事务式绑定写
PUT /api/v1/projects/:id/role-bindings 语义零改动。该缺口连同壳侧
--profiles 接线调整(见 §9/§10)如实交接 M11-03。

## 2. CLI 发现覆盖面(探测位置矩阵)

模块 packages/local-api/src/cli-discovery.ts;候选构造纯函数
cliDiscoveryProbes 全序列可断言;文件探测 isFile 注入(生产=
statSync 常规文件判定,目录不算已安装);路径语义随【注入平台】而非宿主。

| 优先级 | 源 | win32 形态 | posix 形态 | 来源标签 |
| --- | --- | --- | --- | --- |
| 1 | PATH 环境变量逐目录(按 PATH 序;目录内按可 spawn 形态序 .exe→.cmd→.bat / posix 裸名) | `<dir>\claude.exe` `.claude.cmd` `.claude.bat` | `<dir>/claude` | `path` |
| 2 | 常见用户安装位置 | `%USERPROFILE%\.local\bin\<名>` | `$HOME/.local/bin/<名>` | `user-local-bin` |
| 3 | npm 全局前缀(仅环境变量 npm_config_prefix/NPM_CONFIG_PREFIX;不执行 npm、不解析 .npmrc) | `<prefix>\<名>`(win32 前缀即 bin) | `<prefix>/bin/<名>` | `npm-global-prefix` |

边界(全部测试钉死):空/相对 PATH 条目跳过(cwd 依赖探测=环境猜测);
非绝对 home/prefix 跳过(绝不伪造路径);环境变量缺失的源整体跳过;
目录同名不算已安装(常规文件判定);未发现=如实 `{found:false}` 不猜;
发现即存绝对路径——非 PATH 安装点 spawn 时不依赖 PATH;发现优先级=
PATH 序跨目录优先、目录内 .exe>.cmd>.bat、PATH 压 user-local、
user-local/npm 为兜底。红线:零 shell 拼接、零进程执行被探测路径、零
提权——结构金丝雀(cli-discovery.test.ts)断言模块零 child_process 导入、
零 spawn/exec 词形、仅 node:fs+node:path 两导入。

## 3. setup 端点契约

**GET /api/v1/setup/status**(只读;token 守卫,无 CSRF;查询串拒绝;
非读方法 405):响应经 SetupStatusViewSchema zod 钉死(漂移即 500,不出
漂移 shape)——`clis.claude|codex: {found, path, source}`(source=path|
user-local-bin|npm-global-prefix|null,found 与 path/source 非空互斥由
schema refine 钉死)+`profiles: {sourcePath, fileState: unwired|absent|
unparseable|configured, usableProfiles, parseError, loadedProfiles}`
(usableProfiles=当前文件解析可用数;loadedProfiles=本进程启动已载入数
——重启差值在数据里可见)+`defaultBindingTemplate: [{roleId, runtime} x4]
|null`(双无=null)。探测按请求时执行(运行中安装可被下次观测)。

**POST /api/v1/setup/first-run**(mutating;token+Origin+CSRF 全守卫;
body 严格恰 `{}`——任何键含 model/profileId 载体一律 400 INPUT_REJECTED,
空 strict schema 即 A02 载体防线,无独立 403 扫描,理由同 profiles 写回
信封注释)。拒绝顺序(每次拒绝零写入):无 --profiles 接线→409
PROFILE_SOURCE_ABSENT(不发明路径);已存在可用 profiles→409
PROFILES_ALREADY_CONFIGURED(原文件一字不动);两 CLI 均未发现→422
CLIS_NOT_FOUND(details.notFound 清单);无可用主目录→422
HOME_DIRECTORY_UNAVAILABLE;写路径自身 422/409 原样透传。成功 200:
`{schemaVersion, applied: true, mode: created|replaced, sourcePath,
profiles, restartRequired: true, note}`——经既有原子原语(校验先行+临时
文件+fsync+rename)落盘,生成内容复经冻结 ProfilesFileSchema 解析器验证;
不热重载,restartRequired+note 如实(向导 UI 据此提示,绝不假扮已生效)。

## 4. 默认组合映射与幂等语义

- **映射**:双 CLI 发现→2 个 profile(claude-default+codex-default),
  模板 coordinator/architect/reviewer→claude、developer→codex(M11 产品
  基准推荐组合);单 CLI→1 个 profile,四角色全落该 CLI(模板同步);
  双无→422 拒绝并列出未发现项,零写入。
- **默认值(均在冻结 schema 界内)**:maxConcurrency 4、timeoutSeconds
  1800(ask 建议的安全默认)、model null(CLI 默认)、extraArgs 恒空、
  executionTarget 按运行平台(win32/darwin/linux 映射;wsl 不产)、
  configDir=~/.claude|~/.codex(纯路径构造,永不读取)、credentialGroup
  claude-personal/codex-personal **按 CLI 各自隔离**(scheduler 侧 A33:
  credential-isolation 能力 unverified 期间每组并发上限 1 是设计,profile
  的 4 是验证解除后的操作者旋钮——批报告口径)。
- **幂等=拒绝(设计决策)**:已存在可用 profiles 时 409
  PROFILES_ALREADY_CONFIGURED,而非 `{applied:false}` no-op。理由:对齐
  七字段漂移门 refuse-don't-upsert 先例;双提交/双客户端竞态响亮失败;
  向导先查 status(status 亦回 fileState),拒绝体附 usableProfiles。
  例外:启动后损坏的文件(fileState=unparseable)不是可用配置,first-run
  经 replace 路径修复,mode:"replaced" 如实标注;启动态新声明文件走
  create 兄弟原语 createProfilesFileAtomic(拒绝已存在 409
  PROFILES_ALREADY_EXISTS,与 replace 兄弟拒绝态互补=幂等门竞态安全;
  rename 前 last-look 复核,残窗如实注释)。
- **serve 首启态桥(语义变更,如实披露)**:loadProfilesOrchestration 恰
  ENOENT 容忍——声明但尚不存在的 --profiles 文件=合法首启态:orchestration
  以零 profile 启动并记忆 profilesSourcePath(首启向导后续写目标),既有
  文件坏解析/不可读(非 ENOENT,如 EISDIR)仍拒启不变(测试钉住)。依据:
  壳现状「profiles.json 存在才传 --profiles」(apps/desktop-shell/README.md
  「profiles 接线(M9-03)」节)+冻结 schema profiles.min(1) 决不存在合法
  空文件——无此桥则 first-run 在任何生产可达状态下恒 409/已配置,干净机
  永不可能引导(M11-02 范围「profiles 为空引导路径」的必要 serve 侧补全);
  对 run 创建/绑定/审批链零影响(零 profile 时 POST /runs 走既有类型化
  拒绝)。**生产可达性缺口如实登记**:壳侧仍按「存在才传」接线,壳链路
  进入首启态需壳改为无条件传约定路径(或建空态引导)——归 M11-03 交接
  (§10),本批交付面为服务面+向导 UI。

## 5. 首启向导交互流

- **入口**:首页(NewTaskPage)挂载时恰一次探测 setup/status;/app/setup
  为独立向导路由(刻意不入侧栏——冻结四入口带不变,测试钉死恰 4)。
- **七态机(SetupGuideCard 纯组件,全态 renderToString 可测)**:
  checking(首页探测中不渲染,零闪烁;向导页显式示检)→ready(未配置:
  双 CLI=『检测到 Claude Code ✓ 与 Codex ✓』+推荐分工文案+生成按钮;
  单 CLI=如实注名未检到方+四角色全落该 CLI;双无=如实列出未发现项+旧
  配置页链接,**无生成按钮**;unwired=仅指引,服务端将 409)→working
  (按钮禁用)→done(『已生成 N 个默认 AI 配置——重启桌面应用后生效』+
  旧页调-config 指引)→restart-pending(configured 但 loadedProfiles=0,
  持续『重启后生效』提示,绝不假扮已生效)→all-set(已就绪,无引导)→
  error(人话拒绝句+未发现清单+手动指引)。探测被拒(纯浏览器 403)→
  零卡片零噪音(smoke 钉死 setup-guide-head 恰 0)。
- **人话纪律**:Claude Code/Codex 产品名;角色用人话(协调/架构/开发/
  评审);CLIS_NOT_FOUND 的 notFound 原始 id 在 humanizer 译为产品名;
  零内部 ID(profile id/sourcePath 等)进任何文案(测试断言)。旧工作台
  链接为原生 <a href="/">(basename 缺陷修复,§6A);内部导航用 Router
  Link。
- **refusal 人话族**:firstRunFailureText 覆盖 CLIS_NOT_FOUND(含清单)/
  HOME_DIRECTORY_UNAVAILABLE/PROFILE_SOURCE_ABSENT/
  PROFILES_ALREADY_CONFIGURED/认证族;全部测试钉死。

## 6. M11-01 审查移交族逐项处置对照

| 族 | 内容 | 处置 | 位置/证据 |
| --- | --- | --- | --- |
| A | 旧工作台 Link→原生 a(basename 缺陷)+href 精确断言 | 已收口 | SettingsPage.tsx/ProjectsPage.tsx 改 <a href="/">;shell.test.tsx 以 MemoryRouter basename="/app" 复现缺陷并钉死 href 恰 "/" 且无 href="/app"(ProjectsPage 空态链提升为导出 ProjectsEmptyGuide 供钉子渲染——SSR 不跑 effect,原位不可达) |
| B | defaultAppUiAsset 收敛单一 fileURLToPath 惰性助手 | 已收口 | server.ts 用 app-ui.ts 既有 loadAppUiAssetFromModuleLocation(死导出成唯一实现)+惰性化(模块导入零 fs 副作用);app-ui.test 三格:含空格+中文目录字面拼接(无 %20)/server.ts 源金丝雀/活体格(真实 dev 布局产物,缺失臂断言 null) |
| C | API_AND_EVENTS.md 补 GET /api/v1/projects 行 | 已收口(任务 1) | a21fc58 §1 表新增该行,本次 grep 复核在档 |
| D | ADR ws『自动认证』措辞条件化 | 已收口 | ADR 010 背景节改『满足该条件时直播流才会自动认证』+勘误注(冻结面,CHECKSUMS 重算 7046af49→1288ee46) |
| E | 缓解 2『无第二份拷贝』→『稳态恰一份』 | 已收口 | ADR 010 缓解 2 改『稳态恰一份持有——读入与改写请求头瞬间的转译性副本不构成第二份驻留(勘误 E)』 |
| F/R | /app smoke 缺产物 302 早退改硬失败(或加依赖边,二选一) | 已收口,决策=硬失败 | 理由:本套件其余文件全部硬依赖构建产物(helpers fake-cli not built 即 throw),turbo test dependsOn build 已保证门禁语境产物在位,早退=部分直跑静默丢失唯一 /app 覆盖——不另加依赖边(turbo 边已存在,直跑场景依赖边不可达);双臂实跑:产物在位 1 passed(2.7s)/移走 index.html→恰指名失败(已还原) |
| G | smoke『403 不进控制台』注释与实际一致 | 已收口 | smoke 头注改『页面代码自身零 console 输出;唯一条目=浏览器自身网络层 403 注解(恰为断言放行类)』;api.ts 头注同口径 |
| H | /app 302 分支补 SECURITY_HEADERS | 已收口 | server.ts 302 分支套全四头;app-route.test 逐头断言 |
| I | runErrors 补 PROJECT_DIR_NOT_DIRECTORY+核正词汇声称+PROJECT_NOT_FOUND 死映射 | 已收口 | 补 NOT_DIRECTORY 专句+409 漂移句;头注声称改精确版(恰覆盖路由能答的 refusal);死映射删除(创建路径 find-or-create 永不应 404,该码实存 role-bindings PUT 面 run-creation.ts:290),测试钉死旧专句不再现 |
| J | runStatus『title』注释与实际一致 | 已收口 | formatTimestamp 注释修正(Projects/History/RunDetail 三处均不渲染 title) |
| K | sync-shell-sidecar 增 serve-bundle 陈旧度守卫 | 已收口 | staged bundle mtimeMs 严格早于 dist/server.js→指名 exit 1(equal 放行;dist 标记缺失跳过);真实 stale 态恰 exit 1(2026-10-05 staged<2026-10-07 dist)、重产后 exit 0,build 再刷新 dist 后守卫又拦一次(三次实证),终态 re-bundle+re-stage 至新鲜 |
| O | ADR :56 括注改『守卫/令牌管线零改动(批内新增只读 /app 路由与 setup 端点)』 | 已收口 | ADR 010 决策段括注替换+勘误注 |
| P | 缓解 3 归属改 main.rs 的 read_to_string | 已收口 | ADR 010 缓解 3 改『main.rs 注入路径的一次 read_to_string』(apps/desktop-shell/src/main.rs:542 实证) |
| Q | 批报告措辞收敛类→本批披露节登记勘误 | 按口径登记 | 历史批报告不改写;本节及 PROPOSALS 披露节承载(任务 1 提交信息『移交族其余三条归任务 3』指向实际由任务 2 承接,已在 §1 如实注明) |

## 7. 变更文件清单(批累计,三提交)

任务 1(a21fc58,11 文件):CHECKSUMS.sha256、docs/API_AND_EVENTS.md、
packages/local-api/src/{cli-discovery.ts(新)、setup.ts(新)、
profiles-config.ts、serve.ts、server.ts、index.ts}、packages/local-api/
test/{cli-discovery.test.ts(新)、setup.test.ts(新)、serve.test.ts}。

任务 2(2c70e7b,19 文件):CHECKSUMS.sha256、docs/adr/010-token-auto-
session.md、scripts/sync-shell-sidecar.mjs、packages/browser-e2e/test/
app-shell-smoke.test.ts、packages/local-api/src/{app-ui.ts、server.ts}、
packages/local-api/test/{app-route.test.ts、app-ui.test.ts}、
apps/desktop-ui/src/{api.ts、main.tsx、runErrors.ts、runErrors.test.ts、
runStatus.ts、shell.test.tsx}、apps/desktop-ui/src/pages/{NewTaskPage.tsx、
ProjectsPage.tsx、SettingsPage.tsx、SetupPage.tsx(新)}、apps/desktop-ui/
src/components/SetupGuideCard.tsx(新)。

任务 4(本提交,5 文件):reports/M11-02-BATCH.md(新,不入冻结面)、
PROPOSALS.md、docs/BACKLOG.md、project/backlog.json、CHECKSUMS.sha256。

## 8. 测试及退出码(2026-10-08 本会话实跑,逐命令)

| 命令 | 结果 |
| --- | --- |
| `pnpm typecheck`(仓库根,任务 1 后与任务 2 后各一轮) | 62/62 successful;exit 0 |
| `pnpm build`(仓库根) | 37/37 successful;exit 0(desktop-ui dist 291,634B 含向导) |
| `pnpm exec vitest run`(packages/local-api,任务 1 时点) | 28 文件 321/321 passed;exit 0(原 285+cli-discovery 20+setup 15+serve 补格 1) |
| `pnpm exec vitest run`(packages/local-api,任务 2 时点) | 28 文件 325/325 passed;exit 0(+4:app-ui 空格路径/金丝雀/活体+302 逐头断言并入) |
| `pnpm exec vitest run`(apps/desktop-ui) | 3 文件 23/23 passed;exit 0(shell 11+runErrors 7+runStatus 5) |
| `pnpm --filter @role-orchestrator/desktop-ui run typecheck` | 无错误;exit 0 |
| `pnpm exec vitest run test/app-shell-smoke.test.ts`(browser-e2e) | 1/1 passed(2.7s,真实 Chromium);缺产物臂:移走 index.html 后恰以指名命令硬失败(已还原) |
| `node scripts/sync-shell-sidecar.mjs` | stale 态 exit 1(指名两端 mtime+再产命令);bundle:serve 重产后 exit 0(1733,041B+291,634B;sidecar 不入 git) |
| `node planning-check.mjs` | (a) 80/80 checksums match+(b) self-test exit 0;进程 exit 0(API_AND_EVENTS/ADR 010/三冻结文件历次重算后;任务 4 终态复跑见 §1 提交) |
| 30 文件 BOM/CR 检查(python 逐字节,任务 1+2 合计) | 全部 BOM=False CR=0(纯 LF 尾 LF) |

## 9. 未验证项

1. **真窗首启全流程(归维护者)**:壳启动→向导卡片→生成推荐配置→重启
   壳→配置生效→建出第一条任务——headless/纯浏览器不可达(认证=壳注入,
   ADR 010),且壳侧接线缺口(下条)使其在当前壳版本尚不可达。
2. **真实 CLI 存在性(归维护者机)**:探测矩阵全部经注入 isFile 的
   hermetic 测试验证;claude/codex 在真实机器上的安装形态(PATH 命中/
   user-local/npm 前缀)由维护者环境首次真窗核验。
3. **生产可达性缺口(如实登记,非未验证而是未交付)**:壳仍按「存在才
   传 --profiles」接线(desktop-shell README M9-03 节),生产壳链路进入
   首启态需壳改为无条件传约定路径——M11-03 交接;默认四角色绑定未在本
   批交付(§1 范围如实),与项目登记一并处置。
4. browser-e2e 其余 11 文件本批未跑(仅直跑被改动的 smoke,双臂实测);
   全仓 `pnpm test` 未在本批单独执行(各包套件均直跑绿)。
5. 10 轮审查属批次后续流程(完成标准内),本报告交付时未开始。
6. 安装态(NSIS→壳)链路未实跑,归 M11-05 安装态 E2E(历批口径)。

## 10. M11-03 交接

- **已就绪面**:setup/status+setup/first-run 两端点(守卫/幂等/人话族
  全测试);向导七态卡+首页探测卡+/app/setup 路由(测试 23/23);serve
  首启态(声明但不存在 --profiles=零 profile 启动);/app smoke 硬失败
  臂;sidecar 陈旧度守卫。
- **缺口(如实移交)**:①壳侧 --profiles 无条件接线(main.rs
  default_profiles_path 现为存在才传;改无条件传约定路径即打通生产首启
  态;壳测试与 README 同步);②默认四角色绑定写面:绑定写存在先后依赖
  (项目行由首次 POST /runs 创建),向导阶段项目尚不存在——需与 M11-03
  项目登记一起定设计(候选:首任务创建后引导绑定/按目录预登记,均须走
  既有事务式 PUT /api/v1/projects/:id/role-bindings,语义零新增);status
  的 defaultBindingTemplate 已就位可直接驱动 UI;③向导文案与交互打磨随
  维护者真窗反馈迭代。
- **测试面交接**:server 侧 setup.test.ts(注入 discovery 的端点矩阵)、
  cli-discovery.test.ts(纯函数矩阵+金丝雀)、desktop-ui shell.test.tsx
  (向导七态+basename 钉子)、browser-e2e smoke 硬失败臂——可直接复制为
  M11-03 新面向的测试基座。
- **约束提醒**:CLI 探测红线(零 shell/零进程执行/零提权)持续有效,
  扩展探测位置须保持金丝雀绿;向导文案零内部 ID;profiles/绑定写入继续
  遵守「不热重载、重启生效」「事务式全落或全不落」;git add 显式路径。
