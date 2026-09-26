# @role-orchestrator/memory-search

M3-03 — 检索、sourceSha 过期与跨项目隔离。在 M3-02 `@role-orchestrator/memory`
之上补齐 `docs/MEMORY_AND_CONTEXT.md` 第 5/6 节的数据面：

- 检索（A15 前置）：AND 分词 + SQL LIKE 子串检索，仅覆盖授权项目内
  verified/active 记忆（可显式放宽状态）；
- 授权层（A15）：`openMemoryAccess` 绑定唯一授权项目，所有读取/检索/写入
  入口在查询层强制 `WHERE project_id = <authorized>`——不是结果过滤；
  跨项目 id 访问得到类型化 `CrossProjectAccessError`，错误信息与字段都
  不含对方项目 id 与内容；
- 过期（完整性）：记忆携带 `sourceSha`，`checkSources` 用解析器端口
  （内置 git 适配器）检查来源——SHA 缺失（`missing`）或被基线超越
  （`superseded`）时写入显式 stale 标记并留 `memory_source_checks` 审计；
- bundle 集成：`assembleContextBundleWithMemory` 把检索命中注入 M3-01
  装配器的新 `memory` 层（最低截断优先级），stale 默认排除、显式 opt-in
  时以 `[STALE MEMORY …]` 标注——旧证据绝不无提示复用。

## 选型说明

**独立包而非扩展 memory**：M3-02 的 memory 是生命周期 + 类型权限 + CAS 的
写入核心；检索、授权层、sourceSha 引用检查与 bundle 注入 glue 是另一组
关注点，且依赖 context 的装配器与 git 适配器边界。独立成包后依赖方向保持
无环（memory-search → memory → context → …），memory 的导出面保持精简，
其 A16 结构性测试（导出面无授权通道）继续成立。

**SQL LIKE 而非 FTS/影子索引**：LIKE 直接读权威 `memories` 表，不存在
索引漂移——漂移的文本索引会在安全敏感的检索路径上静默漏召回（假阴性），
比慢扫描更糟；`node:sqlite` 的 FTS 可用性还依赖 Node 构建项。分词语义：
查询按非字母/数字切分（Unicode 感知，CJK 短语整体保留），每个 token 都
必须命中（AND），ASCII 大小写折叠（SQLite 引擎限制，如实声明），LIKE
通配符按字面转义。向量/FTS 是文档声明的后续优化。

**stale 下游策略：默认排除 + 显式 opt-in 标注**：检索结果永远携带显式
stale 标记（标记而不隐藏）；装配默认排除 stale 记忆，`includeStaleMemories`
开启后逐条在内容前加 `[STALE MEMORY <id> v<n> reason=<reason>]` 响亮标注。
装配器内部还有结构性拒绝（未开 opt-in 时直接抛
`StaleMemoryNotAdmittedError`），双保险。

## 授权层

- `openMemoryAccess(db, { projectId })`：项目不存在即 fail-closed；
- 检索/列表 SQL 恒带 `WHERE project_id = ?`（授权项目），外来行在结构上
  不可表达；
- 直接 id 读取/更新先走作用域查询；id 存在于其他项目时抛
  `CrossProjectAccessError`——存在性探测不读取任何列，错误只携带授权
  项目与请求 id，无外泄侧信道；
- 拒绝无副作用：不会把审计写入对方项目（那本身就是一次跨项目写）。
  边界说明：本层强制的是记忆数据面的项目 scope；actor/角色权限仍由
  M3-02 的冻结可提交者矩阵把守，内容（A16）不参与任何授权判断。

## sourceSha 与过期

- `attachSource`：(memoryId, expectedVersion, sourceSha, source_sha IS NULL)
  守卫的幂等写入；同 SHA 重挂幂等，异 SHA 冲突可见
  （`MemorySourceAttachConflictError`），stale 版本是 CAS 冲突。
  provenance 是元数据：不 bump version、不进 revisions，M3-02 的 CAS
  与历史语义原封不动；
- `checkSources`：先在事务外逐个调解析器（git spawn 不进 BEGIN IMMEDIATE），
  再单事务落 stale 标记与审计行；`missing` / `superseded` 置标记，
  `current` 清除标记；每次检查追加 `memory_source_checks`；
- `createGitSourceResolver(repoRoot)`：`spawnSync(git, argv数组)`、显式
  cwd、无 shell 字符串；`cat-file -e` 判存在，`rev-parse HEAD` 给基线。

## 迁移

`MEMORY_SEARCH_MIGRATIONS = MEMORY_MIGRATIONS + 009 + 010`：

- 009：`memories.source_sha / stale_since / stale_reason` 列 +
  `memory_source_checks` 审计表 + 部分索引；
- 010：`bundle_fragments` 前向重建（SQLite 无法原地放宽 CHECK，而已发布
  的 007 的 sha256 记录在 schema_migrations 中、绝不允许改写），列与既有
  行逐字节保留，CHECK 扩宽以容纳 `memory` / `memory_entry` 行。注入 bundle
  的持久化只能在 010 之后的链上进行。

## 测试

`pnpm test`（turbo 登记）：A15 三路径拒绝与无泄漏、检索正确性（命中/
未命中/分词边界/大小写/通配符/状态与类型过滤）、stale 矩阵（端口层 +
真实 git fixture 仓库的适配器层）、注入 bundle 的可追溯与截断保规则、
A16 注入矩阵延伸到检索与装配链路、迁移链与前向重建。
