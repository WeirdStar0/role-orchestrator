# @role-orchestrator/contracts

M0-01 公共契约包。包含两层内容：

1. `src/runtime.ts`：从规划包 `contracts/runtime.ts` **逐字节原样迁移**的接口草案
   （纯类型，无实现、不调用 CLI）。仓库根的 `contracts/runtime.ts` 是冻结文件，
   本包内的副本是唯一的代码化形态。
2. `src/schema/`：与冻结的 7 份 JSON Schema（`schemas/*.schema.json`）一一对应的
   Zod schema 及其推断类型，覆盖 `config/` 下 7 份示例配置文件协议：
   profiles、roles、workflows、policies、project、task-request、execution-result。

静态类型不替代运行时校验：所有跨越信任边界的输入必须经 Zod schema 解析；
未知字段一律拒绝（所有对象均为 strict）。

## 防漂移机制

契约、JSON Schema 与 Zod 三者依靠以下机制保持一致，任何一侧单独漂移都会使
`pnpm typecheck` 或 `pnpm test` 失败：

1. **正例锁定**：`test/examples.test.ts` 将仓库冻结的 7 份示例（`config/*.yaml|json`）
   逐一喂给对应 Zod schema。示例文件或 schema 任何一方语义变化导致不兼容即失败。
2. **负例清单**：`test/rejection.test.ts` 按名对照 `scripts/validate_bundle.py`
   的自测用例（该脚本本身不被修改），覆盖：
   - 节点/工作流/任务请求出现 `profileId`、`model`、`profiles` 等覆盖字段
     （`node_profile_override`、`node_model_override`、`node_profiles_array`、
     `workflow_profile_override`、`workflow_catalog_model_override`、
     `task_profile_override`、`task_model_override`）；
   - 角色多选（`role_multiselect`）、未知角色（`unknown_role`）、缺角色；
   - 隐式 profile fallback（`implicit_profile_fallback`）；
   - `extraArgs` 携带 `--model` 或 `--dangerously-skip-permissions`
     （`args_model_override`、`args_skip_permissions`）；
   - 审查结论引用不存在的证据产物即不得判成功（`missing_review_evidence`，
     由 `ExecutionResultSchema` 的语义校验实现）；以及事实类记忆缺证据、
     未知字段自审批、安全策略常量被削弱、未知顶层字段（strict）、重复 YAML 键。
3. **类型层断言**（编译期，`tsc` 在 typecheck 与 build 时都会执行）：
   - `TaskNodeDefinitionIsFreeOfOverrides`：若 `TaskNodeDefinition`（或 Zod 推断
     类型）上出现 `model`/`profileId`/`profiles`/`fallback*` 等字段名，编译失败；
   - `TaskNodeSchemaInferenceSatisfiesRuntimeContract`：Zod 推断的节点形状可赋值
     给迁移接口，schema 侧不得新增契约之外的字段或放宽类型；
   - `RoleIdSchemaMatchesContract` / `ExecutionTargetSchemaMatchesContract`：
     枚举与 `runtime.ts` 联合类型严格相等。
4. **运行时镜像检查**：`test/types.test.ts` 校验解析出的示例节点键集合不含任何
   覆盖字段名，且 `TaskNodeSchema` 对带 `model` 的对象在运行时拒绝。

## 与 validate_bundle.py 的分层边界（有意不做的事）

以下检查属于**跨文件/束级语义**，Python 脚本在整束校验时执行；单文档 Zod schema
不做复制，留给应用层（M1 起的绑定解析/图校验）实现，避免同一规则维护两份半：

- Profile 绑定是否存在（`unknown_profile`）、Profile/Project 执行目标一致
  （`mixed_execution_targets`）、重复 Profile/节点/工作流 ID、
  环依赖/自依赖/未知依赖、深度与节点数预算
  （`cycle`、`self_dependency`、`unknown_dependency`、`node_budget`、
  `depth_budget`、`duplicate_*`）、`canCreateSubtasks` 需要 `dag.propose`、
  非 developer 角色不得 `repo.write`、workflowId 交叉引用
  （`unknown_requested_workflow`）、reviewer 加 `repo.write`（`reviewer_source_write`）。
- JSON 重复键检测：`JSON.parse` 与 Python 的 `object_pairs_hook` 不同，会静默
  覆盖重复键。当前 7 份示例中 `.json` 仅两份且由版本控制锁定；该检测留待
  配置加载器实现（M1）时补充。

## 已知类型差异（非漂移）

`runtime.ts` 的 `TaskNodeDefinition.capabilityTags` 是 `readonly string[]`（冻结
文件），而 JSON Schema/Zod 将其约束为 8 个已知标签（窄类型）。因此节点 schema 与
接口之间使用「推断可赋值给契约」的单向断言而非严格相等/双向可赋值；接口侧新增
覆盖字段仍由 `TaskNodeDefinitionIsFreeOfOverrides` 拦截，运行时由 strict 拒绝。
枚举与角色/执行目标联合类型仍用严格相等断言。

## 命令

- `pnpm typecheck`（turbo 聚合各包 `tsc -p tsconfig.json`）
- `pnpm test`（vitest run）
- `pnpm build`（输出 `dist/`，NodeNext ESM + 声明文件）

`packages/*` 的 workspace 布局为后续包（如 M0-02 的 fake-cli）预留位置。
本包不包含任何 CLI 调用、认证读取或真实模型联调。
