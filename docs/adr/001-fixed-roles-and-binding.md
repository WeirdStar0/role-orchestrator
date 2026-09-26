# ADR 001：固定四角色与单 Profile 绑定

状态：Accepted：用户已确认
日期：2026-09-21

## 背景
职责应稳定，模型与认证环境经常变化。用户明确不允许节点覆盖。

## 决策
四角色固定；Project RoleBinding 单选 Profile；运行冻结 revision；无任务/节点覆盖。

## 后果
不实现任意角色编辑器、不自动选模或 fallback。同一角色可以启动多个 Execution。

## 未采用方案
允许节点覆盖会使权限、预算和可追溯性复杂化，当前明确不采用。

## 验证与重新评估
若未来需要覆盖，应新增用户需求和 ADR，旧 run 保持原语义。

参考：[需求基线](../REQUIREMENTS_BASELINE.md)、[外部证据](../SOURCES.md)。
