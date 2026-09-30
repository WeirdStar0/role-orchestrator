# 第三方内容与归属记录

本包包含原创项目规划、示例配置、契约与校验脚本。
Apache-2.0 候选文本为标准许可文本；来源和候选状态见 project/LICENSING.md。
外部 CLI、Git 和参考项目只作为研究依据列于 docs/SOURCES.md，未捆绑其运行程序或源码。
静态检查依赖 PyYAML 与 jsonschema，不打包其实现；产品依赖将在 M0 锁定后另行记录。
本文件不是关于所有未来依赖许可证均已审查完毕的声明。

## npm 外部依赖清单（111 项；2026-09-25 生成 84 项并同日按 reports/LICENSE-REVIEW-1.md 完成 registry 复核；2026-09-30 M8-05 增 esbuild 0.28.2 及其 26 个平台可选二进制共 27 项，当日按 registry 复核其 license 字段）

### MIT——本机安装件读取（46 项）

- @esbuild/win32-x64 0.28.2
- @jridgewell/sourcemap-codec 1.6.0
- @oxc-project/types 0.150.0
- @rolldown/binding-win32-x64-msvc 1.2.9
- @rolldown/pluginutils 1.0.1
- @standard-schema/spec 1.1.0
- @turbo/windows-64 2.11.2
- @types/chai 5.2.3
- @types/deep-eql 4.0.2
- @types/estree 1.0.9
- @types/node 25.9.8
- @types/ws 8.18.1
- @vitest/expect 4.1.11
- @vitest/mocker 4.1.11
- @vitest/pretty-format 4.1.11
- @vitest/runner 4.1.11
- @vitest/snapshot 4.1.11
- @vitest/spy 4.1.11
- @vitest/utils 4.1.11
- assertion-error 2.0.1
- chai 6.2.2
- convert-source-map 2.0.0
- es-module-lexer 2.3.2
- esbuild 0.28.2
- estree-walker 3.0.3
- fdir 6.5.0
- magic-string 0.30.21
- nanoid 3.3.19
- obug 2.2.1
- pathe 2.0.3
- picomatch 4.0.7
- postcss 8.5.28
- rolldown 1.2.9
- stackback 0.0.2
- std-env 4.2.0
- tinybench 2.9.0
- tinyexec 1.3.1
- tinyglobby 0.2.17
- tinyrainbow 3.1.1
- turbo 2.11.2
- undici-types 7.24.6
- vite 8.3.0
- vitest 4.1.11
- why-is-node-running 2.3.0
- ws 8.21.3
- zod 4.6.5

### Apache-2.0——本机安装件读取（4 项）

- detect-libc 2.1.2
- expect-type 1.4.0
- playwright-core 1.61.0
- typescript 5.9.3

### ISC——本机安装件读取（3 项）

- picocolors 1.1.1
- siginfo 2.0.0
- yaml 2.9.1

### BSD-3-Clause——本机安装件读取（1 项）

- source-map-js 1.2.1

### MPL-2.0——本机安装件读取（2 项）

- lightningcss 1.33.0
- lightningcss-win32-x64-msvc 1.33.0

### MIT——registry 核实（45 项，本机未安装；@rolldown/@turbo/fsevents 核实记录见 reports/LICENSE-REVIEW-1.md；@esbuild/* 25 项于 2026-09-30 按 registry 复核 license 字段均为 MIT）

- @esbuild/aix-ppc64 0.28.2
- @esbuild/android-arm 0.28.2
- @esbuild/android-arm64 0.28.2
- @esbuild/android-x64 0.28.2
- @esbuild/darwin-arm64 0.28.2
- @esbuild/darwin-x64 0.28.2
- @esbuild/freebsd-arm64 0.28.2
- @esbuild/freebsd-x64 0.28.2
- @esbuild/linux-arm 0.28.2
- @esbuild/linux-arm64 0.28.2
- @esbuild/linux-ia32 0.28.2
- @esbuild/linux-loong64 0.28.2
- @esbuild/linux-mips64el 0.28.2
- @esbuild/linux-ppc64 0.28.2
- @esbuild/linux-riscv64 0.28.2
- @esbuild/linux-s390x 0.28.2
- @esbuild/linux-x64 0.28.2
- @esbuild/netbsd-arm64 0.28.2
- @esbuild/netbsd-x64 0.28.2
- @esbuild/openbsd-arm64 0.28.2
- @esbuild/openbsd-x64 0.28.2
- @esbuild/openharmony-arm64 0.28.2
- @esbuild/sunos-x64 0.28.2
- @esbuild/win32-arm64 0.28.2
- @esbuild/win32-ia32 0.28.2
- @rolldown/binding-android-arm-eabi 1.2.9
- @rolldown/binding-android-arm64 1.2.9
- @rolldown/binding-darwin-arm64 1.2.9
- @rolldown/binding-darwin-x64 1.2.9
- @rolldown/binding-freebsd-x64 1.2.9
- @rolldown/binding-linux-arm-gnueabihf 1.2.9
- @rolldown/binding-linux-arm64-gnu 1.2.9
- @rolldown/binding-linux-arm64-musl 1.2.9
- @rolldown/binding-linux-ppc64-gnu 1.2.9
- @rolldown/binding-linux-s390x-gnu 1.2.9
- @rolldown/binding-linux-x64-gnu 1.2.9
- @rolldown/binding-linux-x64-musl 1.2.9
- @rolldown/binding-openharmony-arm64 1.2.9
- @rolldown/binding-win32-arm64-msvc 1.2.9
- @turbo/darwin-64 2.11.2
- @turbo/darwin-arm64 2.11.2
- @turbo/linux-64 2.11.2
- @turbo/linux-arm64 2.11.2
- @turbo/windows-arm64 2.11.2
- fsevents 2.3.3

### MPL-2.0——registry 核实（10 项，本机未安装；核实记录见 reports/LICENSE-REVIEW-1.md）

- lightningcss-android-arm64 1.33.0
- lightningcss-darwin-arm64 1.33.0
- lightningcss-darwin-x64 1.33.0
- lightningcss-freebsd-x64 1.33.0
- lightningcss-linux-arm-gnueabihf 1.33.0
- lightningcss-linux-arm64-gnu 1.33.0
- lightningcss-linux-arm64-musl 1.33.0
- lightningcss-linux-x64-gnu 1.33.0
- lightningcss-linux-x64-musl 1.33.0
- lightningcss-win32-arm64-msvc 1.33.0
