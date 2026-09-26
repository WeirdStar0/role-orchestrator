# @role-orchestrator/reconcile

M1-05 startup reconcile: scan non-terminal executions after a daemon
(re)start, decide what happened to each attempt, apply idempotent
dispositions, and serve the interrupted list.

Depends only on `@role-orchestrator/store` (durable state) plus the OS
process query. It never launches a process, never re-sends a dispatch
command, and never kills anything — the A23 constraint plus typed
dispositions are the whole safety story.

## Startup scan

`reconcileStartup(db, input)` lists every attempt whose phase is one of
`ACTIVE_ATTEMPT_PHASES` (`PREPARING`, `STARTING`, `RUNNING`, `FINALIZING` —
exactly the set the A23 partial unique index `ux_executions_one_active_per_slot`
covers) and decides per row:

| Recorded state | Probe / evidence | Outcome | Reason |
|---|---|---|---|
| no pid identity | phase `PREPARING` | interrupted | `never-started-preparing` |
| no pid identity | phase `STARTING`/`RUNNING`/`FINALIZING` | recovery-required | `launch-window-undetermined` |
| pid identity | probe: no live holder (query succeeded, empty result) | interrupted | `process-gone` |
| pid identity | probe: live holder, creation time within tolerance | observed-running | `process-alive-identity-confirmed` |
| pid identity | probe: live holder created AFTER the recorded identity | interrupted | `pid-reused-identity-mismatch` |
| pid identity | probe: live holder created BEFORE the recorded identity | recovery-required | `identity-time-anomaly` |
| pid identity | probe: query failed / timed out / unparseable | recovery-required | `probe-indeterminate` |
| pid identity | probe: live holder without parseable creation time | recovery-required | `probe-identity-incomplete` |
| pid identity | recorded target other than `windows-native` | recovery-required | `probe-unsupported-target` |
| (operator action) | `resolveRecoveryItem` on a recovery-required row | interrupted | `recovery-resolved` |

Design inputs are the M0-05 launcher conclusions (`reports/M0-05-windows-launcher.md`):
Windows reuses PID values within seconds, so identity is decided by the
`Win32_Process` creation timestamp — the `pid + creationTime` pair recorded by
the engine at spawn time — never by the pid value alone. "PID reused" is
handled without misidentification and without killing: the recorded attempt is
interrupted, the unrelated live holder is left strictly alone (A27).

## Outcomes and what they write

- `interrupted` — one transaction: a `reconcile_interrupted` marker event
  (deterministic id, checksummed like every event) plus the guarded phase move
  to `INTERRUPTED`. This frees the A23 slot: a NEW attempt (never a re-dispatch
  of the old one) may now be created.
- `recovery-required` — a `reconcile_recovery_required` marker event only. The
  row deliberately STAYS in its active phase, so the A23 partial unique index
  keeps the slot blocked at the constraint level: nothing can auto re-run
  (A22). A human resolves the item via `resolveRecoveryItem`, which moves it to
  `INTERRUPTED` — only then can a new attempt be created.
- `observed-running` — a `reconcile_observed_running` marker event only; the
  phase is untouched. The process is alive and its identity matches, but this
  daemon instance owns no pipe to it, so the item is surfaced for observation
  resumption.

`RECOVERY_REQUIRED` is a reconcile STATUS, not a new execution phase: the
frozen `executions` schema keeps its eight phases, and `docs/DOMAIN_MODEL.md`
places `RECOVERY_REQUIRED` in the node state machine (nodes arrive with M2-01).
Until then the status lives in the marker events and is served by
`listRecoveryItems`, while the constraint-level "no auto re-run" guarantee
comes from the attempt remaining active.

## The interrupted list

`listRecoveryItems(db)` returns every entry needing human or follow-up
handling:

- phase `INTERRUPTED` — `status: "INTERRUPTED"`, follow-up `retry-or-cancel`;
- active with a recovery-required marker — `status: "RECOVERY_REQUIRED"`,
  follow-up `manual-recovery`;
- active with an observed-running marker — `status: "RUNNING_CONFIRMED"`,
  follow-up `resume-observation`.

Plainly RUNNING rows without a reconcile marker belong to a live daemon and
are not listed; terminal rows are never listed. Each item carries the A22
side-effect evidence (pending `execution.dispatch-requested` outbox message
ids and whether protocol events exist).

## Idempotency and concurrency

Every write re-reads the row inside one `BEGIN IMMEDIATE` transaction and
guards the phase move with the exact phase the decision was made on; marker
event ids are deterministic per (execution, kind). Two concurrent scans — two
connections, two processes, or a race with the engine's terminal write —
therefore serialize, and the loser reports `already-applied` or
`phase-changed` instead of writing twice. Scans never throw for "someone got
there first".

## Testing

`packages/reconcile/test` covers the pure decision table (no processes), the
store-level scan semantics with an injected probe (interrupted-and-retryable,
A24 recovery window and slot blocking, concurrent idempotency across two
connections, no-changes on terminal rows, list composition), and — on Windows
— the real-process combination: a killed fake-cli child reconcile, a PID-reuse
simulation with a live placeholder holder that must survive the scan, and an
engine dogfood run confirmed running and then finalized.
