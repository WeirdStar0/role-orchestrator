/**
 * First link of the grandchild spawn chain. Writes both PIDs to the report
 * file requested by the fake CLI root, then hangs until killed.
 */
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index < 0) return undefined;
  return process.argv[index + 1];
}

const reportFile = argValue("--report-file");
if (reportFile === undefined || reportFile === "") {
  process.stderr.write("SYNTHETIC chain child: missing --report-file\n");
  process.exit(2);
}

const grandchildJs = fileURLToPath(new URL("./grandchild.js", import.meta.url));
const grandchild = spawn(process.execPath, [grandchildJs], {
  stdio: "ignore",
  windowsHide: true
});

grandchild.once("spawn", () => {
  writeFileSync(
    reportFile,
    JSON.stringify({ childPid: process.pid, grandchildPid: grandchild.pid, synthetic: true }),
    "utf8"
  );
});

grandchild.once("error", (error) => {
  process.stderr.write(`SYNTHETIC chain child: failed to spawn grandchild: ${String(error)}\n`);
  process.exit(3);
});

// Hang until killed; the grandchild hangs on its own.
setInterval(() => {}, 3_600_000);
