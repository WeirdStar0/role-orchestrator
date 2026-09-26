# ADR 005：SQLite 状态表与事务 outbox

状态：Accepted：存储方向已确认，事务实现为工程默认
日期：2026-09-21

## 背景
首版单用户本地 daemon，需要持久化和故障核对，但不需要分布式数据库。

## 决策
SQLite 元数据/状态，文件存大产物，Git 存代码；状态变更与 outbox 同事务。

## 后果
进程/Git/文件操作不与 DB 原子，需要幂等键、manifest 与 reconcile。

## 未采用方案
全量 event sourcing 和 PostgreSQL 集群推迟，不以复杂架构替代恢复测试。

## 验证与重新评估
未来远程控制平面可更换存储实现，保持核心状态机语义。

参考：[需求基线](../REQUIREMENTS_BASELINE.md)、[外部证据](../SOURCES.md)。
