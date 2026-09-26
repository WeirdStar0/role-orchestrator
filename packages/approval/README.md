# @role-orchestrator/approval

M4-01 风险分级与一次性审批。审批是权限的最小单元：一个审批只授权一个精确动作，动作的任何要素变化即不可消费（A17），批准只能消费一次（A18），无 interactiveApproval 的 CLI 不伪造中途暂停（A19）。

## 模块

- `src/risk.ts` — 动作描述符（strict schema）与分级。维度为封闭枚举（`readonly` / `write` / `network` / `delete` / `external-side-effect` / `main-branch-delivery`），写入维度必须声明 `writeScope`。规则来源：`docs/SECURITY_MODEL.md` 风险分级（低：授权范围内只读分析与受控局部修改；中：有替代方案的技术选择，Coordinator 记录；高：权限提升、广泛网络访问、外部副作用、主分支交付、不可逆删除）与 capability-gate 注册表。未知能力/未验证能力一律高风险（unknown 拒绝）；`requiredControl: "forbidden"` 的 argv 模式在创建审批时直接拒绝，无 v1 授权路径。
- `src/digest.ts` — `actionDigest`：完整 argv（含 argv[0]，顺序语义）、目标仓库 root+baseSha+targetSha、工作目录、派生权限增量集合、Profile revision、维度与所需能力 id 做 canonical JSON（键排序、数组保序）后取 sha256。纯函数，测试钉住。
- `src/migration.ts` — 迁移 011（`approvals` 表），链式组合 `APPROVAL_MIGRATIONS = MEMORY_SEARCH_MIGRATIONS + 011`。
- `src/lifecycle.ts` — `PENDING -> APPROVED -> CONSUMED`（另有 `PENDING -> REJECTED/EXPIRED`），全部守卫式 CAS UPDATE：批准守卫过期时间；消费守卫 status+digest+过期；同 idempotency key 重放返回同一行，键复用但动作变化则报错（A18）。过期审批不可消费。

## A19 边界

无人值守写入映射到 capability-gate 的 `node-checkpoint` 控制（两个运行时各有注册表假设）。本包不提供也不模拟“CLI 中途暂停等待审批”的语义：审批在执行前绑定精确动作，消费发生在受控检查点。

## 依赖边界

分级只读取 `@role-orchestrator/capability-gate` 的纯查询函数；本包不执行任何命令、不读取凭据、不拦截运行时。执行层的接入（检查点、有限续行）属于 M4-02。
