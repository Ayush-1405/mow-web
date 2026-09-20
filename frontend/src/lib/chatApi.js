import { supabase } from "./supabase";
import { subscribeTable } from "./realtime";

// Internal chat data layer. Authorization lives in the database: reads are RLS-limited to conversations the
// caller is an ACTIVE participant of, and every write (create / send / edit / delete / read / mute / open)
// is a SECURITY DEFINER RPC that re-checks membership. Nothing here decides who may see or message whom.

export const TYPE_LABEL = { direct: "Direct", department: "Department", team: "Team", task: "Task", job_card: "Job Card", bridge: "Bridge", management: "Management" };
export const CHAT_MAX_FILE_MB = 15;
export const CHAT_EDIT_WINDOW_MIN = 15;
export const CHAT_ACCEPT = "image/jpeg,image/png,image/webp,image/heic,image/heif,application/pdf,.doc,.docx,.xls,.xlsx,.csv,.dwg,.dxf";
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ALLOWED_MIME = new Set([
  "image/jpeg", "image/png", "image/webp", "image/heic", "image/heif", "application/pdf", "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "text/csv", "application/dxf", "application/dwg",
  "image/vnd.dwg", "image/vnd.dxf", "application/x-dwg", "application/x-dxf", "application/acad",
]);
const EXT_MIME = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", heic: "image/heic", heif: "image/heif", pdf: "application/pdf",
  doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", csv: "text/csv", dwg: "application/dwg", dxf: "application/dxf",
};

export function chatMimeOf(file) {
  if (file.type && ALLOWED_MIME.has(file.type)) return file.type;
  const ext = (file.name.split(".").pop() || "").toLowerCase();
  return EXT_MIME[ext] || null;
}

const rpc = (name, args) => supabase.rpc(name, args || {});

// conversationId = fetch exactly ONE list row (used after a Realtime event about that conversation)
export const listConversations = (types = null, unreadOnly = false, conversationId = null) =>
  rpc("chat_list_conversations", { p_types: types, p_unread_only: unreadOnly, p_conversation: conversationId });
export const unreadTotal = () => rpc("chat_unread_total");
export const getDetails = (id) => rpc("chat_conversation_details", { p_conversation: id });
export const searchUsers = (q) => rpc("chat_search_users", { p_query: q || null, p_limit: 30 });
export const startDirect = (userId) => rpc("chat_get_or_create_direct", { p_other: userId });
export const openTaskChat = (taskId) => rpc("chat_open_task", { p_task: taskId });
export const openJobChat = (jobId) => rpc("chat_open_job", { p_job: jobId });
// resolves { data: true } only when something was actually written; the server treats "nothing new" as a no-op
export const markRead = (id) => rpc("chat_mark_read", { p_conversation: id });
export const setMuted = (id, muted) => rpc("chat_toggle_mute", { p_conversation: id, p_muted: muted });
export const editMessage = (id, body) => rpc("chat_edit_message", { p_message: id, p_body: body });
export const deleteMessage = (id, reason) => rpc("chat_delete_message", { p_message: id, p_reason: reason || null });
export const searchMessages = (q, conversationId) => rpc("chat_search_messages", { p_query: q, p_conversation: conversationId || null, p_limit: 30 });
export const managementDirectory = (q, type) => rpc("chat_management_directory", { p_query: q || null, p_type: type || null });
export const managementOpen = (id, reason) => rpc("chat_management_open", { p_conversation: id, p_reason: reason });

export function sendMessage({ conversationId, body, replyTo, mentions, attachments }) {
  return rpc("chat_send_message", {
    p_conversation: conversationId, p_body: body || "", p_reply_to: replyTo || null, p_mentions: mentions || [], p_attachments: attachments || [],
  });
}

async function withAttachments(rows) {
  const ids = rows.map((m) => m.id);
  let atts = [];
  if (ids.length) {
    const r = await supabase.from("chat_message_attachments").select("*").in("message_id", ids);
    atts = r.data || [];
  }
  const byMsg = {};
  atts.forEach((a) => { (byMsg[a.message_id] ||= []).push(a); });
  return rows.map((m) => ({ ...m, attachments: byMsg[m.id] || [] }));
}

// newest first from the server, returned oldest -> newest; pass `before` (ISO) for older pages.
export async function fetchMessages(conversationId, before, limit = 40) {
  let q = supabase.from("chat_messages").select("*").eq("conversation_id", conversationId).order("created_at", { ascending: false }).limit(limit);
  if (before) q = q.lt("created_at", before);
  const { data, error } = await q;
  if (error) return { data: [], error };
  return { data: (await withAttachments(data || [])).reverse(), error: null };
}

export async function fetchMessage(id) {
  const { data, error } = await supabase.from("chat_messages").select("*").eq("id", id).maybeSingle();
  if (error || !data) return { data: null, error };
  return { data: (await withAttachments([data]))[0], error: null };
}

export async function fetchReads(conversationId) {
  const { data, error } = await supabase.from("chat_participants").select("user_id,last_read_at,muted").eq("conversation_id", conversationId);
  return { data: Object.fromEntries((data || []).map((p) => [p.user_id, p])), error };
}

// Private bucket, non-guessable path "<conversation>/<uuid>-<name>"; storage RLS checks membership on upload AND download.
export async function uploadChatFile(conversationId, file) {
  const mime = chatMimeOf(file);
  if (!mime) return { error: new Error("This file type is not allowed.") };
  if (file.size > CHAT_MAX_FILE_MB * 1024 * 1024) return { error: new Error(`Files can be at most ${CHAT_MAX_FILE_MB} MB.`) };
  const safe = file.name.replace(/[^A-Za-z0-9._-]+/g, "_").slice(-80) || "file";
  const path = `${conversationId}/${crypto.randomUUID()}-${safe}`;
  const { error } = await supabase.storage.from("chat-attachments").upload(path, file, { contentType: mime, upsert: false });
  if (error) return { error };
  return { attachment: { path, name: file.name, mime, size: file.size } };
}

// Signed URLs live 5 minutes; keep them for 4 so re-rendering / re-mounting a message never re-signs the same file,
// and share one in-flight request between identical callers.
const urlCache = new Map();
export async function chatFileUrl(path, { fresh = false } = {}) {
  const hit = urlCache.get(path);
  if (!fresh && hit && hit.exp > Date.now()) return { url: await hit.promise, error: null };
  const promise = supabase.storage.from("chat-attachments").createSignedUrl(path, 300).then(({ data, error }) => {
    if (error || !data?.signedUrl) { urlCache.delete(path); return null; }
    return data.signedUrl;
  });
  urlCache.set(path, { promise, exp: Date.now() + 240000 });
  const url = await promise;
  return { url, error: url ? null : new Error("Could not open the file.") };
}

function debounced(fn, ms) {
  let t = null;
  const wrapped = (...a) => { window.clearTimeout(t); t = window.setTimeout(() => fn(...a), ms); };
  wrapped.cancel = () => window.clearTimeout(t);
  return wrapped;
}

// Only membership / permission / mute changes matter to a list. A participant row that merely got a newer read
// marker is NOT a list change for anyone else, and for the reader the unread count is applied locally.
function membershipChanged(o, n) {
  return !!o && "left_at" in o && (o.left_at !== n.left_at || o.muted !== n.muted || o.can_post !== n.can_post || o.role !== n.role);
}

// Conversation list: ONE channel on conversations (Realtime already limits events to conversations the caller belongs to)
// and ONE on the caller's own membership rows. Each event names exactly one conversation.
export function subscribeConversationList(userId, name, { onRow, onRemove }) {
  const u1 = subscribeTable(`${name}-conv`, "chat_conversations", null, (p) => {
    if (p.eventType !== "DELETE" && p.new?.id) onRow(p.new.id);
  });
  const u2 = subscribeTable(`${name}-part`, "chat_participants", `user_id=eq.${userId}`, (p) => {
    const n = p.new || {}; const o = p.old || {};
    if (p.eventType === "DELETE") { if (o.conversation_id) onRemove(o.conversation_id); return; }
    if (!n.conversation_id) return;
    if (p.eventType === "INSERT") { onRow(n.conversation_id); return; }
    if (n.left_at) { onRemove(n.conversation_id); return; }
    if (membershipChanged(o, n) || ("last_read_message_id" in o && o.last_read_message_id !== n.last_read_message_id)) onRow(n.conversation_id);
  });
  return () => { u1(); u2(); };
}

// Header badge: total unread. Debounced; only events that can change the total.
export function subscribeChatBadge(userId, name, onChange) {
  const fire = debounced(onChange, 300);
  const u1 = subscribeTable(`${name}-conv`, "chat_conversations", null, (p) => { if (p.eventType !== "DELETE") fire(); });
  const u2 = subscribeTable(`${name}-part`, "chat_participants", `user_id=eq.${userId}`, (p) => {
    const n = p.new || {}; const o = p.old || {};
    if (p.eventType !== "UPDATE") { fire(); return; }
    if (membershipChanged(o, n) || ("last_read_message_id" in o && o.last_read_message_id !== n.last_read_message_id)) fire();
  });
  return () => { fire.cancel(); u1(); u2(); };
}

// One open conversation. Handlers receive the raw Realtime payload and apply it incrementally.
export function subscribeConversation(conversationId, name, { onMessage, onAttachment, onMember }) {
  const u1 = subscribeTable(`${name}-msgs`, "chat_messages", `conversation_id=eq.${conversationId}`, onMessage);
  const u2 = subscribeTable(`${name}-atts`, "chat_message_attachments", `conversation_id=eq.${conversationId}`, onAttachment);
  const u3 = subscribeTable(`${name}-members`, "chat_participants", `conversation_id=eq.${conversationId}`, onMember);
  return () => { u1(); u2(); u3(); };
}
