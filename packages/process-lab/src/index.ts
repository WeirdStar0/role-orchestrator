/**
 * Public surface of the process lab. Everything here is observation
 * tooling for the M0-05 launcher verification; no product code depends on
 * this package.
 */
export { LineCollector, exitPromise, findJsonValue, sleep, waitForLine, withTimeout, type ExitInfo } from "./lines.js";
export { expectPidGone, isAlive, queryProcessIdentity, type ProcessIdentity } from "./proc.js";
export { taskkill, type TaskkillOptions, type TaskkillOutcome } from "./taskkill.js";
export { writeCmdShim, type CmdShim } from "./shim.js";
export { requiredPid, spawnCmdProcess, spawnNodeProcess, type Proc } from "./spawnproc.js";
export { fakeCliDistSource, installFakeCli, parseGrandchildReport, type FakeCliInstall, type FakeDialect, type GrandchildReport } from "./fakecli.js";
export { observePidReuse, sampleLiveness, type PidReuseObservation, type PidReuseOptions } from "./pidreuse.js";
export { TreeRegistry } from "./registry.js";
export { driveOf, makeScratchDir, makeUnicodeScratchDir, removeScratch, type LabResult } from "./scratch.js";
export { parseWslDriverJson, probeWsl, windowsPathToWsl, writeWslDriver, wslSh, type WslProbe, type WslRunResult } from "./wsl.js";
