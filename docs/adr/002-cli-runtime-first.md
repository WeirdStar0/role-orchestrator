# ADR 002：首批仅支持 Claude/Codex CLI

状态：Accepted：用户已确认
日期：2026-09-21

## 背景
用户要复用 CLI Agent 与其登录环境，而不是直接集成模型 HTTP API。

## 决策
通过非交互结构化协议适配 CLI；每平台/版本能力探测；认证由 CLI 管理。

## 后果
第三方模型兼容性逐 Profile 验证；不承诺任意网关或账号隔离天然成立。

## 未采用方案
直接 API 后端会另造工具执行与 agent loop，当前不采用；TUI 文本抓取不是主协议。

## 验证与重新评估
需要持久双向审批时，可对 app-server/SDK/桥接另立 ADR。

参考：[需求基线](../REQUIREMENTS_BASELINE.md)、[外部证据](../SOURCES.md)。
