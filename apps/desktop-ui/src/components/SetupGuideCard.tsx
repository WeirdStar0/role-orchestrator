/**
 * M11-02 首启向导卡(纯展示组件):the one guide card the home page mounts
 * above the hero when the profiles config is not in use yet, and the
 * /app/setup wizard page hosts standalone. All state comes in through
 * props (the pages own the probe/POST effects) so every phase is
 * renderToString-testable without fetch mocks.
 *
 * 人话 discipline: Claude Code / Codex by product name, roles by their
 * human names — NO internal identifiers (profile ids, source paths, role
 * enum literals as ids) are ever rendered. Links: the old workbench is a
 * NATIVE <a href="/"> (basename defect, handover A); 去新建任务 is an
 * INTERNAL router Link (stays under /app).
 */
import type { ReactNode } from "react";
import { Check, LoaderCircle, Sparkles, TriangleAlert } from "lucide-react";
import { Card, FormStatus } from "./ui";

export type SetupGuideState =
  /** Probe in flight (the setup page renders a mild line; the home page
   * renders nothing until the probe settles — no flash, zero noise when
   * the probe is refused, e.g. in a plain browser). */
  | { readonly phase: "checking" }
  /** Unconfigured: the guide is due. `fileState` distinguishes the honest
   * generate-capable states (absent = first-run will create; unparseable =
   * first-run will repair/replace) from `unwired` (the server has no
   * --profiles wiring: generation is refused, guidance only). */
  | {
      readonly phase: "ready";
      readonly claudeFound: boolean;
      readonly codexFound: boolean;
      readonly fileState: "absent" | "unparseable" | "unwired";
    }
  /** Configured but the RUNNING process has not loaded it yet (written by
   * a previous first-run, server not restarted): the persistent honest
   * restart hint — never a fake "already active". */
  | { readonly phase: "restart-pending" }
  /** Configured AND loaded: nothing to do — the wizard's happy steady state. */
  | { readonly phase: "all-set" }
  | { readonly phase: "working"; readonly claudeFound: boolean; readonly codexFound: boolean }
  | { readonly phase: "done"; readonly mode: "created" | "replaced"; readonly profileCount: number }
  | { readonly phase: "error"; readonly message: string; readonly misses: readonly string[] };

const CLAUDE_NAME = "Claude Code";
const CODEX_NAME = "Codex";

function cliName(found: boolean, name: string): string {
  return found ? `${name} ✓` : name;
}

export function SetupGuideCard(props: {
  readonly state: SetupGuideState;
  readonly onGenerate: () => void;
}): ReactNode {
  const { state, onGenerate } = props;
  if (state.phase === "checking") {
    return (
      <Card>
        <p className="page-subtitle">正在检测本机已安装的 AI 命令行…</p>
      </Card>
    );
  }
  if (state.phase === "restart-pending") {
    return (
      <Card>
        <p className="form-status form-status-success" role="status">
          <Check size={16} /> 推荐配置已生成——重启桌面应用后生效。
        </p>
        <p className="page-subtitle">重启后这段引导会自动消失,届时直接在下方新建任务即可。</p>
      </Card>
    );
  }
  if (state.phase === "all-set") {
    return (
      <Card>
        <p className="form-status form-status-success" role="status">
          <Check size={16} /> AI 配置已就绪,无需初始设置。
        </p>
        <p className="page-subtitle">
          需要调整时请用<a className="inline-link" href="/">旧工作台(/)</a>的「配置」页;完整设置界面在 M11-05 到来。
        </p>
      </Card>
    );
  }
  if (state.phase === "done") {
    return (
      <Card>
        <p className="form-status form-status-success" role="status">
          <Check size={16} /> 已生成推荐配置({String(state.profileCount)} 个默认 AI 配置)——
          重启桌面应用后生效。
        </p>
        <p className="page-subtitle">
          重启后即可开始第一个任务;推荐分工之后随时可以在
          <a className="inline-link" href="/">旧工作台(/)</a>的「配置」页调整。
        </p>
      </Card>
    );
  }
  if (state.phase === "error") {
    return (
      <Card>
        <FormStatus kind="error">{state.message}</FormStatus>
        {state.misses.length > 0 ? (
          <p className="page-subtitle">本次未检测到:{state.misses.join("、")}</p>
        ) : null}
        <p className="page-subtitle">
          也可以先跳过自动配置,到<a className="inline-link" href="/">旧工作台(/)</a>
          的「配置」页手动完成。
        </p>
      </Card>
    );
  }

  // ready / working — the generate-facing states.
  const bothFound = state.claudeFound && state.codexFound;
  const someFound = state.claudeFound || state.codexFound;
  const detectedLine = bothFound
    ? `检测到 ${CLAUDE_NAME} ✓ 与 ${CODEX_NAME} ✓`
    : state.claudeFound
      ? `检测到 ${cliName(true, CLAUDE_NAME)}(未检测到 ${CODEX_NAME})`
      : state.codexFound
        ? `检测到 ${cliName(true, CODEX_NAME)}(未检测到 ${CLAUDE_NAME})`
        : "未检测到 Claude Code,也未检测到 Codex。";
  const divisionLine =
    bothFound
      ? "推荐分工:Claude Code 负责协调、架构与评审,Codex 负责开发。"
      : state.claudeFound
        ? "四个角色(协调、架构、开发、评审)都将由 Claude Code 承担。"
        : state.codexFound
          ? "四个角色(协调、架构、开发、评审)都将由 Codex 承担。"
          : "";
  const canGenerate =
    someFound && (state.phase === "working" || state.fileState !== "unwired");

  return (
    <Card>
      <p className="setup-guide-head">
        <Sparkles size={16} /> {detectedLine}
      </p>
      {divisionLine !== "" ? <p className="page-subtitle">{divisionLine}</p> : null}
      {canGenerate ? (
        <>
          <p className="page-subtitle">
            一键生成推荐的 AI 配置(写入本机的配置文件;现有可用配置不会被覆盖)。
          </p>
          <button type="button" className="btn btn-primary" onClick={onGenerate} disabled={state.phase === "working"}>
            {state.phase === "working" ? <LoaderCircle size={16} className="spin" /> : <Sparkles size={16} />}
            生成推荐配置
          </button>
        </>
      ) : (
        <p className="page-subtitle">
          <TriangleAlert size={14} />{" "}
          {state.phase === "ready" && state.fileState === "unwired"
            ? "本服务进程没有接入 AI 配置文件,自动生成暂时不可用。"
            : "请先安装任一 AI 命令行工具(或将其加入 PATH),然后重试。"}{" "}
          也可以到<a className="inline-link" href="/">旧工作台(/)</a>的「配置」页手动配置。
        </p>
      )}
    </Card>
  );
}
