# 契约草案

runtime.ts 是无外部依赖的 TypeScript 接口草案，不含实现，不调用 CLI。
TaskNodeDefinition 没有 model/Profile 字段；ExecutionRequest 中的 resolvedProfile
只能由可信应用代码从 TaskRunSnapshot 解析，不能来自用户节点覆盖。

M0 应把这些接口迁入 packages/contracts 并与 Zod/JSON Schema 统一生成，
避免手工维护两套契约漂移。
静态类型不代替运行时校验，也不证明任何 sandbox 或认证能力已实现。
