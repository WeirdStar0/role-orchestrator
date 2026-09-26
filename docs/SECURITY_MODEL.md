# 安全模型

## 信任级别

用户与维护者拥有最终配置/授权权。Agent 输出、仓库内容、依赖脚本、MCP 返回、
外部网页以及 CLI 插件均不是权限来源。
项目本地文件不能通过修改 roles/policies/AGENTS 等内容自行提升正在执行任务的权限。
配置导入需要用户确认；运行使用冻结快照并检测宿主配置漂移。

Local Trusted：仅用于用户确认可信的仓库，提供进程管理、受控目录与 CLI 已验证权限。
不宣传能抵御恶意同用户进程或任何恶意仓库脚本。
Hardened：必须具备经过实测的 OS/容器文件与网络约束，否则该模式不可选择。
Windows 不同 CLI 的沙箱能力不同，见 [S05](SOURCES.md#s05)、[S06](SOURCES.md#s06)。

## 授权规则

有效权限是用户授权、项目策略、角色权限、Execution 范围和 CLI/OS 能力的交集。
v1 的源码写入权限上限仅授予 Developer；其他角色只读源码，Reviewer 可运行受控测试。
子任务创建同时需要角色 canCreateSubtasks 和 dag.propose 权限。
deny 优先；Unknown 能力不视作允许。默认禁止修改系统安全设置、访问非授权凭据、
force push、修改生产资源和越过审批进行远程写入。

风险分级是业务决策机制，不是 shell 命令名称白名单：
低风险：已授权范围内的只读分析、受控局部修改。
中风险：有替代方案的技术选择，由 Coordinator 记录决定。
高风险：权限提升、广泛网络访问、外部副作用、主分支交付、不可逆删除，由用户批准。
中风险决定若包含新权限，也必须走用户授权，Coordinator 不能自批提权。

`pnpm test`、`npm install`、`git status` 等命令不能无条件归类为安全。
脚本、lifecycle hooks、git 配置或工具链可能启动其他程序。
只做字符串前缀判断无法成为安全沙箱；终端执行必须依赖已验证的控制面或明确可信模式。

## 人工审批

Approval 绑定 action digest、目标路径/仓库、baseSha、Profile revision、
权限增量、过期时间与一次性消费状态。
批准一个精确动作不等于长期放行该 CLI，也不等于允许所有网络/文件操作。
被批准动作或代码基线改变，原审批失效。
UI 显示动作、影响面、可撤销性、证据与操作主体，拒绝诱导式“一键全部同意”。

## 进程与文件

普通工具启动使用 executable + argv，不把用户文本传给 shell 拼接。
Windows `.cmd`/`.bat` 走专门受信任启动器，覆盖 metacharacter、空格、Unicode 路径测试。
终止任务必须覆盖子进程树，不只 kill 顶层 PID。
daemon 崩溃后的未知残留进程先 reconcile，再决定是否可重试。

对路径执行规范化、授权根目录校验、符号链接/junction 检查与写入时再验证。
对不具备可靠文件系统边界的平台，不声称这些检查完全消除了 TOCTOU 风险。
共享 Git common dir、用户 HOME、CLI 凭据目录和系统配置禁止暴露为通用可写目录。

## 本地 Web 安全

默认只监听 loopback，不默认监听 0.0.0.0。
localhost 不是免鉴权理由：API 与 WebSocket 必须认证，校验 Host/Origin，
限制 CORS，使用同站会话和 CSRF 防护，防止外部网页调用本地执行接口。
会话 Token 不放在日志、仓库、普通 URL 查询参数中，不注入每个 Agent 的环境。
本地连接引导使用短期一次性令牌；连接建立后使用受保护会话。
结果 Markdown/HTML/终端 escape sequence 必须经过消毒，禁止直接执行产物 HTML。

## 凭据、数据与日志

Profile 不保存明文 Token/password；只保留 CLI 配置 locator 或 secret 引用。
读取 CLI 身份时只显示可安全确认的摘要，不解析并回传整个 auth 文件。
向子进程传环境时使用批准集合；不把所有宿主凭据泄露给测试和构建脚本。
日志在落盘前脱敏，导出诊断二次扫描；无法可靠脱敏的字段直接省略。

跨角色共享不等于跨项目共享；跨项目查询必须显式授权。
本地 UI、DB 与日志虽在本机，CLI 仍可能将提示词和代码发送到外部模型服务。
首次运行展示所用 Profile、服务端类型与发送数据范围。
产品自己的遥测默认关闭，CLI 自身遥测/保留政策单独说明。

## 开源供应链与商业边界

MCP/Plugin/CLI 自带 hooks 要求信任清单、版本/fingerprint 和受控启用。
公共 PR CI 不载入真实模型凭据、不调用用户认证 CLI，不运行 privileged workflow。
商业版不默认共享个人订阅 Profile。多用户调度、远程 secrets 与租户隔离需独立威胁建模。
开源版保留安全日志和执行审计，商业组织审计仅是集中化增强。
