# M11-07 批报告:接入配置管理面(AI 供应商自定义配置)

批次日期:2026-10-09(本文件不入冻结面,历批同口径)。任务 1 单任务交付;
ask 全文见 docs/BACKLOG.md M11-07 行。

## 1. Summary

- **交付面**:Settings 新增「接入配置(AI 供应商)」区——列表(名称/类型/
  模型/载入状态)+完整九字段展示+新增/编辑/删除。全部写经既有
  PUT /api/v1/profiles/full 原子写回(重建全集 diff-merge,其他条目逐字段
  保留);删除先做引用检查(既有 GET /projects × 既有 GET
  /projects/role-bindings?projectDir= 组合,零聚合端点),被任一项目绑定
  引用→人话阻止并列出项目与角色;新 id 写入后重启生效如实提示。
- **唯一新增服务端面**:只读 stat 探针 `GET /api/v1/profiles/path-check?path=`
  (浏览器无法 stat 文件系统;可执行路径存在性硬门+configDir 存在性提示)。
  zod strict 单参数;恰一次 statSync,零内容读取零目录列举;路径不回显、
  查询串不入日志;bearer 守卫(读无 CSRF);已登记 docs/API_AND_EVENTS.md §1。
  **orchestration 语义零变化**(既有路由/服务/引擎零触碰;契约 schema 不动);
  **零新增外部 npm 依赖**(pnpm-lock 零 diff,package.json 零 diff)。
- **测试**:desktop-ui vitest 9 文件 150/150(+39:profileManager 26+
  shell 渲染 4 格…见 §4);browser-e2e 17 文件 28/28(+1
  app-provider-flow,§5);local-api 32 文件 353/353(+4 path-check)。

## 2. 设计决策(ask 点名入批报告)

1. **页面形态:独立 Card 区(非折叠、非独立路由)**。ask 给了「/app/settings
   内新折叠区或独立路由 /app/providers」两选。选区内 Card(位于 AI 模型与
   Agent 团队之间、不折叠):管理面现为该页主操作面,折叠会藏住它;页面
   已持有 CRUD 所需两数据集(载入集+文件全集),不动导航/路由面。
2. **编辑态 id 不可改**(表单只读+人话):改名=删旧建新,而删旧有引用检查
   ——允许就地改名会绕开删除引用阻止,制造悬空绑定。要改名走「新增+删除」。
3. **载入条目的两类保存拒绝(零写入)**:(a) 七字段(runtime/executable/
   executionTarget/configDir/credentialGroup/maxConcurrency/timeoutSeconds)
   任一变更→drift 人话拒绝(run-creation.ts ensureProfileRow 会在下次建任务
   时 409 PROFILE_DEFINITION_CONFLICT;改定义是人的决定,先写只会把 409
   搬到重启后);(b) model 变更→M9-04 人话拒绝(同 id 改模型永不铸新
   revision,静默不生效;正道=新 id 新配置)。未载入条目自由编辑。
4. **删除最后一夫当关**:文件仅剩一条时拒绝删除(冻结 ProfilesFileSchema
   `min(1)`,写空集=必然 422)。
5. **executable 存在性=硬门(仅对含路径分隔符的值);裸名=如实注记**
   (PATH 解析无法验证);**configDir 存在性=提示非阻塞**(凭据是 CLI 的
   自辖域)。提示明确「绑定写入会读取该目录」——见 §6 勘察发现。
6. **零密钥经手(红线,结构性成立)**:表单与列表不存在任何 API key/
   token/base URL 输入;第三方端点=可执行路径指向用户自备 wrapper 脚本,
   产品只做只读 stat 存在性检查,不查看不校验脚本内容;configDir 逐面
   携带「凭据由 CLI 在该目录自行登录管理,本产品零接触」。
7. **credentialGroup/executionTarget 的来源**:两者是冻结 schema 必填字段
   (ask 字段清单未列,契约不能不填)。credentialGroup 默认=配置 id(留空
   即每配置独立配额组,首启的 per-CLI 约定不受影响),置于高级折叠可改;
   executionTarget 默认克隆既有条目(UI 不发明本机平台),高级折叠可选。

## 3. 服务端唯一新增(只读、带凭据、zod strict、已登记)

`GET /api/v1/profiles/path-check?path=<1..2048>`(packages/local-api/src/
server.ts):PathCheckQuerySchema strictObject;serveProfilesPathCheck 恰一次
statSync,任何失败(不存在/父目录不可达/权限)=如实 `exists:false`(200,
「无」是答案不是错误);响应仅 schemaVersion+exists/isFile/isDirectory 四键;
路由 405 非 GET;守卫管道与全部 /api 路由一致。测试
packages/local-api/test/path-check.test.ts(4 格:file/directory/absent+
parent-absent/守卫 403+405+400)。

## 4. 单测与渲染格

- profileManager.test.ts(26 格):新建(追加+其他条目逐对象保留+默认填充
  model null/credentialGroup=id+序列化回读 schemaVersion/extraArgs)/id 规范
  化(小写+空白点号→连字符+裸名 PATH 注记分界)/重复 id 人话冲突/字段校验
  矩阵(边界 1..32、30..86400 通过;33、29、201、非法 id/凭据组拒绝)/
  编辑(原位替换+他人保留;未载入自由;载入+七字段→drift 人话;载入+
  model→M9-04 人话;载入+零变更→changed:false;改名拒绝+目标消失拒绝)/
  删除(未引用→余序保留;被引用→列出项目+角色;最后一夫;目标消失)/
  引用聚合 join/stat 判定翻译(exe 硬门、dir 提示)。
- shell.test.tsx(+4 格):列表行九字段+零接触注记+载入徽章两态;操作对
  编辑/删除↔确认删除/取消;表单(类型单选/模型留空=CLI 默认/凭据与
  wrapper 注记/高级折叠/knownModels datalist 仅随所选 runtime);编辑态
  id 只读+改名指引。

## 5. e2e(app-provider-flow,17 文件 28/28 之一)

登记+向导默认绑定 → 接入配置:可执行路径填不存在路径→保存被人话拒绝、
磁盘 2 条目不变(只读 stat 硬门 fail-closed 实证)→ 改填 wrapper 真路径,
名称填「Claude GLM」(自动规范化 claude-glm)、模型 glm-4.6、configDir 故意
不存在→「提示:凭据目录当前不存在」如实出现且不阻塞→ 磁盘 3 条目、
claude-glm 九字段逐项断言、claude-default 逐字节相等 → 编辑超时 900
(未载入条目自由编辑;id 只读断言)→ Agent 团队 开发→(claude,glm-4.6)→
诚实 bind-pending(组合复用零文件写入、绑定行 DB 断言未动)→ 用户侧补建
configDir(§6)→ 重启模拟(关服→重读文件→以载入态重启)→ 再保存(绑定
落地,DB 断言 developer=claude-glm)→ 删除→人话阻止(列出项目目录名+
「开发」)+磁盘仍 3 条目 → 建任务→终态已完成→ **wrapper 记录 argv 逐项等于
["-p","--output-format","stream-json","--verbose","--model","glm-4.6"]**
(第三方端点故事的真实执行:wrapper 用户自备,产品只验路径存在)→
改回 (codex,CLI 默认)→ 删除成功→ 磁盘 2 条目、codex-default 逐字节相等。
argv 观察面=M11-06 同款夹具 wrapper(记录后委托内建 fake-cli,engine spawn
路径零改动)。

## 6. 勘察发现(binding 时 configDir 必须存在)

首版 e2e 在绑定步收到 500:绑定写入经 ensureProfileRevision→
createProfileRevision→hashExternalConfigFiles→resolveConfigDirBase
(packages/runtime-profile/src/drift.ts:314)对不存在的 configDir 抛
ExternalConfigViolationError——**目录在绑定时必须已存在**是既有引擎语义。
处置:不改服务端(orchestration 语义零变化);configDir 提示文案如实写明
「请先创建这个目录……再把本配置绑定到角色——绑定写入会读取该目录」;
e2e 按真实用户时序在绑定前补建目录。该 500 为未映射的内部错误载体,属
既有行为,如实登记不粉饰。

## 7. 门禁实跑(2026-10-09 本会话逐命令)

pnpm typecheck 62/62 exit 0;pnpm build 37/37 exit 0;pnpm test 74/74 任务
exit 0(desktop-ui 150/150、browser-e2e 28/28、local-api 353/353);
planning-check exit 0((a) 80/80 checksums match——docs/API_AND_EVENTS.md
一行按盘上纯 LF 字节重算;(b) self-test exit 0);11 文件(7 改+4 新)逐
文件 BOM=False、CR=0、尾 LF;git add 显式路径 11 文件零 -A;无 push 无 tag。

## 8. 未验证项(如实)

真实 Claude/Codex CLI 与真实第三方端点(wrapper 指向真实兼容网关)端到端
=维护者环境(红线);壳真窗完整人机流程;10 轮审查属批次后续流程未开始;
绑定步对缺失 configDir 的既有 500 行为未改(既有语义,登记于 §6)。
