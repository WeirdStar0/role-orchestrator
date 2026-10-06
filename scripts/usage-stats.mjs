#!/usr/bin/env node
/**
 * usage-stats.mjs — V031-02 只读使用统计导出工具(真实使用采集批备料)。
 *
 * 用法:
 *   node scripts/usage-stats.mjs --db <SQLite 路径> [--format json|md] [--run <runId>]
 *
 * 红线与边界(见 docs/BACKLOG.md v0.3.1 节 V031-02 行):
 * - 只读:以 SQLite READONLY 打开(node:sqlite `readOnly: true`),绝不写
 *   用户库(%LOCALAPPDATA%\role-orchestrator\orchestrator.db)。零运行时
 *   行为变更——本脚本独立于任何生产代码路径,不 import 任何产品包。
 * - 零新增外部依赖:仅用 Node.js 内置 node:sqlite / node:util(与
 *   packages/store 同源,store 的迁移框架同样基于 node:sqlite)。
 * - unknown-deny:指标在库中没有持久记录时如实输出 "unknown" 并带说明,
 *   绝不伪造字段、绝不把缺失写成 0。
 *
 * ---------------------------------------------------------------------------
 * 13 项指标聚合口径(BACKLOG V031-02 行定义;每项标注真实来源表——
 * 全部按 packages/store / packages/* 的受控迁移链 001..018 的真实字段
 * 勘察后落查询,迁移版本标注在每项口径后):
 *
 *  ① 任务成败   — task_runs.status(PLANNED/RUNNING/READY_FOR_DELIVERY/
 *                 DELIVERED/CANCELLED,冻结聚合词汇表)+ task_runs.outcome
 *                 (success/failed/cancelled/blocked,NULL=进行中;迁移 018)。
 *  ② 用到的角色 — task_nodes.role_id 按 run 分组计数(003);附
 *                 run_profile_snapshots 的 role→profile:revision 冻结快照
 *                 (002)佐证「用的哪个 Profile」。
 *  ③ DAG 实际展开 — task_nodes 全行(node_id/role/state/dependencies)+
 *                 依赖边(dependencies JSON 数组逐条展开为 dep→node 有向边;
 *                 该数组是建图时冻结的依赖快照);受控扩图产生的节点以
 *                 review_expansions(013)的 fix_node_id/review_node_id 标注
 *                 expansionMinted=true,并附扩图行数。
 *  ④ executions 数 — COUNT(executions WHERE run_id=?)(001;一行=一次进程
 *                 尝试)。
 *  ⑤ 失败/重试  — executions 按 phase 终态分类计数(SUCCEEDED/FAILED/
 *                 INTERRUPTED/CANCELLED;其余 PREPARING/STARTING/RUNNING/
 *                 FINALIZING 视为 inFlight);重试次数=attempt>=2 的行数,
 *                 附 maxAttempt(001;attempt 计数的 source of truth 就是
 *                 executions 表)。迁移 014 的 node_retry_state 镜像表不在
 *                 产品受控链(见 ⑪),不参与本口径。
 *  ⑥ 审批次数   — approvals 按 requested_by_run_id 分组(011),按 status
 *                 (PENDING/APPROVED/CONSUMED/REJECTED/EXPIRED)分类;附
 *                 approval_checkpoints 按 run_id 分组(012,WAITING/
 *                 CONTINUED/CANCELLED)。一个 checkpoint 恰对应一个 approval
 *                 (approval_id UNIQUE),两表分别计数以便交叉核对。
 *  ⑦ Reviewer fail 次数 — review_records WHERE run_id=? AND state=
 *                 'COMPLETED' AND verdict='fail'(006;verdict 绑定精确
 *                 candidateSha,A12);附 pass/blocked 计数与 INVALID 行数。
 *  ⑧ 上下文命中 — context_bundles WHERE run_id=?(007):行数+included
 *                 片段总数字节。现状如实(勘察注记):v1 产品编排路径的
 *                 Memory/Context 读侧注入(memory-injection)是纯读面,
 *                 不 per-run 落新 bundle 行;bundle 的 assemble+persist
 *                 当前只有 context-e2e 驱动面(dogfood/browser-e2e)写入,
 *                 因此真实产品 run 本项预期为 0/无行——这是现状,不是故障。
 *                 表有 run_id 关联,查询真实有效。
 *  ⑨ Memory 命中 — unknown:该指标当前无持久记录。读侧检索
 *                 (collectNodeMemoryInjection)结果只进节点 stdin prompt,
 *                 从不落库;bundle_fragments 的 layer='memory' 行同样只有
 *                 context-e2e 驱动面写入(010 的既有语义),产品编排路径
 *                 不产生。需人工评估或后续批补持久记录后才有数据。
 *  ⑩ 总耗时     — 执行区间口径:task_runs.created_at → MAX(executions.
 *                 updated_at)(001)。task_runs 无 finished_at 列(迁移链
 *                 冻结如此),该值是「最后一次执行行更新时刻」的区间近似,
 *                 不是专门的完成时刻字段;无执行行的 run 记 null。
 *  ⑪ CLI usage  — unknown(现状如实,勘察结论):①迁移 014 的
 *                 execution_usage(run 级 usage 行,A37)不在产品受控迁移
 *                 链 CONTROLLED_EXPANSION_MIGRATIONS(001-013,015-018,
 *                 packages/expand/src/controlled.ts)中,真实库确认不存在
 *                 该表;②model-stats PerformanceStore(M8-04 tee)是独立
 *                 JSONL 文件、UsageEvent 契约无 runId 字段,且产品 serve
 *                 组合根本未接线 usageSink。脚本对 execution_usage 做了
 *                 表存在性探测:未来该表入库后自动改为导出真实值。
 *  ⑫ 人工介入点 — 审批事件时间线:approvals(created_at=请求/approved_at/
 *                 rejected_at+rejection_reason,011)+ approval_checkpoints
 *                 (created_at=WAITING/continued_at=CONTINUED/CANCELLED 用
 *                 updated_at,012)+ expansion_user_holds(三轮审查耗尽的
 *                 「等用户」挂起与显式解除,013)。按时间排序输出。
 *  ⑬ 最终 diff 指针 — integration_records WHERE run_id=?(005):
 *                 integration_branch + candidate_sha + state(COMPLETED/
 *                 PAUSED_CONFLICT/IN_PROGRESS);无行记 null(如 run 未达
 *                 集成阶段)。
 *
 * 输出:--format json(默认,机器可读,含 legend)/--format md(人读摘要表)。
 * 退出码:0 成功;2 用法/参数错误;3 库打不开或查询失败(如实失败,
 * 不以空导出掩盖)。
 * ---------------------------------------------------------------------------
 */
import { DatabaseSync } from "node:sqlite";
import process from "node:process";

// ---------------------------------------------------------------------------
// arg parsing(手写,零依赖)
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const options = { db: null, format: "json", run: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--db") {
      options.db = argv[++i] ?? null;
    } else if (arg === "--format") {
      const value = argv[++i] ?? "";
      if (value !== "json" && value !== "md") {
        failUsage(`--format 必须是 json 或 md,收到 "${value}"`);
      }
      options.format = value;
    } else if (arg === "--run") {
      options.run = argv[++i] ?? null;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      failUsage(`未知参数 "${arg}"`);
    }
  }
  return options;
}

function failUsage(message) {
  process.stderr.write(`usage-stats: ${message}\n`);
  process.stderr.write(
    "用法: node scripts/usage-stats.mjs --db <SQLite 路径> [--format json|md] [--run <runId>]\n"
  );
  process.exit(2);
}

// ---------------------------------------------------------------------------
// 只读连接与表存在性探测(unknown-deny:缺表→unknown,不伪造)
// ---------------------------------------------------------------------------

function openReadOnly(dbPath) {
  if (!dbPath) failUsage("缺少 --db <SQLite 路径>");
  try {
    return new DatabaseSync(dbPath, { readOnly: true });
  } catch (error) {
    process.stderr.write(`usage-stats: 无法以只读方式打开数据库 "${dbPath}": ${error.message}\n`);
    process.exit(3);
  }
}

function tableExists(db, name) {
  const row = db
    .prepare("SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = ?")
    .get(name);
  return row?.present === 1;
}

/** 缺表时返回 null(调用方转为 unknown+说明),不抛、不造 0。 */
function tryAll(db, sql, ...params) {
  try {
    return db.prepare(sql).all(...params);
  } catch (error) {
    if (/no such table/i.test(String(error?.message))) return null;
    throw error;
  }
}

function tryGet(db, sql, ...params) {
  const rows = tryAll(db, sql, ...params);
  return rows === null ? null : (rows[0] ?? null);
}

const UNKNOWN_CLI_USAGE =
  "该指标当前无持久记录:迁移 014 的 execution_usage 不在产品受控迁移链 " +
    "(CONTROLLED_EXPANSION_MIGRATIONS,001-013+015-018)中,库中无该表;" +
    "model-stats PerformanceStore 为独立 JSONL 且契约无 runId 字段,产品 serve 未接线 usageSink。" +
    "需后续批补 run 级 usage 持久记录后才有数据。";

const UNKNOWN_MEMORY_HITS =
  "该指标当前无持久记录:读侧检索(memory-injection)只把命中注入节点 prompt,从不落库;" +
    "bundle_fragments 的 layer='memory' 行仅由 context-e2e 驱动面(dogfood/browser-e2e)写入," +
    "产品编排路径不产生。需人工评估(演练模板的观察栏)或后续批补持久记录。";

// ---------------------------------------------------------------------------
// 13 项指标采集(全部只读 SELECT)
// ---------------------------------------------------------------------------

function collectRunCore(db, runId) {
  return tryGet(
    db,
    "SELECT id, project_id, task_id, graph_revision, config_snapshot_hash, base_sha, status, outcome, created_at FROM task_runs WHERE id = ?",
    runId
  );
}

function collectRoles(db, runId) {
  const rows = tryAll(
    db,
    "SELECT role_id, COUNT(*) AS nodes FROM task_nodes WHERE run_id = ? GROUP BY role_id ORDER BY role_id",
    runId
  );
  if (rows === null) return { available: false };
  const snapshots = tryAll(
    db,
    "SELECT role_id, profile_id, profile_revision FROM run_profile_snapshots WHERE run_id = ? ORDER BY role_id",
    runId
  );
  return {
    available: true,
    perRole: rows.map((row) => ({ role: row.role_id, nodeCount: Number(row.nodes) })),
    profileSnapshots: (snapshots ?? []).map((row) => ({
      role: row.role_id,
      profileId: row.profile_id,
      profileRevision: Number(row.profile_revision)
    }))
  };
}

function collectDag(db, runId) {
  const nodes = tryAll(
    db,
    "SELECT node_id, role_id, state, dependencies, definition_revision FROM task_nodes WHERE run_id = ? ORDER BY node_id",
    runId
  );
  if (nodes === null) return { available: false };
  const expansions = tryAll(
    db,
    "SELECT fix_node_id, review_node_id, trigger_review_node_id, trigger_candidate_sha, new_generation FROM review_expansions WHERE run_id = ? ORDER BY created_at",
    runId
  );
  const minted = new Set();
  for (const expansion of expansions ?? []) {
    minted.add(expansion.fix_node_id);
    minted.add(expansion.review_node_id);
  }
  const nodeList = nodes.map((row) => {
    let dependencies = [];
    try {
      const parsed = JSON.parse(row.dependencies);
      if (Array.isArray(parsed)) dependencies = parsed.map(String);
    } catch {
      // 冻结快照 JSON 损坏:如实留空并在节点上标注。
      return {
        nodeId: row.node_id,
        role: row.role_id,
        state: row.state,
        definitionRevision: row.definition_revision,
        dependencies: null,
        expansionMinted: minted.has(row.node_id),
        dependenciesUnparseable: true
      };
    }
    return {
      nodeId: row.node_id,
      role: row.role_id,
      state: row.state,
      definitionRevision: row.definition_revision,
      dependencies,
      expansionMinted: minted.has(row.node_id)
    };
  });
  const edges = [];
  for (const node of nodeList) {
    for (const dep of node.dependencies ?? []) {
      edges.push({ from: dep, to: node.nodeId });
    }
  }
  return {
    available: true,
    nodeCount: nodeList.length,
    edgeCount: edges.length,
    nodes: nodeList,
    edges,
    expansionCount: (expansions ?? []).length
  };
}

function collectExecutions(db, runId) {
  const rows = tryAll(
    db,
    "SELECT phase, COUNT(*) AS c FROM executions WHERE run_id = ? GROUP BY phase ORDER BY phase",
    runId
  );
  if (rows === null) return { available: false };
  const byPhase = {};
  for (const row of rows) byPhase[row.phase] = Number(row.c);
  const totals = tryGet(
    db,
    "SELECT COUNT(*) AS total, COALESCE(MAX(attempt), 0) AS max_attempt, " +
      "COUNT(*) FILTER (WHERE attempt >= 2) AS retries, " +
      "MIN(created_at) AS first_at, MAX(updated_at) AS last_at " +
      "FROM executions WHERE run_id = ?",
    runId
  );
  const terminal = {
    SUCCEEDED: byPhase.SUCCEEDED ?? 0,
    FAILED: byPhase.FAILED ?? 0,
    INTERRUPTED: byPhase.INTERRUPTED ?? 0,
    CANCELLED: byPhase.CANCELLED ?? 0
  };
  const inFlight = Object.entries(byPhase)
    .filter(([phase]) => !(phase in terminal))
    .map(([phase, count]) => ({ phase, count }));
  return {
    available: true,
    total: Number(totals?.total ?? 0),
    terminalPhases: terminal,
    inFlightPhases: inFlight,
    retryCount: Number(totals?.retries ?? 0),
    maxAttempt: Number(totals?.max_attempt ?? 0),
    firstExecutionAt: totals?.first_at ?? null,
    lastExecutionUpdatedAt: totals?.last_at ?? null
  };
}

function collectApprovals(db, runId) {
  const rows = tryAll(
    db,
    "SELECT status, COUNT(*) AS c FROM approvals WHERE requested_by_run_id = ? GROUP BY status ORDER BY status",
    runId
  );
  if (rows === null) return { available: false };
  const byStatus = {};
  for (const row of rows) byStatus[row.status] = Number(row.c);
  const total = Object.values(byStatus).reduce((sum, count) => sum + count, 0);
  const checkpoints = tryAll(
    db,
    "SELECT status, COUNT(*) AS c FROM approval_checkpoints WHERE run_id = ? GROUP BY status ORDER BY status",
    runId
  );
  const checkpointByStatus = {};
  for (const row of checkpoints ?? []) checkpointByStatus[row.status] = Number(row.c);
  return {
    available: true,
    total,
    byStatus,
    checkpoints: {
      total: Object.values(checkpointByStatus).reduce((sum, count) => sum + count, 0),
      byStatus: checkpointByStatus
    }
  };
}

function collectReviewFails(db, runId) {
  const rows = tryAll(
    db,
    "SELECT state, verdict, COUNT(*) AS c FROM review_records WHERE run_id = ? GROUP BY state, verdict ORDER BY state, verdict",
    runId
  );
  if (rows === null) return { available: false };
  let fail = 0;
  let pass = 0;
  let blocked = 0;
  let invalid = 0;
  let other = 0;
  for (const row of rows) {
    const count = Number(row.c);
    if (row.state === "INVALID") {
      invalid += count;
    } else if (row.state === "COMPLETED" && row.verdict === "fail") {
      fail += count;
    } else if (row.state === "COMPLETED" && row.verdict === "pass") {
      pass += count;
    } else if (row.state === "COMPLETED" && row.verdict === "blocked") {
      blocked += count;
    } else {
      other += count;
    }
  }
  return { available: true, failCount: fail, passCount: pass, blockedCount: blocked, invalidCount: invalid, otherCount: other };
}

function collectContextHits(db, runId) {
  const row = tryGet(
    db,
    "SELECT COUNT(*) AS bundles, COALESCE(SUM(included_count), 0) AS included_fragments, " +
      "COALESCE(SUM(byte_count), 0) AS bytes FROM context_bundles WHERE run_id = ?",
    runId
  );
  if (row === null) return { available: false };
  return {
    available: true,
    bundleCount: Number(row.bundles),
    includedFragmentCount: Number(row.included_fragments),
    totalBytes: Number(row.bytes),
    note:
      "现状如实:v1 产品编排路径的 Memory/Context 读侧注入不 per-run 落新 bundle 行;" +
      "bundle assemble+persist 当前只有 context-e2e 驱动面(dogfood/browser-e2e)写入," +
      "真实产品 run 预期 0/无行(现状,非故障)。"
  };
}

/** ⑨ Memory 命中:无 run 级持久记录 → unknown(unknown-deny,不伪造)。 */
function collectMemoryHits(db, runId) {
  return { available: false, value: "unknown", note: UNKNOWN_MEMORY_HITS };
}

function collectDuration(db, runId, coreRow, executions) {
  const createdAt = coreRow.created_at;
  const lastAt = executions?.available ? executions.lastExecutionUpdatedAt : null;
  if (typeof createdAt !== "string" || typeof lastAt !== "string") {
    return { available: true, startedAt: createdAt ?? null, endedAt: null, wallMs: null };
  }
  const startMs = Date.parse(createdAt);
  const endMs = Date.parse(lastAt);
  const wallMs = Number.isFinite(startMs) && Number.isFinite(endMs) ? Math.max(0, endMs - startMs) : null;
  return { available: true, startedAt: createdAt, endedAt: lastAt, wallMs };
}

/** ⑪ CLI usage:探测 execution_usage;缺表→unknown(现状,见头注释)。 */
function collectCliUsage(db, runId) {
  if (!tableExists(db, "execution_usage")) {
    return { available: false, value: "unknown", note: UNKNOWN_CLI_USAGE };
  }
  const row = tryGet(
    db,
    "SELECT COUNT(*) AS total, " +
      "COUNT(*) FILTER (WHERE usage_status = 'recorded') AS recorded, " +
      "COUNT(*) FILTER (WHERE usage_status = 'unavailable') AS unavailable, " +
      "COUNT(*) FILTER (WHERE price_status = 'unknown') AS price_unknown, " +
      "COALESCE(SUM(input_tokens), 0) AS input_tokens, COALESCE(SUM(output_tokens), 0) AS output_tokens " +
      "FROM execution_usage WHERE run_id = ?",
    runId
  );
  return {
    available: true,
    executionCount: Number(row?.total ?? 0),
    recordedCount: Number(row?.recorded ?? 0),
    unavailableCount: Number(row?.unavailable ?? 0),
    priceUnknownCount: Number(row?.price_unknown ?? 0),
    inputTokens: Number(row?.input_tokens ?? 0),
    outputTokens: Number(row?.output_tokens ?? 0),
    note: "A37:unavailable 行无数值(不写 0);price unknown 行有 token 无费用。"
  };
}

function collectInterventions(db, runId) {
  const events = [];
  const approvals = tryAll(
    db,
    "SELECT id, requested_by_node_id, requested_by_attempt, action_digest, status, approved_by, approved_at, rejected_by, rejected_at, rejection_reason, created_at, updated_at " +
      "FROM approvals WHERE requested_by_run_id = ? ORDER BY created_at",
    runId
  );
  for (const row of approvals ?? []) {
    events.push({
      ts: row.created_at,
      kind: "approval-requested",
      detail: `approval ${row.id} node=${row.requested_by_node_id ?? "?"} attempt=${row.requested_by_attempt ?? "?"} digest=${String(row.action_digest).slice(0, 12)}`,
      approvalStatus: row.status
    });
    if (typeof row.approved_at === "string") {
      events.push({ ts: row.approved_at, kind: "approval-approved", detail: `approval ${row.id} by ${row.approved_by}`, approvalStatus: row.status });
    }
    if (typeof row.rejected_at === "string") {
      events.push({ ts: row.rejected_at, kind: "approval-rejected", detail: `approval ${row.id} by ${row.rejected_by}${row.rejection_reason ? `: ${row.rejection_reason}` : ""}`, approvalStatus: row.status });
    }
  }
  const checkpoints = tryAll(
    db,
    "SELECT id, node_id, status, continued_at, created_at, updated_at FROM approval_checkpoints WHERE run_id = ? ORDER BY created_at",
    runId
  );
  for (const row of checkpoints ?? []) {
    events.push({ ts: row.created_at, kind: "checkpoint-waiting", detail: `checkpoint ${row.id} node=${row.node_id} → ${row.status}`, checkpointStatus: row.status });
    if (typeof row.continued_at === "string") {
      events.push({ ts: row.continued_at, kind: "checkpoint-continued", detail: `checkpoint ${row.id} node=${row.node_id} 续行`, checkpointStatus: row.status });
    }
    if (row.status === "CANCELLED") {
      events.push({ ts: row.updated_at, kind: "checkpoint-cancelled", detail: `checkpoint ${row.id} node=${row.node_id} 取消`, checkpointStatus: row.status });
    }
  }
  const holds = tryAll(
    db,
    "SELECT id, reason, created_at, resolved_at, resolution_note FROM expansion_user_holds WHERE run_id = ? ORDER BY created_at",
    runId
  );
  for (const row of holds ?? []) {
    events.push({ ts: row.created_at, kind: "run-hold", detail: `hold ${row.id} (${row.reason}) 等待用户`, reason: row.reason });
    if (typeof row.resolved_at === "string") {
      events.push({ ts: row.resolved_at, kind: "run-hold-resolved", detail: `hold ${row.id} 已解除${row.resolution_note ? `: ${row.resolution_note}` : ""}`, reason: row.reason });
    }
  }
  events.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  return { available: true, count: events.length, timeline: events };
}

function collectDiffPointer(db, runId) {
  const rows = tryAll(
    db,
    "SELECT node_id, state, integration_branch, candidate_sha, conflict_files FROM integration_records WHERE run_id = ? ORDER BY node_id",
    runId
  );
  if (rows === null) return { available: false };
  return {
    available: true,
    records: rows.map((row) => ({
      nodeId: row.node_id,
      state: row.state,
      integrationBranch: row.integration_branch,
      candidateSha: row.candidate_sha,
      conflictFileCount:
        typeof row.conflict_files === "string"
          ? (JSON.parse(row.conflict_files) ?? []).length
          : null
    }))
  };
}

function collectRun(db, runId) {
  const core = collectRunCore(db, runId);
  if (!core) return null;
  const executions = collectExecutions(db, runId);
  return {
    id: core.id,
    projectId: core.project_id,
    taskId: core.task_id,
    baseSha: core.base_sha,
    graphRevision: Number(core.graph_revision),
    createdAt: core.created_at,
    metrics: {
      taskOutcome: {
        status: core.status,
        outcome: core.outcome ?? null
      },
      rolesUsed: collectRoles(db, runId),
      dagExpansion: collectDag(db, runId),
      executionCount: executions.available ? executions.total : "unknown",
      failuresRetries: executions.available
        ? {
            terminal: executions.terminalPhases,
            inFlight: executions.inFlightPhases,
            retryCount: executions.retryCount,
            maxAttempt: executions.maxAttempt
          }
        : "unknown",
      approvalCount: collectApprovals(db, runId),
      reviewerFails: collectReviewFails(db, runId),
      contextHits: collectContextHits(db, runId),
      memoryHits: collectMemoryHits(db, runId),
      wallDuration: collectDuration(db, runId, core, executions),
      cliUsage: collectCliUsage(db, runId),
      humanInterventions: collectInterventions(db, runId),
      finalDiffPointer: collectDiffPointer(db, runId)
    }
  };
}

// ---------------------------------------------------------------------------
// 渲染:json / md
// ---------------------------------------------------------------------------

const METRIC_LEGEND = [
  { id: "taskOutcome", label: "①任务成败", source: "task_runs.status+outcome(001/018)" },
  { id: "rolesUsed", label: "②用到的角色", source: "task_nodes.role_id + run_profile_snapshots(003/002)" },
  { id: "dagExpansion", label: "③DAG 实际展开", source: "task_nodes 节点+依赖边,review_expansions 标注扩图(003/013)" },
  { id: "executionCount", label: "④executions 数", source: "COUNT(executions by run)(001)" },
  { id: "failuresRetries", label: "⑤失败/重试", source: "executions 终态 phase 分类+attempt>=2 计数(001)" },
  { id: "approvalCount", label: "⑥审批次数", source: "approvals + approval_checkpoints by run(011/012)" },
  { id: "reviewerFails", label: "⑦Reviewer fail", source: "review_records state=COMPLETED verdict=fail(006)" },
  { id: "contextHits", label: "⑧上下文命中", source: "context_bundles by run(007;产品路径现状预期 0)" },
  { id: "memoryHits", label: "⑨Memory 命中", source: "unknown——无 run 级持久记录(读侧注入不落库)" },
  { id: "wallDuration", label: "⑩总耗时", source: "task_runs.created_at→MAX(executions.updated_at)区间近似(001)" },
  { id: "cliUsage", label: "⑪CLI usage", source: "unknown——execution_usage(014)不在产品链,JSONL tee 无 run 级关联" },
  { id: "humanInterventions", label: "⑫人工介入点", source: "approvals/checkpoints/expansion_user_holds 时间线(011/012/013)" },
  { id: "finalDiffPointer", label: "⑬最终 diff 指针", source: "integration_records branch+candidate_sha(005)" }
];

function renderJson(runs, meta) {
  return (
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        db: meta.dbPath,
        runFilter: meta.runFilter,
        readOnly: true,
        metricsLegend: METRIC_LEGEND,
        runs
      },
      null,
      2
    ) + "\n"
  );
}

function formatMs(ms) {
  if (typeof ms !== "number") return "unknown";
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (minutes === 0) return `${seconds}s`;
  if (hours === 0) return `${minutes}m${seconds % 60}s`;
  return `${hours}h${minutes % 60}m${seconds % 60}s`;
}

function cell(value) {
  const text = value === null || value === undefined ? "-" : String(value);
  return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function renderMd(runs, meta) {
  const lines = [];
  lines.push("# 使用统计摘要(usage-stats 只读导出)");
  lines.push("");
  lines.push(`- 生成时刻:${new Date().toISOString()}`);
  lines.push(`- 数据库:\`${meta.dbPath}\`(只读打开)`);
  lines.push(`- run 过滤:${meta.runFilter ?? "(全部)"}`);
  lines.push(`- run 数:${runs.length}`);
  lines.push("");
  lines.push("## 摘要表(每 run 一行,13 项指标)");
  lines.push("");
  lines.push(
    "| run | ①成败 status/outcome | ②角色(节点) | ③节点/边(扩图) | ④exec | ⑤终态 失败/中断/重试 | ⑥审批(状态) | ⑦review fail | ⑧ctx bundles | ⑨memory | ⑩耗时 | ⑪usage | ⑫介入点 | ⑬diff 指针 |"
  );
  lines.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const run of runs) {
    const m = run.metrics;
    const outcome = m.taskOutcome.outcome ?? "null(进行中)";
    const roles = m.rolesUsed.available
      ? m.rolesUsed.perRole.map((entry) => `${entry.role}:${entry.nodeCount}`).join(" ") || "-"
      : "unknown";
    const dag = m.dagExpansion.available
      ? `${m.dagExpansion.nodeCount}/${m.dagExpansion.edgeCount}${m.dagExpansion.expansionCount > 0 ? `(+${m.dagExpansion.expansionCount} 扩图)` : ""}`
      : "unknown";
    const exec = m.executionCount === "unknown" ? "unknown" : String(m.executionCount);
    const fails =
      m.failuresRetries === "unknown"
        ? "unknown"
        : `${m.failuresRetries.terminal.FAILED}/${m.failuresRetries.terminal.INTERRUPTED}/${m.failuresRetries.retryCount}`;
    const approvals = m.approvalCount.available
      ? `${m.approvalCount.total}(${Object.entries(m.approvalCount.byStatus).map(([status, count]) => `${status}:${count}`).join(" ") || "无"})`
      : "unknown";
    const reviews = m.reviewerFails.available ? String(m.reviewerFails.failCount) : "unknown";
    const ctx = m.contextHits.available ? String(m.contextHits.bundleCount) : "unknown";
    const memory = m.memoryHits?.value ?? "unknown";
    const duration = formatMs(m.wallDuration.wallMs);
    const usage = m.cliUsage?.available
      ? `${m.cliUsage.recordedCount}/${m.cliUsage.executionCount} exec 有 usage(in:${m.cliUsage.inputTokens}/out:${m.cliUsage.outputTokens} token${m.cliUsage.priceUnknownCount > 0 ? `;price unknown:${m.cliUsage.priceUnknownCount}` : ""})`
      : (m.cliUsage?.value ?? "unknown");
    const interventions = m.humanInterventions.available ? String(m.humanInterventions.count) : "unknown";
    const diff =
      m.finalDiffPointer.available && m.finalDiffPointer.records.length > 0
        ? m.finalDiffPointer.records
            .map((record) =>
              record.candidateSha
                ? `${record.integrationBranch}@${String(record.candidateSha).slice(0, 10)}(${record.state})`
                : `${record.integrationBranch}(无候选 SHA,${record.state})`
            )
            .join("; ")
        : m.finalDiffPointer.available
          ? "无集成记录"
          : "unknown";
    lines.push(
      `| ${cell(run.id)} | ${cell(run.metrics.taskOutcome.status)} / ${cell(outcome)} | ${cell(roles)} | ${cell(dag)} | ${cell(exec)} | ${cell(fails)} | ${cell(approvals)} | ${cell(reviews)} | ${cell(ctx)} | ${cell(memory)} | ${cell(duration)} | ${cell(usage)} | ${cell(interventions)} | ${cell(diff)} |`
    );
  }
  lines.push("");
  lines.push("## run 明细与 unknown 说明");
  lines.push("");
  for (const run of runs) {
    const m = run.metrics;
    lines.push(`### ${run.id}`);
    lines.push("");
    lines.push(`- 项目:${run.projectId} · task:${run.taskId} · baseSha:${run.baseSha} · 建于:${run.createdAt}`);
    if (m.rolesUsed.available && m.rolesUsed.profileSnapshots.length > 0) {
      lines.push(
        `- 冻结 Profile 快照:${m.rolesUsed.profileSnapshots
          .map((snapshot) => `${snapshot.role}→${snapshot.profileId}@r${snapshot.profileRevision}`)
          .join(", ")}`
      );
    }
    if (m.contextHits.available && m.contextHits.bundleCount === 0) {
      lines.push(`- ⑧上下文命中注记:${m.contextHits.note}`);
    }
    if (m.memoryHits?.note) {
      lines.push(`- ⑨Memory 命中:${m.memoryHits.note}`);
    }
    if (m.cliUsage?.note) {
      lines.push(`- ⑪CLI usage:${m.cliUsage.note}`);
    }
    if (m.wallDuration.wallMs === null) {
      lines.push("- ⑩总耗时:无可执行行(无 executions),区间未知。");
    }
    lines.push("");
    if (m.dagExpansion.available) {
      lines.push("<details><summary>DAG 节点明细</summary>");
      lines.push("");
      lines.push("| node | role | state | deps | 扩图产物 |");
      lines.push("|---|---|---|---|---|");
      for (const node of m.dagExpansion.nodes) {
        lines.push(
          `| ${cell(node.nodeId)} | ${cell(node.role)} | ${cell(node.state)} | ${cell((node.dependencies ?? []).join(", ") || "-")} | ${node.expansionMinted ? "是" : "否"} |`
        );
      }
      lines.push("");
      lines.push("</details>");
      lines.push("");
    }
    if (m.humanInterventions.available && m.humanInterventions.count > 0) {
      lines.push("<details><summary>人工介入时间线</summary>");
      lines.push("");
      for (const event of m.humanInterventions.timeline) {
        lines.push(`- \`${event.ts}\` ${cell(event.kind)} — ${cell(event.detail)}`);
      }
      lines.push("");
      lines.push("</details>");
      lines.push("");
    }
  }
  lines.push("## 指标口径(聚合口径速览)");
  lines.push("");
  lines.push("| 指标 | 来源与口径 |");
  lines.push("|---|---|");
  for (const legend of METRIC_LEGEND) {
    lines.push(`| ${legend.label} | ${cell(legend.source)} |`);
  }
  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(
      "用法: node scripts/usage-stats.mjs --db <SQLite 路径> [--format json|md] [--run <runId>]\n" +
        "只读导出每个 task_run 的 13 项使用指标(BACKLOG V031-02);口径见脚本头注释。\n"
    );
    process.exit(0);
  }
  const db = openReadOnly(options.db);
  let runIds;
  if (options.run !== null) {
    const exists = tryGet(db, "SELECT id FROM task_runs WHERE id = ?", options.run);
    if (!exists) {
      process.stderr.write(`usage-stats: 库中不存在 run "${options.run}"\n`);
      db.close();
      process.exit(3);
    }
    runIds = [options.run];
  } else {
    const rows = tryAll(db, "SELECT id FROM task_runs ORDER BY created_at, id");
    if (rows === null) {
      process.stderr.write("usage-stats: 库中没有 task_runs 表(不是本产品初始化的库?)\n");
      db.close();
      process.exit(3);
    }
    runIds = rows.map((row) => row.id);
  }
  const runs = [];
  for (const runId of runIds) {
    const run = collectRun(db, runId);
    if (run !== null) runs.push(run);
  }
  db.close();
  const meta = { dbPath: options.db, runFilter: options.run };
  const text = options.format === "md" ? renderMd(runs, meta) : renderJson(runs, meta);
  process.stdout.write(text);
  process.exit(0);
}

main();
