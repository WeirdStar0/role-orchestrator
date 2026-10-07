# @role-orchestrator/desktop-ui — 桌面渲染层基座(M11-01)

产品 UI 的新 renderer:壳默认加载的 `/app`(docs/BACKLOG.md M11-01 范围③④)。
React + TypeScript + Vite + React Router + Lucide——全部在 M11 冻结的新依赖
白名单内;无重型 UI 库(组件原语自建,见 `src/components/ui.tsx` + token 层)。

## 单文件构建与接线(与安装器 / CSP 的兼容理由)

`vite build` 产出**一个** `dist/index.html`(JS/CSS 由本包 vite.config.ts 内的
本地插件 `appSingleFile` 内联,零额外 npm 依赖)。选这个形态的理由:

- **与 serve 单包兼容**:local-api 的 sidecar 是单个 esbuild bundle
  (`serve-bundle.mjs`);新 UI 同为单文件,安装器只多携带一个资源文件
  (`desktop-ui.html`,tauri.conf.json `bundle.resources` 声明,由
  `scripts/sync-shell-sidecar.mjs` staging),不引入任何资源目录树或路径约定。
- **与 CSP 纪律兼容**:单文件意味着内联 `<script>`/`<style>`,而 local-api 对
  /app 响应的 CSP **不是** `unsafe-inline`,而是按"所服务字节"逐块计算的
  内容哈希(`script-src 'sha256-…'`,`packages/local-api/src/app-ui.ts`)——
  任何其它内联脚本都会被浏览器拒绝,纪律等价于旧页的 `script-src 'self'`
  且更强(钉死到具体构建产物)。`default-src 'none'` 底线不变。
- **与深链兼容**:服务端对 `/app` 与 `/app/*` 都回这份 HTML
  (`/app.js`、`/app.css` 是旧页资产,路径互不冲突),React Router 以
  `basename="/app"` 接管路由,刷新安全。
- **缺产物降级**:serve 启动时经定位链(安装布局 `desktop-ui.html` 同目录 →
  仓库 dev 布局 `apps/desktop-ui/dist/index.html`)读取;缺失时 /app 以
  302 回退到 /(旧页)——旧安装包、未构建树、每个候选都保持可用。

## 认证

本 UI 不经手令牌:桌面壳对 127.0.0.1:<port> 的请求注入
`Authorization`(ADR docs/adr/010-token-auto-session.md),本包的 API client
刻意不发任何凭据头;纯浏览器直开时服务端守卫拒绝,页面呈显式的未认证状态。

## 构建

```bash
pnpm --filter @role-orchestrator/desktop-ui run build      # vite build → dist/index.html(单文件)
pnpm --filter @role-orchestrator/desktop-ui run typecheck  # tsc
pnpm --filter @role-orchestrator/desktop-ui run test       # vitest(renderToString 级,无 DOM 依赖)
node scripts/sync-shell-sidecar.mjs                        # 出安装包时:staging 进壳的 sidecar/
```

测试走 `react-dom/server` 的 renderToString(数据加载在 effect 中,SSR 不触
发),不需要 jsdom/testing-library——白名单零外溢。
