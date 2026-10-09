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
- **测试**:desktop-ui vitest 9 文件 156/156(交付时 150/150,新增 +30=
  profileManager 26+shell 渲染 4;第 7 轮审查返修 +6,见 §4/§9);
  browser-e2e 17 文件 28/28(+1 app-provider-flow,§5);local-api 32 文件
  353/353(+4 path-check)。

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

- profileManager.test.ts(交付 26 格;第 7 轮返修后 31 格):新建(追加+
  其他条目逐对象保留+默认填充 model null/credentialGroup=id+序列化回读
  schemaVersion/extraArgs)/id 规范化(小写+空白点号→连字符+裸名 PATH
  注记分界)/重复 id 人话冲突/字段校验矩阵(边界 1..32、30..86400 通过;
  33、29、201、非法 id/凭据组拒绝)/文件容量预检(返修补:满 64 条拒绝
  第 65 条=人话零写入;63 条边界通过+编辑不受容量门)/编辑(原位替换+
  他人保留;未载入自由;载入+七字段→drift 人话;载入+model→M9-04 人话;
  载入+零变更→changed:false;改名拒绝+目标消失拒绝)/删除(未引用→余序
  保留;被引用→列出项目+角色;最后一夫;目标消失)/删除引用门(返修补:
  fresh null→fail-closed 人话拒绝[旧降级 [] 必放行,双向实证见 §9.3];
  fresh []→确无项目放行;fresh 含引用→照常列出阻止)/引用聚合 join/
  stat 判定翻译(exe 硬门、dir 提示)。
- shell.test.tsx(交付 +4 格;第 7 轮返修后 +5 格):列表行九字段+零接触
  注记+载入徽章两态;操作对编辑/删除↔确认删除/取消;表单(类型单选/
  模型留空=CLI 默认/凭据与 wrapper 注记/高级折叠/knownModels datalist
  仅随所选 runtime);编辑态 id 只读+改名指引;返修格=载入状态未知/
  读取中独立徽章(不冒充「待重启载入」)+AI 模型/高级设置加载态(首帧
  「正在读取」不闪失败文案,失败臂「状态未知」双向钉住)。

## 5. e2e(app-provider-flow,17 文件 28/28 之一)

登记+向导默认绑定 → 接入配置:可执行路径填不存在路径→保存被人话拒绝、
磁盘 2 条目不变(只读 stat 硬门 fail-closed 实证)→ 改填 wrapper 真路径,
名称填「Claude GLM」(自动规范化 claude-glm)、模型 glm-4.6、configDir 故意
不存在→「提示:凭据目录当前不存在」如实出现且不阻塞→ 磁盘 3 条目、
claude-glm 九字段逐项断言、claude-default 逐字段相等(解析后对象
toEqual——本报告交付版「逐字节相等」系措辞夸大,第 7 轮审查更正;断言
形态见 packages/browser-e2e/test/app-provider-flow.test.ts:300)→
编辑超时 900
(未载入条目自由编辑;id 只读断言)→ Agent 团队 开发→(claude,glm-4.6)→
诚实 bind-pending(组合复用零文件写入、绑定行 DB 断言未动)→ 用户侧补建
configDir(§6)→ 重启模拟(关服→重读文件→以载入态重启)→ 再保存(绑定
落地,DB 断言 developer=claude-glm)→ 删除→人话阻止(列出项目目录名+
「开发」)+磁盘仍 3 条目 → 建任务→终态已完成→ **wrapper 记录 argv 逐项等于
["-p","--output-format","stream-json","--verbose","--model","glm-4.6"]**
(第三方端点故事的真实执行:wrapper 用户自备,产品只验路径存在)→
改回 (codex,CLI 默认)→ 删除成功→ 磁盘 2 条目、codex-default 逐字段相等
(解析后对象 toEqual,app-provider-flow.test.ts:429)。
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
一行按盘上纯 LF 字节重算;(b) self-test exit 0);12 文件(7 改+5 新;
交付版误记 11 文件(7 改+4 新),第 7 轮审查更正——批报告自身即新增文件,
12=7 改[CHECKSUMS.sha256、api.ts、app.css、SettingsPage.tsx、
shell.test.tsx、API_AND_EVENTS.md、server.ts]+5 新[profileManager.ts、
profileManager.test.ts、app-provider-flow.test.ts、path-check.test.ts、
本报告])逐文件 BOM=False、CR=0、尾 LF;git add 显式路径 12 文件零 -A;
无 push 无 tag。

## 8. 未验证项(如实)

真实 Claude/Codex CLI 与真实第三方端点(wrapper 指向真实兼容网关)端到端
=维护者环境(红线);壳真窗完整人机流程;10 轮审查属批次后续流程未开始;
绑定步对缺失 configDir 的既有 500 行为未改(既有语义,登记于 §6)。

## 9. 审查拦截记录(第 7 轮)

第 7 轮审查以两条**阻断**拦截本批(①治理披露三面未同步;②删除引用检查
fail-open),另收口约 12 条 minor;本节登记原文要点+实证+返修处置。两条
阻断与 minor 均已在本会话修复,门禁见 §9.5,判别力双向实证见 §9.3。

### 9.1 拦截①(治理连续性):治理披露三面未同步

**原文要点**。M11-01..06 连续 6 批交付必有 PROPOSALS.md『治理披露』节、
docs/BACKLOG.md 交付标记+交付摘要节、project/backlog.json deliveryNotes
条目;本批三者全缺,且批报告未说明省略理由——与历批惯例不一致。

**返修处置(三面补齐,与本返修同批)**:
1. PROPOSALS.md 追加『治理披露:M11-07 交付(2026-10-09)』(范围与提交
   形态/CRUD 语义/删除引用阻止[含本返修 fail-closed 修正]/零密钥边界
   声明/门禁退出码/审查移交登记);该文件属冻结面,CHECKSUMS.sha256 对应
   行按盘上纯 LF 字节重算;
2. docs/BACKLOG.md M11-07 节标题加交付标记+新增『M11-07 · 接入配置管理
   面(2026-10-09 交付摘要)』节(照 M11-06 格式;偏差/移交登记:『已
   登录』不在本批范围[沿袭 M11-05 偏差登记口径]、64 条上限预检[交付时
   无,本返修在 checkProfileDraft 补齐]、path-check 探针『任何 stat 失败
   即答 exists:false』与查询串重复 param 折叠=既有约定如实登记、丢失更新
   竞态与陈旧载入集窗=既有观察登记归属非本批引入);
3. project/backlog.json deliveryNotes 增 M11-07 条目(status/deliveredAt
   2026-10-09/note 注明全链以 git log 为准;issues[].status 恒 planned
   为历批同口径,完成态以 deliveryNotes 与 docs/BACKLOG.md 为准;先
   JSON.stringify 后写盘,纯 LF)。

### 9.2 拦截②(安全语义有效性洞):删除引用检查 fail-open

**原文要点**。confirmProviderDelete 的引用检查读页面装载时的 `projects`
副本,而装载 useEffect 的 `catch(() => setProjects([]))` 把拉取失败塌缩
成空列表——降级态下引用检查看到「空注册表」直接放行:被引用配置可删、
角色绑定悬空。本批自陈的安全语义『删除引用阻止』在该降级态完全失效
(fail-open),且引用数据还可能是装载时的陈旧副本(装载后新登记的项目不
在列)。

**返修处置(删除前重取,fail-closed;零新增端点、零 orchestration 变化)**:
1. **删除前重取 GET /projects**(SettingsPage.tsx confirmProviderDelete):
   确认删除时重新拉取项目清单——成功→以新数据聚合引用(既有
   fetchAllProjectBindings × 既有 collectProfileReferences × 既有
   composeProfileDelete);失败→freshProjects=null,**fail-closed 拒绝
   删除**,人话=『无法确认引用状态(项目清单读取失败)……为避免删除后
   角色绑定悬空,本次没有写入任何内容;请稍后重试。』(纯函数
   `unreadableReferencesMessage`,页面与规划器单源);页面装载副本不再
   参与删除判定(既不陈旧、也无可塌缩的 []);
2. **null 与 [] 语义分立**(纯规划器 `gateProfileDeleteOnReferences`,
   profileManager.ts):fresh===null(读取失败,引用状态未知)→
   unreadable 拒绝;fresh===(确无已登记项目,不可能有引用)→放行进入
   既有计划器(目标消失/最后一夫照旧把关);其余→以新数据 join 后计划,
   被引用照常列出阻止;
3. **随行 minor 同口收口**(三态与指引,SettingsPage.tsx):
   - profiles 三态分立——loading(『正在读取』)/ null(读取失败=未知,
     徽章显『载入状态未知』、**阻止自由编辑**(openProviderEdit 人话拒
     绝:无法判断该条目是否已载入,编辑可能改出 drift/M9-04 静默失效;
     与既有 :644-648 saveTeam 拒绝同语义)/ 空数组(确无);载入徽章由两态
     扩四态(loaded/file-only/unknown/checking),未知态不再伪『待重启
     载入』;
   - 首帧闪现失败文案消除——AiModelRows/AdvancedProfileRows 增 loading
     臂、接入配置 Card 增 fileFullLoading『正在读取 AI 配置文件…』态;
   - projects 拉取失败 null 化(不再 catch 塌缩 []),项目下拉对失败显
     人话错误态而非无限『正在读取』或伪空列表;
   - 高级设置折叠区指引修真(:1206 区域):已载入条目的 credentialGroup/
     超时/并发在 drift 七字段内、编辑会被拒绝——指引改为『已载入的配置
     ……编辑会被拒绝;请新增一条接入配置再在 Agent 团队切换;尚未载入
     的配置才可直接编辑』,不再指向一条注定被拒的路径;
   - checkProfileDraft 增 ≤64 条目容量预检(冻结 ProfilesFileSchema
     max(64),contracts/src/schema/profiles.ts:24):满 64 条再新增→人话
     conflict 零写入(原实现第 65 条会走到注定 422 的 PUT);编辑=原位
     替换不增数,不受容量门;
   - shell.test.tsx:919/:933 夹具改真实路径写法(双反斜杠)——原单反
     斜杠字面量里 `\t` 是制表符、`\U`/`\g`/`\.` 被吞,断言的是夹具自己
     的假路径。
   - 批报告勘误:『+39』→实际新增 30 格;『11 文件(7 改+4 新)』→12
     文件(7 改+5 新,本报告自身即新增文件);『逐字节相等』→『逐字段
     相等(解析后对象 toEqual)』(e2e 实为 app-provider-flow.test.ts
     :300/:429 的 toEqual,报告原文措辞夸大)。

### 9.3 判别力双向实证(本会话实跑)

- **新测试对旧源跑**(临时以 `git show HEAD:` 覆盖 profileManager.ts 与
  pages/SettingsPage.tsx 两文件后 `npx vitest run`):**6 failed / 150
  passed(2 文件红)**——恰为返修新增格:容量预检 2 格+
  gateProfileDeleteOnReferences 3 格(其中 null→fail-closed 格失败于
  `TypeError: gateProfileDeleteOnReferences is not a function`:旧实现
  无此守卫)+ shell 三态格(旧徽章对 unknown 态仍渲染『待重启载入』,
  `toContain("载入状态未知")` 红);既有 150 格零误伤。
- **复原后**:`npx vitest run` → **156/156 绿**(9 文件,150+6)。
- **判别力语义**:旧降级塌缩态(装载 catch→[])下删除引用检查必然看到
  空注册表=放行;新守卫对同一情形(fresh null)拒绝并零写入——null 格
  即该判别力的可执行钉。

### 9.4 返修变更文件清单(6 文件;未提交,工作树留存)

- `apps/desktop-ui/src/profileManager.ts`(gateProfileDeleteOnReferences
  +unreadableReferencesMessage+PROFILES_FILE_MAX_ENTRIES 容量预检+载入
  徽章四态标签+头注语义 4 修真);
- `apps/desktop-ui/src/pages/SettingsPage.tsx`(删除前重取 GET /projects
  fail-closed 链;profiles/fileFull/projects 三态;openProviderEdit 未知
  态拦截;高级设置指引修真;头注返修纪要);
- `apps/desktop-ui/src/profileManager.test.ts`(+5 格:容量 2+引用门 3);
- `apps/desktop-ui/src/shell.test.tsx`(夹具真实路径+三态渲染格);
- `reports/M11-07-BATCH.md`(本节+§1/§4/§5/§7 勘误);
- 治理三面 3 文件:`PROPOSALS.md`+`docs/BACKLOG.md`+`project/backlog.json`
  (三者均属冻结面,CHECKSUMS.sha256 三行按盘上纯 LF 字节重算)。
- `CHECKSUMS.sha256`(上述三行重算)。
合计 9 文件(4 源/测+1 报告+3 治理面+1 冻结面校验和)。
零 orchestration 语义变化(服务端 src 零触碰);零新增端点;零新增外部
依赖;零 push 零 tag;本返修未提交(ask 无提交任务,工作树留存)。

### 9.5 返修门禁实跑(2026-10-09 本会话,逐命令)

- `npx tsc -p tsconfig.json --noEmit`(desktop-ui):exit 0;
- desktop-ui `npx vitest run`:9 文件 **156/156 exit 0**(150+6:容量 2+
  引用门 3+三态渲染 1;历格零回归);
- `pnpm typecheck`(turbo 全仓):62/62 exit 0;
- local-api `pnpm test`:32 文件 **353/353 exit 0**(0 新格,服务端零触碰
  的回归面);
- `pnpm build`(turbo 全仓):37/37 exit 0(desktop-ui:build **cache miss
  真执行**,1927 modules transformed——返修源码进了产物);
- 判别力双向(§9.3):旧源 6 failed/150 passed → 复原 156/156;
- `node planning-check.mjs`:exit 0——(a) 80/80 files match+(b) self-test
  exit 0(PROPOSALS/docs BACKLOG/project backlog.json 三行按盘上纯 LF 字节
  重算后)。

### 9.6 未验证项(如实,返修追加)

- 页面级 fetch 接线(确认删除→重取 /projects→null 拒绝)无 DOM 交互
  测试:desktop-ui vitest 为 node 环境、jsdom 未安装(零新增依赖红线),
  交互语义由纯门 3 格钉住(M11-06 B2『纯转换分台』先例);browser-e2e
  不在本返修门禁内,app-provider-flow 既有全链未重跑(其删除段走服务
  在跑态,重取成功路径行为不变;失败臂未在 e2e 覆盖);
- 壳真窗三态人机观察;10 轮审查余下轮次继续。
