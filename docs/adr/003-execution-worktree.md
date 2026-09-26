# ADR 003：Execution 工作树与单 writer 集成

状态：Accepted：隔离方向已确认，细节为工程默认
日期：2026-09-21

## 背景
复杂 DAG 中同角色可并发；按角色永久工作树会混入旧任务。

## 决策
每写入 Execution 独立工作树；task 集成分支由 Git Service 单 writer；inputSha 固定。

## 后果
需处理多父基线、冲突、清理与共享 Git metadata；worktree 不是 sandbox。

## 未采用方案
所有 Agent 共用一个目录不可取；每 Task 一个工作树不能隔离并行 writer。

## 验证与重新评估
M0/M2 验证 Windows 路径与 Git 权限；失败不得降级为共享可写目录。

参考：[需求基线](../REQUIREMENTS_BASELINE.md)、[外部证据](../SOURCES.md)。
