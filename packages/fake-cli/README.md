# @role-orchestrator/fake-cli

SYNTHETIC 双方言 Fake CLI：`fake-claude` 与 `fake-codex`。用于在 PR CI 与本地
测试中模拟两种 CLI 的流式 JSONL 事件协议、错误、截断、超时、子进程与中断。

**这不是真实的 claude/codex 可执行文件。** 事件形状是依据公开文档写的
synthetic 近似实现；与真实协议的逐字节校验要到 M0-03（Claude）/M0-04（Codex）
联调才能完成。本包不读取任何凭据，也不会调用真实 CLI。

## Synthetic 标记（强制）

- 每行 JSON 事件都包含 `"synthetic": true` 字段；
- 进程启动时向 stderr 打印 `SYNTHETIC EVENT STREAM — …` 声明；
- 包名 `@role-orchestrator/fake-cli` 与 bin 名 `fake-claude` / `fake-codex` 都含 `fake`；
- 预生成样本文件名一律带 `.synthetic.jsonl` 后缀（`fixtures/`）。

## 用法

```bash
node dist/bin/fake-claude.js --scenario success
fake-codex exec --json --scenario error-result   # 真实形态参数被接受并忽略
```

参数（严格解析，未知参数以退出码 2 拒绝）：

| 参数 | 说明 |
|---|---|
| `--scenario <name>` | 必填。`success` / `error-result` / `truncated` / `fake-success` / `timeout` / `grandchild` / `interrupt` |
| `--variant <v>` | `fake-success` 的变体：`error-final`（默认）/ `missing-final` / `schema-invalid` |
| `--delay-ms <n>` | 事件行之间的延迟（默认 0） |
| `--interrupt-on <mode>` | `signal`（默认，POSIX 生效）或 `stdin-close`（Windows 用） |
| `--emit-fixture <path>` | 把确定性 stdout 帧写入文件后退出（grandchild 场景拒绝） |
| `-h, --help` | 帮助 |

真实 CLI 形态的参数（`-p`、`--output-format`、`--verbose`、`--model`、`exec`、
`--json`、`--skip-git-repo-check` 等）被接受并忽略，便于把 fake 放在真实调用
形态的位置上做测试。

## 场景与退出码

| 场景 | 行为 | 退出码 |
|---|---|---|
| `success` | 正常流式至最终 result 事件 | 0 |
| `error-result` | error 事件 + 结果标记错误 | 1 |
| `truncated` | 末行 JSON 截断（故意以 exit 0 收尾，验证解析层而不是退出码兜底） | 0 |
| `fake-success` | exit 0 但最终结果 error（默认）/ 缺最终事件 / 业务 schema 非法 | 0 |
| `timeout` | 输出部分事件后永久挂起，直到被外部终止 | 由终止方决定 |
| `grandchild` | 先 spawn 子进程、子进程再 spawn 孙进程，事件中报告两个 PID，然后挂起直到被杀 | 由终止方决定 |
| `interrupt` | 收到 SIGINT/SIGTERM（或 stdin EOF）输出部分流后以非零码退出 | 130/143 |

## 平台说明（interrupt）

Node 在 Windows 上无法向子进程投递可捕获的 SIGINT/SIGTERM：`child.kill()`
映射为 `TerminateProcess`，处理器不会运行。因此 `interrupt` 场景在注册
SIGINT/SIGTERM 处理器（POSIX 真实生效）之外，提供 `--interrupt-on stdin-close`：
stdin 关闭时走同一条优雅退出路径（部分流 + 非零码）。Windows 测试使用该模式；
这不是对信号行为的替代声明，只是同一条代码路径的可达入口。

## fixtures

`pnpm build && pnpm generate:fixtures` 从同一引擎重新生成 `fixtures/*.synthetic.jsonl`
与 `fixtures/manifest.json`。manifest 记录每个样本的方言、场景、退出码与
cli-events 侧的预期判定。`grandchild` 事件携带真实 PID，因此不预生成样本。

## 事件形状（synthetic 近似）

- claude 方言：`system`/`assistant`/`user`/`result`/`error` 行，`result` 行
  携带 `structured_output`（业务 ExecutionResult JSON）与 `usage`。
- codex 方言：`thread.started`/`turn.started`/`item.*`/`turn.completed`/
  `turn.failed`/`error` 行，`turn.completed` 携带 `usage` 与合成扩展字段
  `execution_result`。
- 审批/权限行（claude `control_request`/`control_response`、codex
  `approval.requested`/`approval.denied`）是合成扩展，等待 M0-03/M0-04 校验。

与解析侧的映射契约见 `@role-orchestrator/cli-events`。
