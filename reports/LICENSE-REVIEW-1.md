# 许可证复核报告（LICENSE-REVIEW-1，2026-09-25）

执行：审查会话（GLM-5.3）受维护者委托，对 THIRD_PARTY_NOTICES.md 中 30 项
「本机未安装、许可证未读取」的待复核依赖做 registry 核实，并对 MPL-2.0
（lightningcss 家族）做合规性评估。方法：`npm view <pkg>@<version> license`
（查询 registry.npmjs.org 生产源；沙箱对连续请求限流，采用 12 秒间隔逐条查询，
每条均成功返回）。

## 1. 30 项待复核结果（全部闭合）

| 组 | 数量 | 许可证 | 明细 |
|---|---|---|---|
| @rolldown/binding-*@1.2.9 | 14 | **MIT** | android-arm-eabi / android-arm64 / darwin-arm64 / darwin-x64 / freebsd-x64 / linux-arm-gnueabihf / linux-arm64-gnu / linux-arm64-musl / linux-ppc64-gnu / linux-s390x-gnu / linux-x64-gnu / linux-x64-musl / openharmony-arm64 / win32-arm64-msvc |
| @turbo/*@2.11.2 | 5 | **MIT** | darwin-64 / darwin-arm64 / linux-64 / linux-arm64 / windows-arm64 |
| fsevents@2.3.3 | 1 | **MIT** | — |
| lightningcss-*@1.33.0 | 10 | **MPL-2.0** | android-arm64 / darwin-arm64 / darwin-x64 / freebsd-x64 / linux-arm-gnueabihf / linux-arm64-gnu / linux-arm64-musl / linux-x64-gnu / linux-x64-musl / win32-arm64-msvc |

与已装依赖的许可证表合并后，全仓 84 个外部依赖的许可证分布：
**MIT 64（已装 44 + registry 核实 20）、MPL-2.0 12（已装 2 + registry 核实 10）、
Apache-2.0 4、ISC 3、BSD-3-Clause 1**——合计 84，0 项 unknown 残留。

## 2. MPL-2.0 合规性评估（lightningcss 家族，含 @turbo 类比）

- **许可性质**：MPL-2.0 是文件级弱 Copyleft——仅当对 MPL 覆盖的**源文件本身**
  做出修改时，才要求以 MPL 开放那些文件的修改版。作为**未修改的 npm 依赖**
  使用时，义务仅为保留许可证与来源声明（THIRD_PARTY_NOTICES 已满足）。
- **本仓使用形态**：lightningcss 家族全部位于 dev/test 工具链（构建期依赖），
  **不在运行时交付面**（runtime 外部依赖恒为 ws/yaml/zod，由
  `repo-audit.test.ts:49` 与 release-audit 双重钉死）——不存在随产品二进制
  分发 MPL 代码的场景。
- **结论**：以未修改依赖形式使用 lightningcss 家族符合 MPL-2.0，**无需额外
  义务**。此结论为审查会话的合规分析，最终确认权在维护者。

## 3. 待维护者确认后的动作

确认本报告后，可执行 THIRD_PARTY_NOTICES.md 冻结追加（同治理流程：披露 +
CHECKSUMS 同步）：将 30 项的「许可证未在本机安装件中读取（待 registry 复核）」
标注更新为上表已核实值，并引用本报告作为证据来源。确认前 NOTICES 现状不变。
