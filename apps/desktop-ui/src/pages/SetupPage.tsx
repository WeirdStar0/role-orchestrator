/**
 * M11-02 首启向导页(/app/setup):the standalone first-run wizard. It owns
 * the same probe/POST state machine the home guide card uses (shared pure
 * card component; the SIDE EFFECTS — GET /api/v1/setup/status on mount,
 * POST /api/v1/setup/first-run with the session CSRF — live here). This
 * route is deliberately NOT a fifth sidebar entry: the product baseline
 * freezes the sidebar to exactly four entries, so the wizard is reached
 * from the home guide card. Copy is 人话 only; no internal identifier is
 * ever rendered.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { ApiError, applyFirstRun, fetchCsrfToken, fetchSetupStatus, type SetupStatus } from "../api";
import { firstRunFailureText, notFoundMissNames } from "../runErrors";
import { SetupGuideCard, type SetupGuideState } from "../components/SetupGuideCard";
import { createOneShotGate, type OneShotGate } from "../oneShotGate";

/** Project the endpoint status onto the card state (pure). null = no card
 * due (configured AND already loaded by this process — the happy steady
 * state; or the probe was refused: plain browser, zero noise). */
export function setupGuideStateFromStatus(status: SetupStatus): SetupGuideState | null {
  const { fileState, loadedProfiles } = status.profiles;
  if (fileState === "configured") {
    // usableProfiles >= 1 is the parser's guarantee (min(1)); the honest
    // restart-pending hint keys on the RUNNING process not having loaded it.
    return loadedProfiles > 0 ? null : { phase: "restart-pending" };
  }
  return {
    phase: "ready",
    claudeFound: status.claudeFound,
    codexFound: status.codexFound,
    fileState
  };
}

export function SetupPage(): ReactNode {
  const [state, setState] = useState<SetupGuideState>({ phase: "checking" });
  /** M11-02 review handover C: the synchronous double-fire gate (the same
   * fix the home page's generateDefaults got — the phase-only guard let a
   * rapid double-click through twice because state updates are async). */
  const generateGate = useRef<OneShotGate | null>(null);
  if (generateGate.current === null) {
    generateGate.current = createOneShotGate();
  }

  useEffect(() => {
    let cancelled = false;
    fetchSetupStatus()
      .then((status) => {
        if (cancelled) return;
        const projected = setupGuideStateFromStatus(status);
        // null = configured AND already loaded by this process: the happy
        // steady state — the wizard says so, it does not re-offer anything.
        setState(projected ?? { phase: "all-set" });
      })
      .catch(() => {
        if (cancelled) return;
        // The probe is refused (plain browser) or malformed: the wizard says
        // so honestly instead of pretending detection ran.
        setState({
          phase: "error",
          message: "无法读取检测状态(本页在浏览器直开时没有会话凭据,或服务不可用)。请在桌面应用内使用。",
          misses: []
        });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const generate = (): void => {
    // Handover C: the gate claim is SYNCHRONOUS — the second click of a
    // double-click is refused before any state update can re-render.
    if (generateGate.current === null || !generateGate.current.take()) return;
    if (state.phase !== "ready") {
      generateGate.current.release();
      return;
    }
    setState({ phase: "working", claudeFound: state.claudeFound, codexFound: state.codexFound });
    fetchCsrfToken()
      .then((csrf) => {
        if (csrf === null) {
          throw new ApiError(403, "NOT_AUTHENTICATED", "无法取得会话凭据(CSRF)。");
        }
        return applyFirstRun(csrf);
      })
      .then((result) => {
        setState({ phase: "done", mode: result.mode, profileCount: result.profileCount });
      })
      .catch((error: unknown) => {
        // Handover B: the miss list is translated at the extraction site —
        // product names, consistent with the main refusal message.
        setState({ phase: "error", message: firstRunFailureText(error), misses: notFoundMissNames(error) });
      })
      .finally(() => {
        generateGate.current?.release();
      });
  };

  return (
    <div className="app-main-inner">
      <h1 className="page-title">初始设置</h1>
      <p className="page-subtitle">
        首次使用向导:检测本机已安装的 AI 命令行,一键生成推荐配置。这一步只需要做一次;
        之后随时可以在<a className="inline-link" href="/">旧工作台(/)</a>的「配置」页细调。
      </p>
      <SetupGuideCard state={state} onGenerate={generate} />
      {state.phase === "done" ? (
        <p className="form-status">
          完成?回<Link className="inline-link" to="/">新任务</Link>开始第一个任务(重启桌面应用后配置生效)。
        </p>
      ) : null}
    </div>
  );
}
