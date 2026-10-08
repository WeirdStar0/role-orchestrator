# M11-05 批报告:设置+开发者模式收纳+版本抬升 v0.4.0+新安装包与安装态开箱复验+措辞/精度族收口

批次日期:2026-10-08(本文件不入冻结面,历批同口径)

## 1. Summary

v0.4.0 收官批(M11-05)由四个 ask 组成(任务 4 编号空缺属编排序列,M11-02
先例口径),单一提交承载全部 25 文件(提交形态如实:任务 1/2/3 成果留工作
树、任务 5 一次性提交——M11-03/M11-04 先例,ask 编号与提交不一一对应,
以本候选 SHA 与本节为准):

- **任务 1(设置重写+措辞族+卫生)**:`/app/settings` 占位替换为真实四
  区设置面(AI 模型/Agent 团队/高级设置折叠/开发者模式折叠,唯一写面=
  既有事务式 PUT role-bindings);M11-04 审查移交措辞/精度族九项逐项
  收口(含 M11-04 披露算术勘误四条登记,§3);仓库根会话伪迹清理(nul
  经 `\\?\` 设备路径+四个 %TEMP%* 文件/目录)——§2/§3;
- **任务 2(版本抬升+文档)**:0.3.0→0.4.0 四处+Cargo.lock 壳包行;
  CHANGELOG 0.4.0 节;发布说明草稿 reports/V0.4.0-RELEASE-NOTES.md
  (四分类+新 UI 首启流程);外部 npm 依赖零变化三重断言——§4;
- **任务 3(构建+安装复验)**:五步构建链 exit 0 →
  `role-orchestrator-shell_0.4.0_x64-setup.exe`(26,149,787 字节,
  SHA256 `4d1f66b5a63438acfa2a4fe45a62eaf495114bb5dd983fe73f5783c03aa82040`);
  本机卸 0.3.0→装 0.4.0 开箱复验(≥六断言+新 UI 专项全过,§5);真实
  CLI 冒烟未执行(维护者清单);
- **任务 5(本提交)**:批报告/PROPOSALS 披露/BACKLOG 完成态/
  backlog.json/CHECKSUMS 终同步。

红线遵守:orchestration 语义零变化(服务端 src 零触碰,唯一 local-api
改动=review-records 测试种子时间戳);零新增外部 npm 依赖(pnpm-lock
零 diff+release-audit 43/43);零新增端点(设置页唯一写=既有事务式
PUT role-bindings,profiles 面只读+指回既有原子写回);守卫/审批/调度/
令牌自动认证(ADR 010)零触碰;git add 显式路径零 -A;无 push 无 tag;
冻结面改动(CHANGELOG/PROPOSALS/BACKLOG/backlog.json)逐文件纯 LF+
CHECKSUMS 对应行重算,planning-check 80/80。

## 2. 设置页结构(任务 1 主面)

`/app/settings` 替换 M11-01 占位(apps/desktop-ui/src/pages/
SettingsPage.tsx 重写),四区对齐冻结产品基线(docs/BACKLOG.md M11 节):

- **AI 模型**:setup/status 检测行(Claude Code ✓ 已检测/未检测到 ·
  Codex 同构)+逐 profile 模型行(`model: null`→『CLI 默认』,依据
  contracts/src/schema/profiles.ts:8 的 schema 语义,不编造型号;同
  runtime 多配置『·配置 N』序数);profiles 拉取失败=『AI 配置状态
  未知(拉取失败)』(绝不假扮空列表);fileState 四态行(configured
  未载入=重启生效如实/unparseable/unwired/absent 各如实)。
- **Agent 团队**:项目下拉(既有 GET /api/v1/projects)→选中走既有
  GET /api/v1/projects/role-bindings?projectDir= →复用 RoleBindingCards
  /RoleBindingEditor + 『修改』保存经**既有事务式 PUT role-bindings**
  (oneShotGate 同步双发守卫,M11-03 移交 C 模式复用);未选项目=默认
  模板只读建议卡(setup status 的 defaultBindingTemplate,null=『暂无
  推荐分工』不编造);生效双句分开如实=绑定保存对该项目新建任务立即
  生效、AI 配置文件修改需重启桌面应用生效。
- **高级设置**(details 折叠):逐 profile credentialGroup/
  timeoutSeconds/maxConcurrency 只读(null→『未知』不编数;profile id
  作配置面行后缀=RoleBindingEditor 旧页对等先例);指回 JSON 臂=旧
  工作台「配置」页(既有 PUT /api/v1/profiles/full 原子写回+重启生效
  如实转述;零新写面)。
- **开发者模式**(details 折叠):定位说明+原生 `<a href="/">` 链旧
  工作台「高级(观测台)」页(如实声明:旧页页签式组织无深链子页地址;
  `/debug` 在新 UI 接管 / 后才存在——BACKLOG M11 节计划——此前只链
  真实可达页面);载明 Runtime/DAG Inspector/执行事件/Context/Memory/
  原始 API 的所在。
- 配套:api.ts ProfileSummary 投影扩 credentialGroup/timeoutSeconds/
  maxConcurrency(GET /api/v1/profiles 本回全量定义,缺失→null=未知);
  app.css settings-* 小节;shell.test 设置格改四区断言+新『M11-05
  settings faces』纯渲染 5 格(model CLI 默认/拉取失败未知/配置 N 序数/
  fileState 四态/模板卡零 id/null 模板不编造/高级表未知值)+logPanel
  caption 双臂格;review-handover-A 原生 `href="/"` 钉保持绿。

## 3. 措辞族逐项处置(任务 1,M11-04 审查移交)

| # | 项 | 处置 | 位置/证据 |
| --- | --- | --- | --- |
| 1 | ⑨ 日志截断括注方向 | 『更早日志未列出』→『更晚的日志未列出』(升序前 200 条,截断在更晚侧);行内注释登记勘误来由 | RunDetailPage.tsx:386 区域;M11-04-BATCH §2 ⑨ 行历史文档不改 |
| 2 | 三面注释→四面(两处) | RunDetailPage:457 区域『three-face round』→four-face、:535 区域『ALL THREE faces』→ALL FOUR(join 自 M11-04 起为四面) | RunDetailPage.tsx 两处注释 |
| 3 | ProjectsPage 拉取失败降级句 | bindingFace 第三参改 `ReadonlySet<string>\|null`(null=profiles 列表本身不可读),全绑定+null→新第六态 profiles-unknown,卡面『四个角色已绑定;AI 配置状态未知(拉取失败,无法确认配置是否已载入)』替换旧空集降级伪造的『未载入』;不完整绑定面不依赖 profiles 列表维持 incomplete;mount+登记后刷新两处加载点同步 | ProjectsPage.tsx;shell.test 新格 |
| 4 | PollRefreshBadge 停摆态(二选一) | **裁决=(a) 轮询失败自动重启+封顶退避**(失败轮 setTimeout 下轮,3s×2^n 帽 30s=POLL_MAX_BACKOFF_MS,成功复位)——徽标是轮询口径唯一声称点,自愈使声称经暂态故障持续为真;(b) 失败后徽标注销会留下死页=⑧ 页停摆同形;退避窗口节奏慢于 3s+错误行可见的权衡在两处头注披露 | RunDetailPage.tsx POLL_MAX_BACKOFF_MS 注释;RunVisualization.tsx 头注 |
| 5 | NodeDrillDown 第二口径点 | 括注条件化=新 pollActive prop(=detail 非终态),caption 抽纯函数 logPanelPollNote(shell.test 双臂格:终态臂 not.toContain『每 3 秒自动刷新』) | RunDetailPage.tsx logPanelPollNote;shell.test |
| 6 | runErrors 头注 cross-field 精度+NODES_OUT_OF_BUDGET 不可达 | 头注改『multi-node.ts declaration gates——budget/duplicate-id 为集合级、self-dependency 为单节点、dependency/integration/review 形状规则才是跨节点』(对照 multi-node.ts:86-150 实文);WORKFLOW_NODES_OUT_OF_BUDGET case 注释披露向导预检(WORKFLOW_NODE_BUDGET=64,submit:381 有问题即拒发)使该载体经产品 UI 不可达、句臂保留为 belt-and-braces 并由伪造载体格钉住 | runErrors.ts 头注+case 注释;runErrors.test 注释 |
| 7 | diffLines 『--- 』行着色归 del | 新 classifyDiffLines hunk 感知遍历(@@ 开启、diff --git 为多文件边界复位;hunk 内 `--- `/`+++ ` 归 del/add,文件头保持 meta;单行函数保留 meta 默认并声明歧义);UnifiedDiff 改用遍历;diffLines.test 4→8 格(同文两态判别/多文件边界复位/空遍历/端到端等价)+shell.test painter 格加 hunk 内删除行样本(diff-line-del 1→2,头行保持 meta) | diffLines.ts;UnifiedDiff.tsx;diffLines.test.ts;shell.test.tsx |
| 8 | review-records oldest-first 时间戳 | seedReview 增 now 参,双轮 T0 与 iso(90_000),断言 completedAt 精确值+递增;判别力双向实证:旧版双行同 T0 时 ORDER BY created_at 同值、排序走 id ASC tiebreak,时间序声称零判别力;本会话临时翻 **dist**(测试解析 dist:review package.json main=./dist/index.js;首次翻 src 无效的无效实验如实登记)record.js listReviewRecords 为 DESC→格恰红(AssertionError at test/review-records.test.ts:155)→复原→绿 | packages/local-api/test/review-records.test.ts;判别力实录见本节尾注 |
| 9 | 披露算术勘误(历史批报告不改) | 四条,登记于 §3 尾注与本批 PROPOSALS 披露节,供后续引用以本节为准 | 见下 |

**§3 尾注一(M11-04 披露算术勘误,四条)**:(甲)M11-04-BATCH §1/§8 与
PROPOSALS『治理披露:M11-04』称 32 文件=『24 改+8 新』,`git show
--name-status 949f461` 实证 **23 M+9 A**(新增文件 reports/M11-04-BATCH.md
自身被误计为修改);(乙)§8『任务 1(18 文件)』与 docs/BACKLOG.md:676
同句,实际 **17 文件**(§8 自身枚举 3+14=17,git name-status 同);
(丙)§9 desktop-ui 行『首跑 2 格红』同句列三个原因,949f461 提交消息
自证『首跑 3 格红』——实为 **3**;(丁)本批新发现同族:§9『local-api
30 文件』盘上实为 **31**(`ls packages/local-api/test/*.test.ts` 计数,
review-records.test.ts 即该提交新增;349 测试总数与报告一致=文件数少计
1),desktop-ui『8 文件』盘上 7 文件。历史批报告/BACKLOG 交付摘要按
ask 零改动,以本节为准。

**§3 尾注二(判别力实录)**:review-records 时间戳错开的判别力双向实证
=dist/record.js 临时 DESC→格恰红→复原→绿(复原后 grep 恰 1 处 ASC);
diffLines 同一 `--- ` 文本 walk 内=del/头位=meta 双态断言+多文件边界
复位格;caption 终态臂 not.toContain『每 3 秒自动刷新』。任务 1 门禁
首跑 3 个 TS 错=shell.test 旧 ProfileSummary 字面量缺 api.ts 新投影三
字段(类型层判别力),补齐后绿。

## 4. 版本抬升与文档(任务 2)

- 0.3.0→0.4.0 四处:根 package.json:3、packages/local-api/package.json:3、
  apps/desktop-shell/tauri.conf.json:4、apps/desktop-shell/Cargo.toml:3
  (每文件恰一行,count==1 断言);apps/desktop-shell/Cargo.lock 壳包行
  手改后经 `cargo update -p role-orchestrator-desktop-shell` 确认
  (『Locking 0 packages』,git diff 恰 1 行 2489-2490);desktop-ui
  维持 0.1.0(ask 未列,私有包 version 非发布面,M9-04 先例,CHANGELOG
  已登记)。
- 外部 npm 依赖零变化三重断言:`pnpm install`『Lockfile is up to date,
  resolution step is skipped』(38 workspace projects)+`git diff
  pnpm-lock.yaml` 前后均 0 行+release-audit 6 文件 43/43 passed。
- CHANGELOG『## 0.4.0 — 2026-10-08』:版本线说明+Changed 三条(壳默认页
  /→/app 旧工作台保留、令牌自动认证 ADR 010、serve --profiles 首启态桥
  语义变更[原拒启→零 profile 启动+首启引导,迁移说明点名脚本化调用者])
  +Added 五条+『迁移说明(0.3.x → 0.4.0)』(零新迁移 001..018[grounding:
  packages/maintenance/src/chain.ts:30,97,102]/profiles.json 格式不变/
  POST /projects 405→登记面需知);CHECKSUMS CHANGELOG 行重算
  (1ebe18e9…→0dd0b202…)。
- 发布说明草稿 reports/V0.4.0-RELEASE-NOTES.md:四分类对齐 README 能力
  边界+新 UI 首启流程六步+已知限制;README『当前版本』句(README.md:10
  仍 v0.3.0)**本批不动**,刷新点登记于该文件已知限制节(发布执行时抬
  v0.4.0+UI 变更说明+四分类同步)。

## 5. 五步构建链与安装复验(任务 3)

### 5.1 构建(apps/desktop-shell/README.md:269-273 顺序,逐命令 exit 0)

`pnpm build` 37/37 → `pnpm --filter @role-orchestrator/local-api run
bundle:serve`(serve-bundle.mjs 1,742,105 字节;M11-02 陈旧度守卫按设计
工作:staged 晚于 dist 放行)→ `node scripts/fetch-node-runtime.mjs`
(便携 node sha256=钉值 98843732…幂等命中零网络)→ `node scripts/
sync-shell-sidecar.mjs`(serve-bundle 1,742,105+desktop-ui.html 361,939
两件入树)→ `cargo tauri build`(release 1m28s)。产物
`apps/desktop-shell/target/release/bundle/nsis/role-orchestrator-shell_0.4.0_x64-setup.exe`
= **26,149,787 字节(24.94 MiB)**,SHA256
`4d1f66b5a63438acfa2a4fe45a62eaf495114bb5dd983fe73f5783c03aa82040`。
产物在 target/(gitignore)不入库,仅路径与 SHA 入披露。

### 5.2 卸旧-装新(/S 经 PowerShell Start-Process,M10-06 §4.3 同法)

- 卸 0.3.0:首试 `/S _?=` exit 2 零效果(如实登记);普通 `/S` +
  -WorkingDirectory 完全移除(安装目录整个消失含 uninstall.exe 自身、
  HKCU Uninstall 键 gone、HKLM 零写入),数据目录保留(profiles.json
  sha256=45762b2aa643053a… 前后一致)。
- 装 0.4.0:`/S` exit 0 → HKCU DisplayVersion=0.4.0、HKLM 无、
  VersionInfo 0.4.0/0.4.0、载荷三件与构建产物逐一**字节一致**
  (serve-bundle.mjs/desktop-ui.html/node.exe[钉值 98843732…])。

### 5.3 开箱断言(≥六+新 UI 专项,全过)

1. 静默安装+VersionInfo 0.4.0(5.2)。
2. 无环境变量启动:RO_* 核空;壳 pid 77020。
3. serve 链=安装目录载荷,完整 argv 实录:`…role-orchestrator-shell\
   node-runtime\node.exe …\serve-bundle.mjs --db …\role-orchestrator\
   orchestrator.db --port 0 --profiles …\role-orchestrator\profiles.json`
   (父进程=壳)。**端口变化如实登记**:v0.4.0 传 `--port 0` 由 serve
   诊断行动态回报,实际监听 **127.0.0.1:62270**(M10-06 时代固定 54241
   不再适用)。
4. 端口监听:netstat LISTENING 62270 pid 42344。
5. 无凭据 403:GET /api/v1/session=403、GET /api/v1/profiles/full=403;
   GET /=200 旧工作台完整保留(含令牌输入元素)。
6. **带凭据 API 200(v0.1.0 教训)**:本次 serve 启动的 token 文件
   (session-token-3c201d0d…,mtime 13:20:17;令牌值零打印)→Bearer:
   /api/v1/session=200 发 CSRF、/api/v1/profiles/full=200
   parseError=null 载入用户 2 个 AI 配置(内容零打印)、/api/v1/projects
   =200 projects=4。
7. **壳窗 /app 新 UI 首屏(非旧页非 404)**:GET /app=200 content-length
   361,939 与构建的 desktop-ui.html 逐字节同源;壳窗 PrintWindow 截图
   (留存 %TEMP%\ro-drill-m11-05\shell-window.png)目视实证:侧栏恰四
   入口+『今天想完成什么?』首屏+页面内零令牌输入;非旧页(令牌输入仅在
   /)、非 404。
8. **自动认证生效**:截图中项目下拉已由页面内认证 API 载入用户库真实
   项目(纯浏览器同请求=403 对照,壳内=数据在位,ADR 010 壳注入活体)。
9. 旧库幂等迁移数据保留:0.4.0 零新迁移(001..018),卸载-重装前后
   orchestrator.db **sha256 逐字节一致**(552,960B,3b3fc155…前后同,
   本轮无 WAL checkpoint 副作用)、8 条 task_runs 逐行一致(含 v0.2
   时代真实 claude 任务的 RUNNING 诚实终态)、profiles=8、projects=4;
   旧库由 0.4.0 serve 开箱打开并经 API 服务,绑定面如实呈现『4 个角色
   已绑定,但其 AI 配置当前未载入』(旧 drill 绑定指向当前 profiles.json
   之外=诚实态活体)。
10. 强杀树杀清零:`taskkill /PID 77020 /T /F`(经 PowerShell 包裹;bash
    直调曾被 MSYS 路径改写为无效参数未杀任何进程,如实登记后改道)→9
    进程终止→孤儿=0、62270 关闭。

### 5.4 真实 CLI 冒烟(红线)

**未执行**(维护者清单如实登记):全程零真实 claude/codex 调用。

## 6. 变更文件清单(批累计,单一提交,25 文件)

任务 1(13):apps/desktop-ui/src/{api.ts、app.css、components/
RunVisualization.tsx、components/UnifiedDiff.tsx、diffLines.test.ts、
diffLines.ts、pages/ProjectsPage.tsx、pages/RunDetailPage.tsx、pages/
SettingsPage.tsx、runErrors.test.ts、runErrors.ts、shell.test.tsx}、
packages/local-api/test/review-records.test.ts。

任务 2(8):package.json、packages/local-api/package.json、apps/
desktop-shell/{tauri.conf.json、Cargo.toml、Cargo.lock}、CHANGELOG.md、
CHECKSUMS.sha256、reports/V0.4.0-RELEASE-NOTES.md(新,不入冻结面)。

任务 3(0 新文件;产物在 target/ gitignore 不入库,安装复验实录回填
V0.4.0-RELEASE-NOTES.md 与本报告 §5)。

任务 5(4):reports/M11-05-BATCH.md(新,不入冻结面)、PROPOSALS.md、
docs/BACKLOG.md、project/backlog.json。

合计 **25 文件**(23 改+2 新)。

## 7. 测试及退出码(2026-10-08 本会话实跑,逐命令)

| 命令 | 结果 |
| --- | --- |
| `pnpm typecheck`(任务 1 终态/任务 2/任务 5 各轮) | 62/62 exit 0(任务 1 首跑 3 个 TS 错=旧测试夹具缺新投影字段,补齐后绿) |
| desktop-ui `pnpm exec vitest run` | 7 文件 89/89 passed exit 0(79→89:diffLines +4、shell +6) |
| local-api `pnpm exec vitest run` | 31 文件 349/349 passed exit 0(136.4s;0 新格,review-records 仅种子/断言改) |
| `pnpm build` | 37/37 exit 0(desktop-ui dist/index.html 361,939 字节含设置页) |
| `node planning-check.mjs` | (a) 80/80 checksums match+(b) self-test exit 0(CHANGELOG/PROPOSALS/BACKLOG/backlog.json 行重算后) |
| release-audit `pnpm exec vitest run` | 6 文件 43/43 passed(版本抬升后依赖计数断言仍绿) |
| browser-e2e(附加回归) | app-shell-smoke 1/1、app-product-flow 1/1(final dist 复跑)+app-approval-flow 1/1、app-rework-flow 1/1 |
| 判别力双向实证(review-records) | dist listReviewRecords 临时 DESC→格恰红(:155)→复原→绿 |
| 五步构建链 | 逐命令 exit 0(§5.1) |
| 字节卫生 | 25 文件逐字节 BOM=False CR=0 纯 LF 尾 LF |

## 8. 未验证项

1. **干净机首任务全流程(完成标准真实面,归维护者)**:『干净机安装→
   零配置→首任务』的自动化面=首启向导+hermetic e2e(product/approval/
   rework flow)已建并绿+本机安装复验全过;真正干净 Windows 机器
   (WebView2 在位率抽样、GUI 双击安装)、真实 Claude/Codex 首任务=
   维护者环境动作(红线,不伪造)。
2. **真实 CLI 冒烟未执行**(§5.4):产品内真实 Claude/Codex 端到端
   (尤其多节点/并行/返工的真实 findings 质量)unverified 口径不变。
3. 真窗人工项:自动认证注入链路逐跳观测、WS 握手已知限制观感、彩色
   diff 真窗像素、审批决策真窗点击——维护者冒烟清单(apps/
   desktop-shell/README.md v0.3.0 口径清单待 0.4.0 刷新)。
4. 设置页认证态数据面的浏览器级 e2e 未新增(SSR 纯格+未认证深链 smoke
   覆盖;app-product-flow 认证模式可扩展,留交接)。
5. 轮询退避失败臂无浏览器级故障注入断言(源码实现+决策注释披露)。
6. 10 轮审查属批次后续流程,本报告交付时未开始。
7. NewTaskPage 的 profiles 拉取失败降级(预填计数按空集)与 ProjectsPage
   同族但非本批 ask 点名面,维持 M11-04 交付原状(如实登记)。

## 9. Release 就绪清单(维护者批准链;Developer 不执行)

1. 10 轮连续独立审查通过后,维护者按 project/RELEASE_PROCESS.md 逐项
   决定。
2. README.md:10『当前版本』句抬 v0.4.0(刷新点已在 V0.4.0-RELEASE-NOTES
   已知限制节登记:附 M11 一句话摘要+v0.3.x→0.4.0 UI 变更说明[壳默认
   /app、旧工作台在 /、serve --profiles 首启态桥]+能力边界四分类同步)。
3. 真实 CLI 冒烟与干净机演练:批准发布前按冒烟清单逐项执行或显式接受。
4. GOVERNANCE/MANIFEST 等发布面文件复核(本批未触碰)。
5. 批准后:`tag v0.4.0`(候选=本提交 SHA)+GitHub Release 页(发布说明
   以 reports/V0.4.0-RELEASE-NOTES.md 为底稿)+归档+推送——本批零 push
   零 tag。
6. 回退:保留 0.3.0 安装包(bundle/nsis/ 内仍在)与数据库备份;迁移链
   001..018 只增不改,0.4.0 零新迁移,回退=旧版安装包+备份数据目录。

## 10. M11-05 交接(v0.4.0 发布后)

- 完成标准对照:『干净机安装→零配置→首任务全流程』自动化面+本机安装
  复验已闭环(§5);真实面归维护者(§8.1);v0.4.0 发布就绪=本批产物
  +披露在案,发布动作=维护者链(§9)。
- 已知移交面:hold 处置入口(resolveRunHold 无 HTTP 面,另行立项)、
  问题分级持久化(contracts 扩展+迁移,服务端面)、WS 直播产品化
  (ADR 010 增补流程,真实使用反馈触发)——均已在相应披露节登记。
