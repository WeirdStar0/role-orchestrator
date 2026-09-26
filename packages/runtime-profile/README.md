# @role-orchestrator/runtime-profile

M1-02 的 Profile 与角色绑定快照包：迁移 0002、角色绑定服务、Run 冻结快照、
漂移检测、executionTarget 检查与"无节点覆盖"双重防线。
基于 `@role-orchestrator/store`（`node:sqlite`，Node >= 25，Windows + Node v25.0.0 实测）。
语义以 `docs/PROFILE_AND_MODEL.md`、`docs/DOMAIN_MODEL.md` 与
`docs/adr/001-fixed-roles-and-binding.md`（已冻结）为准。

## 覆盖的验收项

| 验收项 | 本包落点 |
|---|---|
| A01 每角色绑定单个 Profile，缺失/多个/未知 Profile 启动前拒绝 | `validateRoleBindingsReady` + `RoleBindingsNotReadyError`（kind: missing/unbound/multiple/unknown-profile/unknown-revision）；约束层 `UNIQUE(project_id, role_id)` + 复合外键 |
| A02 Node/Task/Workflow 注入 model/Profile 均拒绝 | 类型层：所有输入 `z.strictObject` 且字段集不含覆盖键（compile-time 断言钉住）；运行时层：`assertNoProfileModelOverride` 深扫描 + `NodeOverrideRejectedError`。schema 层由 contracts 的 `OverrideFieldName` 断言承担；UI 层属 M5 |
| A03 只接受四角色 | `assertKnownRoleId`（大小写敏感）+ `UnknownRoleError` + 迁移 CHECK 约束 |
| A29 target 不一致前置类型化错误，不隐式转换 | `checkExecutionTarget` + `ExecutionTargetMismatchError`（target-differ / path-form），绑定、注册、建 run 三处前置 |
| A34 检测漂移；原 run 不隐式更换 | 不可变半：`run_profile_snapshots` + `readRunRoleProfile`（只读快照，校验哈希）；检测半：`getRunBindingDrift` / `detectExternalConfigDrift` / `checkRunProfileDrift`，结构化结果而非静默通过 |

## 数据表（迁移 0002）

- `profiles` — 本机 CLI 运行环境（runtime/executable/executionTarget/configDir/
  credentialGroup/并发/超时）。不存储任何凭据材料。
- `profile_revisions` — 不可变、只追加（`UNIQUE(profile_id, revision)`）。携带
  model 期望值（NULL = 使用 CLI 默认模型）、外部配置基线
  （`external_config_hash` + 显式文件清单 `external_config_files`）与全量
  `config_hash`（即 `ProfileSnapshot.hash`）。本包不存在任何 UPDATE/DELETE 路径。
- `role_bindings` — 四个内置角色各至多一行；`profile_id`/`profile_revision`
  成对为 NULL（未绑定）或共同指向已存在的 revision（复合外键）；
  `permissions_revision`、`can_create_subtasks` 按 DOMAIN_MODEL 保存。
- `run_profile_snapshots` — A34 不可变半：建 run 时把 角色 → (profile, revision)
  的解析结果连同冻结的 `ProfileSnapshot` JSON 与哈希一起写入，
  `UNIQUE(run_id, role_id)`。

迁移必须通过 `applyRuntimeProfileMigrations` / `RUNTIME_PROFILE_MIGRATIONS`
应用（001 + 002 一起；假设 `projects`/`task_runs` 已存在）。只用 store 包
`DEFAULT_MIGRATIONS` 的旧构建对含 002 的库运行 `verifyMigrations` 会按
"数据库比代码新" 拒绝——这是有意的 fail-closed 降级保护。

## 服务层速览

```ts
import { openDatabase } from "@role-orchestrator/store";
import {
  applyRuntimeProfileMigrations, createProfile, createProfileRevision,
  initializeProjectRoleBindings, setRoleBinding, validateRoleBindingsReady,
  createTaskRunWithProfileSnapshot, readRunRoleProfile, checkRunProfileDrift
} from "@role-orchestrator/runtime-profile";

const db = openDatabase("orchestrator.db");
await applyRuntimeProfileMigrations(db, { backupPath: "backups/pre-migrate.db" });

createProfile(db, { id: "claude-main", runtime: "claude", executable: "claude.cmd",
  executionTarget: "windows-native", configDir: "C:/Users/u/.claude",
  credentialGroup: "personal", maxConcurrency: 2, timeoutSeconds: 600, now });
await createProfileRevision(db, { profileId: "claude-main", model: null,
  externalConfigFiles: ["settings.json", "mcp.json"], now }); // 从磁盘算基线

initializeProjectRoleBindings(db, { projectId: "proj-1", now });
setRoleBinding(db, { projectId: "proj-1", roleId: "developer",
  profileId: "claude-main", now }); // 默认钉住最新 revision

const run = createTaskRunWithProfileSnapshot(db, { runId: "run-1",
  projectId: "proj-1", taskId: "task-1", graphRevision: 0, baseSha: "sha", now });
const frozen = readRunRoleProfile(db, { runId: "run-1", roleId: "developer" });
const drift = await checkRunProfileDrift(db, "run-1");
```

- 换绑只影响之后新建的 TaskRun；已有 run 的读取
  （`readRunRoleProfile`）只走快照行，并校验 `snapshot_hash`，
  篡改即 `SnapshotIntegrityError`，绝不回退到当前绑定。
- `checkRunProfileDrift` 返回结构化结果（绑定漂移含 modelBefore→modelAfter，
  外部配置逐文件状态），漂移是"发现"，不是异常；异常只用于前置条件失败。
- `createProfileRevision` 在省略 `externalConfigHash` 时会读盘计算基线，
  因此是 async；请在 `withTransaction` 之外调用（不要在持有写锁时做文件 I/O）。
  configDir 尚不存在时显式传入 64 位十六进制 `externalConfigHash`。

## A29 executionTarget 规则

Windows 原生与 WSL 是不同的路径/进程管理体系（D07），不一致即
`ExecutionTargetMismatchError`，绝不隐式转换：

- 三方一致性：profile.executionTarget = project.executionTarget =（可选的）
  requestTarget，任何不等即 `target-differ`。
- 路径形态按 target 校验：windows-native 接受盘符路径、非 WSL 的 UNC、
  相对命令名；wsl/linux-native/macos-native 接受 POSIX 绝对路径与相对命令名；
  POSIX 绝对路径出现在 windows-native（或盘符/UNC 出现在 wsl 系）即
  `path-form`。
- `\\wsl$...` / `\\wsl.localhost...` 是从 Windows 看 WSL 文件系统的混合世界
  视图，对**所有** target 都拒绝：windows-native 不应伸进 WSL 文件系统，
  wsl target 应使用 WSL 内部的 POSIX 路径。
- 相对命令名（如 `claude.cmd`）对任何 target 都允许——PATH 查找发生在
  目标世界内部。

检查发生在最早的时点：`createProfile`（注册）、`setRoleBinding`（绑定）、
`createTaskRunWithProfileSnapshot`（请求 target 与项目 target 再核）。

## A02 无覆盖入口：双重防线

Profile/model 的唯一合法选择点是项目级 RoleBinding（`setRoleBinding`）与
Profile 注册本身。任务/节点/工作流层不存在覆盖入口：

1. **类型层**：所有输入是 `z.strictObject`，字段集没有 model/profileId/
   profileRevision 等键；测试用 `Expect<Equal<HasKey<Input, "model">, false>>`
   编译期钉住——将来任何人给输入加上这些字段，typecheck 直接失败。
2. **运行时层**：`assertNoProfileModelOverride(input, context)` 在 schema 解析
   之前深扫描原始输入（大小写不敏感、数组/嵌套对象、防环、深度上限 32，
   路径形如 `$.definitions[0].profileId`），命中即抛
   `NodeOverrideRejectedError`。即使调用方用 `as any`/JSON 旁路塞进覆盖字段，
   也在进入业务逻辑前被拒绝。

禁止键清单 `FORBIDDEN_OVERRIDE_KEYS` 以 contracts 的
`OverrideFieldName`（node.ts 已被 compile-time 断言冻结）为底，追加
`requestedModel`、`modelOverride`、`fallbackModel`、`profileRevision`、
`profileOverride`、`profileSnapshot`、`profilesOverride`。该守卫只用于"禁止
选择"的表面（建 run、未来 M2 的节点/工作流定义），**不**用于
`setRoleBinding`/`createProfileRevision`——那是唯一允许出现 profileId/model
的地方。

## 漂移检测的安全边界（重要）

`src/drift.ts` 只做一件事：对 Profile revision **显式声明**的外部配置文件清单
重新哈希并与基线比较。边界如下，全部有测试钉住：

- **只哈希显式列出的文件**。从不扫描、枚举、通配 configDir；未列出的文件
  （哪怕新增了可疑文件）不参与比较——比较对象是"声明的配置是否被改动"，
  不是目录监控。
- **凭据文件名模式排除清单**（`CREDENTIAL_NAME_SUBSTRINGS` +
  `CREDENTIAL_FILE_EXTENSIONS`，大小写不敏感、对整个相对路径匹配，含子目录）：
  `auth`、`credential`、`token`、`secret`、`password`、`passwd`、`apikey`、
  `api_key`、`api-key`、`oauth`、`cookie`、`netrc`、`privatekey`、`private_key`、
  `id_rsa`、`id_ed25519`、`id_ecdsa`、`keystore`、`sessionkey`、`masterkey`；
  扩展名 `.key`、`.pem`、`.p12`、`.pfx`、`.kdbx`、`.jks`。
  因此 `auth.json`、`.credentials.json`、`oauth_token.txt`、`creds/…/token.dat`
  等在**注册清单时即被拒绝**（`ExternalConfigViolationError: credential-pattern`），
  哈希时还会复检（防数据库行被篡改后复活）。为控制误报，裸 `key`
  **不是**子串模式（否则 `keybindings.json` 会被误拒）；密钥材料由扩展名规则兜住。
- **路径必须相对且不逃逸**：绝对形式（`/…`、`C:\…`、`\\…`、盘相对 `C:name`）、
  `..`、空/`.` 段、控制字符全部拒绝；落盘解析后还用 realpath 复核最终路径
  未通过链接的父目录逃出 configDir。
- **不跟随 symlink**：文件本身是 symlink/junction 即拒绝（状态 `symlink`），
  绝不解引用；父目录链接导致 realpath 逃逸的同样拒绝（`path-escape`）。
- **文件大小上限**：默认 1 MiB（`DEFAULT_EXTERNAL_CONFIG_MAX_FILE_BYTES`，
  可配 `maxFileBytes`，上限 64 MiB），超限拒绝而非截断、绝不哈希。
- **内容不出模块**：对外只有 sha256 摘要与字节数；缺失、超限、拒读都按
  fail-closed 计为 drifted=true（"无法验证"不等于"验证通过"）。
- 本包从不读取、复制或输出任何凭据；测试用的 auth/token 文件全部是本测试
  自造的 synthetic 样本。

已知平台注意（Windows）：创建文件 symlink 需要特权（本机实测 EPERM），
NTFS junction 不需要且 `lstat().isSymbolicLink()` 为 true，测试以
"文件 symlink 优先、junction 兜底"验证同一条拒绝路径；两者都建不出来时测试
显式失败（不 skip）。非 NTFS 文件系统上 junction 行为可能不同。

## 事务与一致性

- `createTaskRunWithProfileSnapshot` 把"绑定解析 + 建 `task_runs` 行 +
  写四条快照"包在同一个 `withTransaction` 里；任何一步失败（含 A01 拒绝、
  A29 拒绝、重复 runId）都不留下半套状态。
- 实体函数不自开事务，可在调用方事务内组合（沿用 store 约定；
  `withTransaction` 内嵌套会抛 `TransactionStateError`）。
- `initializeProjectRoleBindings` 幂等：重复执行不重置任何已有绑定。
- `role_bindings` 的 UNIQUE(project_id, role_id) 被直接篡改破坏时
  （测试用无约束表模拟），`resolveRoleBinding` 返回 `multiple` 而不是猜。

## 已知边界

- `node:sqlite` 在 Node 25 仍是实验特性（有 ExperimentalWarning）；engines
  为 `node >=25`，仅在 Windows + Node v25.0.0 验证。
- model 只是开放字符串期望值；实际兼容性由运行前能力探测负责（M0 语义），
  本包不做也不该做品牌推断。
- Profile 行没有更新 API——环境变化产生新 revision（不可变修订模型）。
- 漂移检测只在"检查那一刻"比较文件；两次检查之间的窗口不构成保证
  （执行前应再做一次，属于执行层 M1-03+ 的编排责任）。
- 深扫描守卫的深度上限 32 层是文档化的边界；schema 层的 strictObject 不受此限。
- 本包不实现 capability 探测、配额或并发锁（M2-02）；只提供 Profile 快照与
  其漂移事实。

## 验证

在本包目录：`pnpm build`、`pnpm typecheck`、`pnpm test`。
测试（107 条）覆盖：迁移重放/降级保护/全部约束、A01 五类拒绝与四角色
完备性、A03 未知角色、A02 类型层+运行时层、A29 全部路径形态与三方 target、
A34 快照不可变读取/完整性校验/绑定漂移含 model 变化/外部配置漂移
（修改、删除、未跟踪文件无关、凭据清单、超限、symlink 与逃逸）。
