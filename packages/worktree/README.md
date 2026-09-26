# @role-orchestrator/worktree

M2-03 · Execution worktree 生命周期。每个写入型 Execution 从固定 base SHA 建立
独立分支与工作树，位于引擎管理的目录中；用户仓库的 dirty 状态原样保留（A11），
清理只有一个显式入口，默认拒绝删除未提交改动（A40）。

语义依据：`docs/GIT_AND_WORKSPACES.md`、`docs/adr/003-execution-worktree.md`。
路径形态依据：`reports/M0-05-windows-launcher.md`。

## 公共接口

```ts
import {
  GitRunner,          // 唯一 spawn 点：spawn(git, [argv...])，绝无 shell 字符串
  createWorktree,     // 快照 -> 校验 -> 拒绝覆盖 -> worktree add -> 验证
  getWorktreeStatus,  // 注册状态 / 分支 / HEAD / 未提交改动（只读）
  discardWorktree,    // 唯一清理入口；默认拒绝 dirty，需显式 force
  snapshotRepositoryState
} from "@role-orchestrator/worktree";
```

所有输入经 `z.strictObject` 校验：`repoPath`/`worktreesRoot` 必须是绝对路径，
`runId`/`nodeId` 走 contracts 的 `IdSchema`（`^[a-z][a-z0-9_-]{0,63}$`，天然排除
`-b` 之类的选项形状），`baseSha` 必须是完整 40 位小写十六进制 commit SHA，
`attempt` 为 1..9999 整数。

## 生命周期语义

### createWorktree(git, input)

1. **fail-closed 预检**：`git --version` 必须可执行且可解析为 2.x+，否则抛
   `GitUnavailableError`，什么都不读、不建、不删。
2. 校验 repoPath 是一个仓库**顶层**（`rev-parse --show-toplevel` 与输入一致）。
3. **A11**：先对用户仓库做只读快照（HEAD、分支、`status --porcelain=v1 -z
   --untracked-files=all` 指纹），随结果返回（`userRepoSnapshot`），供调用方/测试事后比对。
4. 校验 baseSha 存在（`rev-parse --verify --quiet <sha>^{commit}`）。
5. 拒绝覆盖同名分支（`exec/<runId>/<nodeId>/<attempt>`）；拒绝已存在的目标路径；
   拒绝位于用户仓库内部的目标路径（`UnsafeWorktreePathError`）。
6. 唯一的变更型调用：`git worktree add -b <branch> <path> <baseSha>`，cwd 钉在
   用户仓库。全程没有 checkout/reset/clean/stash 落在用户工作区。
7. 创建后验证新 worktree HEAD === baseSha；验证失败抛
   `WorktreeVerificationError`，**已创建的 worktree 原样保留**（A40）。

任何一步失败都不会触发补偿性删除——失败路径上本包不存在任何删除代码。

### getWorktreeStatus(git, input)

只读视图：是否注册（`worktree list --porcelain`）、分支、HEAD、未提交改动明细。
未注册路径与目录缺失分别抛 `WorktreeNotRegisteredError` /
`WorktreeDirectoryMissingError`，不猜测。

### discardWorktree(git, input)

唯一清理入口，按序拒绝：

1. git 预检失败 → `GitUnavailableError`（坏 git 永远不会变成意外清理）；
2. 目标等于仓库根 / 是主工作树 → `UnsafeWorktreePathError`；
3. 未在 `worktree list --porcelain` 注册 → `WorktreeNotRegisteredError`
   （从不删除 git 不认识的目录）;
4. 目录已消失 → `WorktreeDirectoryMissingError`（A40：留待人工处置，不自动 prune）;
5. 有未提交改动且未传 `force: true` → `DiscardBlockedByUncommittedChangesError`
   （A40：默认拒绝自动清理未交付改动）;
6. 通过后执行 `git worktree remove [--force] <path>` 并双向验证（注册表与磁盘）。

exec 分支**保留**（只删工作树目录，保留可追溯性）。`force: true` 是产品级显式
授权参数（A40 要求），仅作用于 git 注册的 worktree，与 force push 类远程/历史
改写操作无关。

## argv 纪律与路径形态（A28）

所有 git 调用是 `spawn(gitPath, [argv...])`，无 shell、无字符串拼接；cwd 显式
指向用户仓库或目标 worktree。测试矩阵覆盖：中文+空格（仓库与 worktree 根同时）、
>260 字符长路径（该格钉住 git-for-windows 的 MAX_PATH 拒绝语义，仅在 win32
运行；POSIX 无此限制，非 Windows 平台门控跳过并显式声明）、跨盘符（系统临时盘
建仓库、`H:` 建 worktree；`H:` 不可写的机器上该格为平台门控跳过并在测试输出中
显式声明）。路径与 ID 的注入面由 Schema 在任何 git 调用之前拒绝（选项形状 ID、
非 40-hex SHA、非整数 attempt）。

## 测试

`pnpm test`（turbo 管道自动登记）。全部使用系统临时目录下由测试自行
`git init` 的 fixture 仓库；清理用经验证的原语（mkdir/copy 白名单语义，
`fs.rm` 在 Node 25/win32 非 ASCII 路径上已知损坏，见 M0-05）。git 未安装或
版本异常通过注入 runner 模拟（`GitUnavailableError`），真实 git 缺失时
预检同样 fail-closed。

## 已知边界

- 本包不实现集成分支与多父 inputSha 组合（M2-04）。
- worktree 共享 `.git` 元数据，不是权限沙箱（ADR 003）。
- 创建过程不禁用 hooks（fixture 仓库无 hooks；产品化 hooks 管控属受控 Git
  Service 的 M2-04+ 范围）。
- **失败的 create 可能留下 exec 分支**：`git worktree add -b` 先建分支后
  checkout，若 checkout 失败（如路径超长），分支会残留。按 A40 本包不做
  补偿性删除，分支保留待人工处置；同号新 attempt 会因
  `BranchAlreadyExistsError` 换号。
- **>260 字符长路径在本工具链不可行**（git version 2.54.0.windows.1 实测）：
  普通 `worktree add` 在 262/301/433 字符目标上 exit 128（`could not create
  leading directories` 或 `Filename too long`）；`-c core.longpaths=true` 与
  仓库级 `core.longpaths=true` 反而使**任意长度**的 worktree add 失败
  （`fatal: '$GIT_DIR' too big`）；`\\?\` 扩展前缀被 git 改写为 `//?/` 后失败；
  以 >260 cwd 启动 git 进程直接 ENOENT（CreateProcess 限制）。因此长路径格
  的测试钉住的是 fail-closed 行为：typed `GitCommandError`(exit 128) +
  无目录 + 用户仓库不动 + 残留分支保留。此限制属 git-for-windows 工具链，
  应记入 M6-01 Windows 兼容矩阵。
