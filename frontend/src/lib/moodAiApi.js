import { supabase } from "./supabase";

// Mood AI Core (mvp_pilot_mood_ai_core_v3_19.sql + the mood-ai edge function). Every change is a mai_* database function that
// checks the caller: Owner/Backup actions also need a fresh authenticator-app check (Supabase MFA, aal2). No model key is here.

const rpc = async (name, args) => {
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw error;
  return data;
};

export const controlCenter = () => rpc("mai_control_center");
export const publicStatus = () => rpc("mai_public_status");
export const emergencyStop = (reason) => rpc("mai_emergency_stop", { p_reason: reason });
export const resumeAi = () => rpc("mai_resume");
export const updateSettings = (patch) => rpc("mai_update_settings", { p: patch });
export const setModelPrice = (provider, model, input, output, enabled) =>
  rpc("mai_set_model_price", { p_provider: provider, p_model: model, p_input: input, p_output: output, p_enabled: enabled });
export const setAgent = (code, enabled) => rpc("mai_set_agent", { p_code: code, p_enabled: enabled });
export const setBackup = (userId, active) => rpc("mai_set_backup", { p_user: userId, p_active: active });

export async function runHealthCheck() {
  const { data, error } = await supabase.functions.invoke("mood-ai", { body: { action: "health" } });
  if (error) {
    let reason = "Could not reach Mood AI. Please try again.";
    try { const b = await error?.context?.json?.(); if (b && typeof b.error === "string") reason = b.error; } catch { /* not JSON */ }
    return { ok: false, reason };
  }
  return data?.ok ? { ok: true, results: data.results } : { ok: false, reason: data?.error || "Health check failed." };
}

// ---- Owner verification (Supabase MFA, authenticator app / TOTP)
export async function mfaState() {
  const [{ data: aal }, { data: factors }] = await Promise.all([supabase.auth.mfa.getAuthenticatorAssuranceLevel(), supabase.auth.mfa.listFactors()]);
  const verified = (factors?.totp || []).filter((f) => f.status === "verified");
  return { level: aal?.currentLevel || "aal1", enrolled: verified.length > 0, factorId: verified[0]?.id || null };
}
export async function mfaStartEnroll() {
  // Remove an earlier, never-finished setup so a fresh QR code can be made.
  const { data: factors } = await supabase.auth.mfa.listFactors();
  for (const f of (factors?.all || []).filter((x) => x.factor_type === "totp" && x.status !== "verified")) await supabase.auth.mfa.unenroll({ factorId: f.id });
  const { data, error } = await supabase.auth.mfa.enroll({ factorType: "totp", friendlyName: "Mood AI owner" });
  if (error) throw error;
  return { factorId: data.id, qr: data.totp.qr_code, secret: data.totp.secret };
}
export async function mfaVerify(factorId, code) {
  const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId, code: String(code).trim() });
  if (error) throw error;
}

export const fmtUsd = (v) => (v === null || v === undefined ? "—" : `$${Number(v).toFixed(Number(v) < 1 ? 4 : 2)}`);
export const fmtMs = (v) => (v === null || v === undefined ? "—" : Number(v) >= 1000 ? `${(Number(v) / 1000).toFixed(1)} s` : `${Math.round(Number(v))} ms`);

// ---- floating chat (v3_22, Phase C). History is private to each person; replies are written by the server only.
export const chatStatus = () => rpc("mai_chat_status");
export const chatThreads = () => rpc("mai_chat_threads_list");
export const chatThread = (id) => rpc("mai_chat_thread", { p_thread: id });
export const chatHideThread = (id) => rpc("mai_chat_hide_thread", { p_thread: id });

export async function chatSend({ thread_id, message, page, departments, management }) {
  const { data, error } = await supabase.functions.invoke("mood-ai", { body: { action: "chat", thread_id, message, page, departments, management } });
  if (error) {
    let body = null;
    try { body = await error?.context?.json?.(); } catch { /* not JSON */ }
    return { ok: false, code: body?.code || "network", error: body?.error || "Could not reach Mood AI. Check your internet and try again.", thread_id: body?.thread_id };
  }
  return data;
}
