# Git、工作树与代码集成

## 目标与边界

工作树属于 Execution，不属于永久角色。TaskRun 有受管 integration 分支，
每个写入型 Execution 有独立分支与 worktree。
原始用户工作目录不作为 Agent 写入目录；用户已有未提交修改不被 stash/reset/clean。
Git worktree 共享部分仓库元数据，因此不等于权限隔离，见 [S04](SOURCES.md#s04)。

```text
main at pinned baseSha
  task/<run-id>                         # IntegrationService owns writes
    exec/<run-id>/<node-id>/<attempt>    # one writer, one worktree
```

## 准备阶段

验证仓库根目录、execution target、Git 可用性、目标基础 SHA 和工作树路径。
dirty 用户目录可继续保留，但本次任务基于选定 commit，不包含未提交修改；
要把这些修改作为输入，必须由用户显式创建基线或受控导入 patch。
生成工作树时不覆盖同名分支，不使用强制 checkout，不擅自更新 submodule/LFS。

worktree 位于用户数据目录或用户选择的短路径，不放在会被 Agent 扫描/提交的源目录内部。
处理 Windows 空格、中文、长路径、大小写、junction、不同盘符；
禁止混用 Windows Git 和 WSL Git 管理同一执行工作树。

## 读者与测试

Coordinator/Architect 使用固定 SHA 的只读快照，不读取正在变化的 integration 工作目录。
Reviewer 绑定不可变 candidateSha。测试运行在 disposable validation workspace，
允许写入临时文件、缓存、coverage 和编译产物，但不允许修改被审查源码。
执行测试脚本本身可能产生副作用，仍受执行策略和信任模式约束。

## 依赖代码基线

节点声明“依赖某节点”意味着同时依赖其数据产物和明确的代码输出。
多父节点合流时，Git Service 按拓扑顺序组合已接受的父输出 commit set，
创建并记录可复现 inputSha，不能简单从 main 启动后继。
没有代码修改的节点沿用 inputSha。
兄弟节点并发修改同一文件可以隔离写入，但最终仍可能冲突，不能声称绝无冲突。

## 提交与集成

Agent 修改代码并给出摘要，受控 Git Service 检查路径、secret 扫描与 diff，
仅提交允许的文件。默认不由 Agent 直接写共享 Git refs 或执行任意 Git 管理命令。
每个 Execution 提交后记录 outputSha、inputSha、diff hash。

IntegrationService 是 task 分支唯一写入者：
认领 integration lease -> 校验目标旧 SHA -> 按既定顺序合并候选输出 ->
保存集成记录与新 candidateSha -> 触发 Reviewer。
若分支头与预期不符则停止，不能强制覆盖。
系统管理的 Git 操作同样可能触发 hook；必须禁用未经信任的 hooks 或走显式可信配置。

## 冲突与返工

发现冲突时保留现场与冲突清单，暂停集成；不自动采用 ours/theirs 丢弃代码。
创建 Developer 修复节点，沿用角色 Profile，明确限定冲突文件与验收条件。
修复产生新 commit，重新集成与审查。
审查报告必须绑定 candidateSha，候选代码变化后旧通过结果失效。

## 交付和清理

默认交付是 task 分支、diff、测试报告与使用说明，不自动更改 main。
用户接受合入 main 时，确认目标旧 SHA、展示最终 diff，并保持可回退记录。
首版不 push、开 PR/MR 或部署；后续 SCM Adapter 单独获得授权。

只有已完成、已归档、没有未提交修改且没有活动引用的 worktree 可自动清理。
中断/失败/待审批工作树默认保留。清理先 dry-run 展示，再执行受管路径内删除。
分支和工作树不是运行时沙箱；可信模式下同一 OS 用户仍可能访问其他目录。
