# M9-04 批次报告:打磨、v0.2.0 版本抬升、端到端演练与发布准备(M9-04-BATCH)

日期:2026-10-04 · 执行角色:Developer · 性质:**M9 收官批 + v0.2.0 发布准备
(维护者已批准的发布路径:tag v0.2.0 与 Release 页由维护者逐项决定)**。

## 1. Summary(三批任务,同报告登记)

- **任务 1(candidateSha ffb222e)**:M9-03 审查移交小项逐条收口——#62
  model-only 语义文案精确化(七处)+ #54/#56/#63/#64/#57/#59/#60/#65/#66
  全清单,含卸载 node-runtime 遗留实测(不复现)与本机装机还原。
- **任务 2(candidateSha 30e5934)**:M9-02/03 审查移交测试补充(敌意状态
  断言/202 判别力/a11y 播报/phase 枚举/UX 自动切页/flow-7 配置页 e2e/
  model-only 行为回归)+ 工作树卫生(.gitignore 伪迹模式 + 删 nul)。
- **任务 3(本报告)**:v0.2.0 版本抬升、NSIS 重构建、本机卸载-安装-工作台
  端到端演练、真实 CLI 上游探测与冒烟、发布准备登记。

## 2. 版本抬升(全部实改实核)

| 文件 | 变更 |
| --- |
| `packages/local-api/package.json` | 0.1.1 → **0.2.0** |
| `package.json`(根) | 0.1.0 → **0.2.0** |
| `apps/desktop-shell/tauri.conf.json` | 0.1.0 → **0.2.0** |
| `apps/desktop-shell/Cargo.toml` | 0.1.0 → **0.2.0**(审查登记的壳版本缺口收口) |
| `CHANGELOG.md` | `## Unreleased` 落定为 `## 0.2.0 — 2026-10-04`,M9-01..03 内容随节并入,M9-04 新条目置顶,修复条目(0.1.1 serve 建库迁移)自 Unreleased 迁入本节 |

版本一致性佐证:cargo 重编译横幅 `Compiling role-orchestrator-desktop-shell
v0.2.0`;NSIS 产物文件名 `role-orchestrator-shell_0.2.0_x64-setup.exe`;
VersionInfo 核验见 §4。

## 3. 门禁(全量,exit 0)

- `pnpm typecheck` = 0(turbo 59/59);`pnpm test` = 0(70/70 tasks);
  `pnpm build` = 0(35/35,FULL TURBO)。
- `cargo test --manifest-path apps/desktop-shell/Cargo.toml` = 0:lib 28 +
  bin 18 + source_invariants 3 全过,integration 1 ignored(按设计)。
- `node planning-check.mjs` = 0((a) CHECKSUMS 79/79 + (b) 干净副本
  self-test;最后一次实跑在本批报告/CHECKSUMS 同步之后,见 §8)。

## 4. NSIS 重构建与本机卸载-安装(五步链,exit 0)

README「打包分发」顺序全链实跑:

1. `pnpm build`(35/35);
2. `pnpm --filter @role-orchestrator/local-api run bundle:serve` →
   **1,596,370 字节**(前置检查通过);
3. `node scripts/fetch-node-runtime.mjs` → 幂等跳过(sha256 匹配钉值
   98843732…,零网络);
4. `node scripts/sync-shell-sidecar.mjs` → 1,596,370 字节入树;
5. `cargo tauri build` → release 编译 43.56s,`Info Target: x64`,
   **role-orchestrator-shell_0.2.0_x64-setup.exe = 26,034,962 字节
   (24.83 MiB),sha256 e077b8124ea29c1c05d50d982b9b5f56c9dfa81a92980f9f
   64c534ec97e0f79a**,日志 `Finished 1 bundle`。

**VersionInfo 核验(0.2.0 落地证据)**:setup.exe 与主 exe
`ProductVersion/FileVersion = 0.2.0`,ProductName `role-orchestrator-shell`
(PowerShell Get-Item VersionInfo 实读)。

静默卸载(在位同步形态 `uninstall.exe /S _?=…`,exit 0):安装目录仅剩
uninstall.exe 自身、HKCU 登记键移除、数据目录原样保留(orchestrator.db
sha256 前缀 f1c1d714b195aa1 前后一致);静默安装
(`Start-Process -Wait /S`,exit 0):四载荷在位(shell exe 8,988,672 字节
= 0.2.0 重编译产物、serve-bundle.mjs 1,596,370 字节含 M9-04 页面代码——
ASCII 标识符 announcedFailure/countExecutionPhases/profilesSourcePath 各
4 处实证,esbuild 对非 ASCII 转义故中文 grep 不作数、node.exe sha256=
钉值前缀 98843732431bad6c)、HKCU 键恢复。

## 5. 端到端演练(生产安装形态,全部命令实跑)

**前置**:约定路径无 profiles.json(M9-03 收尾已移除);`RO_SHELL_NODE`/
`RO_SHELL_SERVE_BIN` 显式核空(0 条);shell 进程 0。

- **① 无配置首启(诚实 409 态)**:启动安装壳 → shell pid 61812 → direct
  child serve pid 94760(ParentProcessId 断言),argv **6 元素**(`node
  serve-bundle.mjs --db … --port 0`,无 --profiles——存在才传);
  GET /api/v1/profiles/full → 无 token 403 / 带 token **409
  PROFILE_SOURCE_ABSENT** 带接线引导。真实窗口此态已创建(见 ⑤)。
  **口径说明**:配置页写入的前提是 serve 携 `--profiles`,而旗标仅在约定
  路径已存在时传入(壳侧「存在才传」设计,M9-03)——「无配置则经配置页
  写入」因此按两阶段执行:先落一个最小合法 seed 文件让壳把路径接给
  serve,再经配置页把真正的演练配置写进去(下)。
- **② seed + 重启(接线成立)**:约定路径放置 357 字节严格
  ProfilesFileSchema JSON(drill-seed 占位 profile);taskkill 树后重启壳
  → serve argv **8 元素**、尾部恰 `--profiles
  C:\Users\star\AppData\Local\role-orchestrator\profiles.json`;GET
  /profiles/full → 200,rawText 与盘上逐字相等、parseError null。
- **③ 配置页真实写入链(守卫+原子写回在生产形态生效)**:经
  GET /api/v1/session 取 CSRF 后 **PUT /api/v1/profiles/full** 写入演练
  配置(drill-real-claude=真实 claude.exe 2.1.281 + drill-fake-claude=
  临时 wrapper 先插 --scenario success 再调仓库 fake-cli dist bin;两
  configDir 均为空临时目录,只作存在性探测,零凭据读取):首次 **403**
  (变更请求缺 Origin——守卫 A30 如实拒绝,补同源 Origin 后)**200,
  bytesWritten 876/881 = content 字节数,盘上字节逐字相等**(临时文件+
  rename 原子写回)。写入后运行进程不热重载——随即**实测复现**了文档
  语义:立即建任务 → 400 UNKNOWN_PROFILE "not among the profiles this
  server loaded (drill-seed)",fail-closed 拒绝、零落库;重启壳后新定义
  生效。
- **④ 漂移门活体演示**:首版演练配置曾含一个残缺路径(临时脚本转义
  事故,该版建任务 500 configDir ENOENT 且 profile 行已落库);修正版
  (可执行路径/配置目录不同)建任务即 **409 PROFILE_DEFINITION_CONFLICT
  (executable/configDir 字段)**——漂移是显式的人的决定,改 id 后通过。
  与 #62 回归格互补:model-only 修改不撞门(M9-04 任务 2 已钉),七字段
  修改撞门(本机活体实证)。
- **⑤ 工作台双任务(202 → 终态 → 可查)**:重启后 `POST /api/v1/runs`
  双 202:
  - **任务 A(drill2-fake-claude,run-musn4hxo-d7b084da)**:202 queued →
    **READY_FOR_DELIVERY,执行 SUCCEEDED(attempt 1)**,events 200 共
    10 条(started/message_delta/tool_started/tool_completed/
    artifact_reported/result_reported/usage_reported/process_exited/
    lifecycle_outcome)——**v0.2.0 安装形态下工作台全链(创建→隔离→
    fake-cli 执行→事件落库→REST 可查)闭环**。
  - **任务 B(drill2-real-claude,run-musn4i1f-27f91295)**:202 queued →
    真实 claude 2.1.281 启动(sessionId=5dd72438…,model
    claude-opus-5[1m],cwd=worktree 隔离路径)→ **9×api-retry 全部
    errorStatus 503**(指数退避 592ms→38575ms)→ 150s 杀预算触发
    taskkill /PID 69220(killEvidence 在案)→ process_exited exitCode 1
    → lifecycle_outcome finalPhase=FAILED(reasons=nonzero-exit/
    missing-final-result/timeout,timedOut=true);**run 级状态留
    RUNNING**(词汇表无失败值,诚实语义)——真实 CLI 的「创建→隔离→
    spawn→流式落库→预算树杀→可查」半程在 v0.2.0 安装形态复证。
  - GET /api/v1/runs 列表:3 行(M9-03 证据 run 在列)、objective 逐字
    回显、创建倒序;GET / 200(工作台三区块+三页签元素 9 处命中);
    守卫探测 403。
- **⑥ 真实窗口与收尾**:Win32 EnumWindows 实证可见窗口标题
  **"Role Orchestrator"**(pid 99792=壳进程)。托盘菜单点击属真窗 GUI
  交互,本会话不可自动化(见 §7 unverified);收尾以受控
  `taskkill /T /F` 结束壳树(内核 Job 树杀兜底),**孤儿=0**;测试
  profiles.json 已自约定路径移除(其 wrapper 路径将随临时目录删除,留着
  会按「坏文件启动侧披露」阻塞下次启动),数据目录保留为演练持久证据
  (orchestrator.db 仍 f1c1d714b195aa1 前缀 + 本批两条 run 的
  worktrees),不删库不改证;临时 fixtures(目录/脚本)已删。

## 6. 真实 CLI 上游探测与冒烟(ask 第 3 项)

- 直接探针:`claude -p "Reply with exactly: OK"` → **API Error: 503 No
  available accounts**(本机推理网关 127.0.0.1:15721)——上游仍不可用。
- 演练任务 B 即 M9-01 §5 移交冒烟的同型重跑(§5 ⑤):链路半程(创建→
  隔离→真实 spawn→流式落库→预算树杀→可查)在 v0.2.0 安装形态再次实证;
  **模型补全半程仍因上游持续 503 未完成,如实登记**(v0.1.1/M9-01 同
  口径,不伪造)。codex 真实冒烟未执行(claude 同因失败,不消耗额外
  真实调用,M9-01 §6.2 同口径)。

## 7. 未验证项(如实登记)

1. **托盘菜单点击退出**:真窗 GUI 交互本会话不可自动化(收尾用受控
   taskkill 走 Job 树杀,孤儿=0;托盘「退出」=先树杀 serve 再退壳的
   顺序由 `shutdown_sequence` 单测钉死)——点击级验证归维护者冒烟
   (历批同口径)。
2. 真实模型补全半程(上游 503,§6);codex 真实冒烟未执行。
3. 干净机(无工具链机器)卸载-安装-工作台演练未跑(载荷自足已由本机
   无环境变量安装态实证,干净机归维护者清单)。
4. 双击式 GUI 向导安装路径未验证(静默 /S 已验)。
5. v0.2.0 tag 与 Release 页发布动作:按 RELEASE_PROCESS 由维护者逐项
   批准,本批未打 tag、未触远端。

## 8. 提交与校验和

- 本批任务 1/2/3 的 candidateSha:ffb222e / 30e5934 / 见本报告所属提交
  (以 git log 为准)。
- 冻结面:CHANGELOG.md(Unreleased→0.2.0 落定 + M9-04 条目)与
  PROPOSALS.md(『治理披露:M9-04 交付与 v0.2.0 发布』节)按盘上纯 LF
  字节重算并同步 CHECKSUMS.sha256;`node planning-check.mjs` 复跑
  exit 0。
