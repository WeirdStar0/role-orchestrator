# Profile、角色与模型

## Profile 的含义

Profile 是本机 CLI 运行环境，不是账号明文凭据，也不等于模型。
字段包括 runtime、executable、executionTarget、configDir、model、
非敏感参数、超时、并发和凭据组引用。
角色选 Profile；Profile 选择 CLI 支持的模型配置。

同一个 Claude 或 Codex Profile 可绑定多个角色。
每次 Execution 新建独立上下文/session（有明确恢复需求时才使用限定 session ID）。
不使用 `--continue` 或 `--last` 这种可能误接其他任务的全局快捷续接作为默认实现。

## 模型开放性与兼容性

`model` 为开放字符串，`null` 表示使用 CLI 本身的默认值。
用户可以配置任何 ID，但运行前需要完成实际兼容探测：
认证成功、模型可达、文本流可解析、工具调用可工作、权限可落实、输出能验证。

GLM、DeepSeek 等只能在所选 CLI 和服务商/网关协议实际兼容后启用。
填入一个模型名不会让不兼容的 API 自动兼容。
首版不实现直接 API Provider，不以中转网关伪装为已认证支持。
界面同时显示 requestedModel 与 observedModel；观测不到就标记 unknown。
不根据品牌静态推断价格、窗口大小或模型能力。

`model: null` 是示例默认，不代表可完全复现的模型版本。启动时应尽可能解析实际模型并记录，可显式固定时转为本 run 的有效模型约束；无法固定时 UI 显示 CLI-managed/非精确可复现。模型别名和供应商内部变化不在 Orchestrator 的完全控制范围内。可观测到的意外主模型切换应暂停并记录，不把 CLI 内部 fallback 当成允许的产品选模策略。

## 认证与目录

Codex 的状态目录配置和 Claude 的目录配置已有官方说明，见 [S02/S03](SOURCES.md)。
但配置目录分开不证明所有平台的 OS credential store 都分开。
每个 Profile 的 credentialIsolationStatus 默认为 unverified；
只有在特定 OS + CLI version 上完成双账号登录/刷新/退出互不干扰测试才标记 verified。

Orchestrator 允许用户在自己的终端完成 CLI 登录，不读取、复制、导出 auth 文件或 OAuth Token。
启动服务时不把用户 shell 的整个环境无条件传给 Agent；使用批准的环境变量集合。
非敏感 endpoint 可保存；secret 只能由 CLI 配置、OS credential store 或受控 env 引用提供。
`extraArgs` 不能被用于绕过 model、sandbox、approval、resume 或角色绑定策略。

## Project 绑定与快照

项目设置保存四个 RoleBinding。
用户修改绑定后，UI 提示“仅影响新 TaskRun”。
Profile 升级、模型变更或 CLI 二进制路径变化产生新 revision；
正在运行的 TaskRun 不悄悄使用新 revision。

执行前记录 CLI 路径、binary/version fingerprint、配置 hash、模型请求值、
权限能力和受信任外部配置清单。检测到宿主 CLI 配置被外部修改，暂停该 Profile 等待确认，
避免仅冻结数据库但执行时读入已经改变的用户配置。

## 能力探测

CapabilityReport 至少包含：
streaming、structuredOutput、resumeSession、interactiveApproval、
filesystemBoundary、networkBoundary、processTreeTermination、
nativeDelegationControl、credentialIsolation、modelSelection、externalConfigControl。

每项为 verified / unsupported / unverified，并附 evidenceRef、
CLI version、OS、probe time。能力不能由用户编辑 JSON 后直接变为 verified。
功能所需的强约束为 unverified 时拒绝执行该模式；
可显式选择仅用于可信仓库的 Local Trusted 模式，界面不能显示强沙箱图标。

## 并发与限制

保留 Global=4、Project=3、Profile=2 的初始配置。
如果同一个 credentialGroup 无法安全并发刷新，则有效并发进一步受认证锁限制。
限流先冷却原 Profile；不得自动切换个人/团队账号规避限额。
不同订阅、API 权限与商业使用资格需要在发布前逐一核对，不能把个人订阅当团队共享池。
