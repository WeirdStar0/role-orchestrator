# ADR 008：Local Web 与 TypeScript 模块化单体

状态：Accepted：用户已确认
日期：2026-09-21

## 背景
需要管理长生命周期 CLI 与本地文件，不先承担桌面分发和团队服务复杂度。

## 决策
React/Vite UI + Fastify daemon + CLI；pnpm/Turbo；模块接口分离。

## 后果
需要独立本地鉴权、Host/Origin 防护与平台 supervisor；不是任意网页可调用的服务。

## 未采用方案
Next.js 全栈耦合、首版 Electron/Tauri、过早微服务不采用。

## 验证与重新评估
桌面壳与 Remote Worker 后续复用接口，不重写领域核心。

参考：[需求基线](../REQUIREMENTS_BASELINE.md)、[外部证据](../SOURCES.md)。
