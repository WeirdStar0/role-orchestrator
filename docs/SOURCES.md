# 外部证据与核实记录

核实日期：2026-09-21。仅用于说明外部 CLI/Git 当前公开能力。
设计决策、里程碑、默认值均为本项目方案，不是这些供应商的承诺。
网页会变更；实现时须保存实测 CLI version、OS、fixture hash 和复核日期。

## S01

Claude Code — Run Claude Code programmatically：
https://code.claude.com/docs/en/headless

依据：`claude -p`、结构化输出、stream-json、输入输出和会话入口。
非交互权限与认证加载方式依模式而变，不假定能统一拦截每个工具。
本文档包只依赖这些最小入口事实，其余安全集成仍需 M0 实测。

CLI reference：
https://code.claude.com/docs/en/cli-reference

## S02

OpenAI Codex — Non-interactive mode：
https://developers.openai.com/codex/noninteractive
（核实时官方页面重定向到 https://learn.chatgpt.com/docs/non-interactive-mode）

依据：`codex exec`、JSONL 事件、非交互默认权限与显式 sandbox 配置。
不根据 CLI exit code 单独认定产品级任务成功。

## S03

Claude Code settings：
https://code.claude.com/docs/en/settings

Codex advanced configuration：
https://developers.openai.com/codex/config-advanced

依据：CLI 配置/状态位置、CODEX_HOME、自定义 provider 等配置能力。
这些说明不能代替多账号系统凭据隔离测试。
Claude LLM gateways：
https://code.claude.com/docs/en/llm-gateway

网关和协议兼容是接入前提，不能推出任意第三方模型都可运行。

## S04

Git worktree：
https://git-scm.com/docs/git-worktree

依据：linked worktree 有独立工作目录/索引等，但共享部分仓库数据与配置。
本项目因此将 worktree 与执行安全边界分开设计。

## S05

OpenAI Codex Windows sandbox：
https://developers.openai.com/codex/windows
（核实时重定向到 https://learn.chatgpt.com/docs/windows/windows-sandbox）

依据：Windows 有不同强度的沙箱实现，必须按实际模式验证；
不能把一种 CLI 的能力推及另一种 CLI。

## S06

Claude Code sandboxing：
https://code.claude.com/docs/en/sandboxing

依据：沙箱属于 CLI/平台相关能力；本项目能力矩阵必须逐环境核实。

## S07

参考项目 README：
https://github.com/JqyModi/codex-multi-launcher/blob/main/README.md

本次通过 GitHub 连接读取默认分支 README，blob SHA：
`252da0cdac7ccba4cf5044e0ab185c72ce98da0b`。

README 描述多桌面 Profile、账号/模型配置与部分历史同步。
本项目借鉴其 Profile 管理问题域，但采用独立 CLI 编排架构。
本次未完成该仓库源码/许可证审计，不复制其实现或假定复用授权。

## S08

Apache License 2.0 官方文本：
https://www.apache.org/licenses/LICENSE-2.0.txt

Developer Certificate of Origin：
https://developercertificate.org/

许可证为候选，DCO 为建议贡献声明流程。
DCO 不等于版权转让，也不自动授权未来改为另一种许可证。
发布前由维护者核查适用情况；本包不是法律意见。
