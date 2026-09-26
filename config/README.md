# 配置说明

本目录是拟定 v1 配置协议的示例，已配备 Schema 静态校验；不是已实现产品的安装配置。
示例 Profile 是占位，未使用用户本机账号。`model: null` 表示沿用 CLI 默认模型；
可填写开放模型 ID，但必须经过所选 CLI 的兼容验证。

## 文件

profiles.example.yaml：CLI 路径、execution target、配置目录、模型和资源约束。
roles.yaml：项目内四角色单选绑定及是否可以创建子任务。
workflows.yaml：复杂 DAG 示例；前后端同属 Developer。
policies.yaml：并发、尝试/返工上限、权限和费用未知时的行为。
project.example.yaml：配置入口，`${REPO_ROOT}` 必须由用户选择真实路径。
result.example.json：人工构造的结果协议样本，不是真实测试报告。
task-request.example.json：任务创建协议示例，不包含模型/Profile 覆盖。

`${HOME}`、`${REPO_ROOT}` 是未来配置加载器的受控变量，不能交给 shell 展开。
当前静态校验只校验结构，不访问这些目录、不登录 CLI、不验证模型可用性。
实际产品 M0/M1 应把确认后的 Profile 放在用户数据目录；不把 CLI credential 复制进仓库。

## 配置优先级

只存在 Project RoleBinding -> ProfileRevision。不存在 Workflow/Task/Node 覆盖。
用户更改绑定只影响新 TaskRun。模型不得通过 extraArgs 偷换。
v1 的 extraArgs 只接受空数组；确有需要的参数通过后续 Adapter 白名单扩展，
不开放能覆盖 model/approval/sandbox/resume 的任意字符串通道。

示例两开发节点同时使用 codex-main。
并发上限为 2，但未验证凭据隔离/刷新安全时受 credentialGroup=1 进一步约束；
不能为了展示并行而跳过认证安全测试。

## 共享上下文

依赖自动意味着消费上游 Artifact 与代码基线；具体 SHA/产物由系统装配，不由模型自填。
多父合流的 Git integration 为系统步骤，不新增用户角色。
review verdict=fail 可以是一次正常完成的审查 Execution，
但不代表质量通过：它触发有限修复扩图，TaskRun 不能因此交付。

## 安全语义

schema 字段不是执行沙箱。`local-trusted` 明示这是用户信任代码的执行模式。
`unknownRequiredCapability: deny` 表示任何声称必需的能力未经验证都不能执行。
`allowUnknownMonetaryCost: true` 允许在明确标注 unknown 的情况下按执行次数/时长继续，
不是将不可获取的费用记成 0，也不绕过供应商配额。
