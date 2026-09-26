# 发布流程

## 规划包与产品发布分开

当前包只验证文档、配置 schema、DAG 约束与负向测试。
不能给规划包贴上“产品已通过 Windows/Claude/Codex 联调”的标签。

## 公开仓库准备

确认工作名/仓库、维护账号、正式 LICENSE、版权归属与第三方清单。
将 .github/CODEOWNERS 的注释模板替换为真实账号。
配置安全私密报告渠道、main 保护、required checks 和人工发布审批。
规划阶段的 Python CI 不替代产品三平台 CI。

## 产品候选发布

冻结候选 SHA -> 运行完整测试矩阵 -> 核对 CLI/OS 兼容报告 ->
执行迁移/备份/恢复测试 -> 检查包内 secret ->
审查第三方许可与依赖锁 -> 更新 Changelog 和支持/限制声明 ->
维护者批准 -> 签名或发布校验摘要 -> 发布。

外部 Actions 使用已核查的不可变 commit SHA，更新时复核供应链。
CI 最小权限；不使用 pull_request_target 执行未信任代码。
真实 CLI smoke 在独立可信环境中运行，不把个人账号凭据给公共 runner。

## 回退

保留前一版本、数据库备份、迁移说明和兼容报告。
发生不可逆迁移时，不承诺简单降级；先停止调度并按备份恢复。
回退不能丢弃未交付 worktree、审批证据或未提交代码。
修复后重新审查恢复路径，不仅验证主流程。

## 发布检查

所有 release-blocking 验收通过；失败/未验证项不能伪装已支持。
README 和版本说明区分 implemented / experimental / unverified / unsupported。
费用不可用显示 unknown，沙箱不可用明确 Trusted-only。
