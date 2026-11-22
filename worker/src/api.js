// The worker's only connection: outbound HTTPS to the Supabase REST API, calling the three mai_worker_* database functions with
// the project's public (anon) key plus this worker's own token. No service-role key, no AI provider key, no open ports.
export class NotAuthorized extends Error {}

export function makeApi({ url, anonKey, token, timeoutMs = 15_000 }) {
  let lastMs = null;
  async function call(fn, args) {
    const started = Date.now();
    const res = await fetch(`${url}/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ p_token: token, ...args }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    lastMs = Date.now() - started;
    const text = await res.text();
    let body = null; try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    if (!res.ok) {
      const msg = String(body?.message || body || res.statusText);
      if (/not authorized/i.test(msg)) throw new NotAuthorized("This worker is disconnected or its token is wrong");
      throw new Error(`${fn} failed (${res.status}): ${msg.slice(0, 200)}`);
    }
    return body;
  }
  return {
    lastRpcMs: () => lastMs,
    heartbeat: (metrics, state, reason, version, hostname, startedAt) =>
      call("mai_worker_heartbeat", { p_metrics: metrics, p_state: state, p_reason: reason, p_version: version, p_hostname: hostname, p_started_at: startedAt }),
    claim: () => call("mai_worker_claim", {}),
    complete: (jobId, ok, result, error, retryable = true) =>
      call("mai_worker_complete", { p_job: jobId, p_ok: ok, p_result: result ?? null, p_error: error ?? null, p_retryable: retryable }),
    // laptop developer (v3_24): approved developer requests only; can report IN_PROGRESS / NEEDS_INFO / READY_FOR_REVIEW / REJECTED
    devClaim: () => call("mai_worker_dev_claim", {}),
    devReport: (ref, status, note, branch, commit) =>
      call("mai_worker_dev_report", { p_ref: ref, p_status: status, p_note: String(note).slice(0, 3900), p_branch: branch ?? null, p_commit: commit ?? null }),
    // v3_26 live build: log lines, the laptop's check report + branch diff, and Owner-approved merges (local main only)
    devLog: (ref, lines) => call("mai_worker_dev_log", { p_ref: ref, p_lines: lines.slice(0, 200) }),
    devResult: (ref, checks, diffStat, diffPatch) =>
      call("mai_worker_dev_result", { p_ref: ref, p_checks: checks ?? [], p_diff_stat: diffStat ?? null, p_diff_patch: diffPatch ?? null }),
    devMergeClaim: () => call("mai_worker_dev_merge_claim", {}),
    devMergeReport: (ref, ok, note, mergedCommit) =>
      call("mai_worker_dev_merge_report", { p_ref: ref, p_ok: !!ok, p_note: String(note).slice(0, 3900), p_merged_commit: mergedCommit ?? null }),
  };
}
