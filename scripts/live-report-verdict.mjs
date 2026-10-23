/*
 * Pass/fail for scripts/verify-ux-live.mjs. The live script keeps running
 * after a scenario throws so later scenarios still produce screenshots; this
 * verdict makes the run itself fail when any requested scenario errored, was
 * skipped (unless skips were allowed) or never ran.
 */
export function liveReportVerdict(report, { requested, unknown = [], allowSkips = false }) {
  const failures = unknown.map((name) => `unknown scenario name: ${name}`);
  for (const name of requested) {
    const entries = report.filter((entry) => entry.scenario === name);
    for (const entry of entries) {
      if (entry.error) failures.push(`${name}: ${entry.error}`);
      else if (entry.skipped && !allowSkips) failures.push(`${name}: skipped (${entry.skipped})`);
    }
    if (!entries.some((entry) => entry.completed || entry.error)) failures.push(`${name}: did not run`);
  }
  return { ok: failures.length === 0, failures };
}
