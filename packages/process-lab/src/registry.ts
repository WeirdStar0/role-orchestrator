/**
 * Safety net for tests and experiment runs: every spawned tree gets
 * registered, and after each test (or experiment step) the registry force-
 * kills whatever is still alive so a failing assertion can never leak a
 * hanging fake-cli process into the developer's machine.
 */
import { isAlive } from "./proc.js";
import { taskkill } from "./taskkill.js";

export class TreeRegistry {
  private readonly pids = new Set<number>();

  add(pid: number): void {
    this.pids.add(pid);
  }

  /** taskkill /T /F on every registered PID that still looks alive. */
  async reapAll(): Promise<void> {
    for (const pid of [...this.pids]) {
      if (isAlive(pid)) {
        await taskkill(pid, { tree: true, force: true });
      }
      this.pids.delete(pid);
    }
  }

  get size(): number {
    return this.pids.size;
  }
}
