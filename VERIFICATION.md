# 交付物验证

## 实际执行

执行了 `python scripts/validate_bundle.py --self-test`。
7 份 JSON Schema 的元定义检查、7 个示例配置、跨文件引用、DAG、
Backlog 依赖与文档内部链接检查通过。
37 项自测通过，其中 36 项为预期拒绝非法/危险输入，1 项确认模型 ID 可开放配置。
机器可读结果由 `python scripts/validate_bundle.py --self-test --json-output validation-report.json`
按次再生；该生成物不入库（.gitignore），冻结清单也不登记其哈希。

TypeScript 契约通过以下实际编译检查，编译器版本 5.8.3，退出码 0：

```bash
tsc --noEmit --strict --target ES2022 --module NodeNext --moduleResolution NodeNext contracts/runtime.ts
```

检查环境中的规划工具依赖为 PyYAML 6.0.3、jsonschema 4.26.0。
它们不是产品 TypeScript 运行时依赖，也不表示选定了产品的最终依赖版本。

## 没有执行

未运行真实 Claude/Codex CLI，没有使用用户账号，没有访问用户本地仓库。
未验证 Windows/WSL/macOS/Linux 的真实沙箱、子进程终止、认证隔离或模型兼容性。
未运行产品级 unit/integration/E2E，因为本包不包含该应用实现。
未向 GitHub 创建仓库、提交、Issue 或 PR；CI 文件也尚未在目标 GitHub 仓库运行。
未对参考项目源码/许可证做完整审计；本包采用独立实现规划。

## 交付边界

Apache-2.0 为候选文本，尚未作为正式 LICENSE 采用。
CODEOWNERS 是注释模板，维护账号和安全报告渠道必须在公开发布前填写。
CLI/第三方模型支持情况必须在 M0 获取实际证据后发布。

[文件清单](MANIFEST.md) 和 [文件校验摘要](CHECKSUMS.sha256) 可用于核对交付内容。
