import { supabase } from "./supabase";
import { subscribeTable } from "./realtime";
import { ACCEPT_ATTR, logUploadFailure, typedFile, validateUploadFile, UploadError } from "./fileTypes";
import { downloadChatAttachment } from "./api";

// Internal chat data layer. Authorization lives in the database: reads are RLS-limited to conversations the
// caller is an ACTIVE participant of, and every write (create / send / edit / delete / read / mute / open)
// is a SECURITY DEFINER RPC that re-checks membership. Nothing here decides who may see or message whom.

export const TYPE_LABEL = { direct: "Direct", department: "Department", team: "Team", task: "Task", job_card: "Job Card", bridge: "Bridge", management: "Management", project: "Project" };
export const CHAT_MAX_FILE_MB = 15;
export const CHAT_EDIT_WINDOW_MIN = 15;
export const CHAT_ACCEPT = ACCEPT_ATTR("chat");
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
// The database creates-or-reuses the ONE canonical Project Chat and only returns it to people authorized for that project.
export const openProjectChat = (projectId) => rpc("chat_open_project", { p_project: projectId });
export const searchProjects = (q) => rpc("chat_search_projects", { p_query: q || null });
export const projectTasks = (projectId) => rpc("chat_project_tasks", { p_project: projectId });
export const linkMessageToTask = (messageId, taskId) => rpc("chat_link_message_task", { p_message: messageId, p_task: taskId });
// unread chat messages per task (drives the "Chat (N)" badge on task cards)
export const taskChatUnread = () => rpc("chat_task_unread_counts");
// Old Reply links (notifications / bookmarks) -> the migrated Chat conversation (+ the migrated message when the id is known)
export const resolveLegacyLink = (kind, id, taskId = null) => rpc("chat_resolve_legacy", { p_kind: kind, p_id: id, p_task: taskId });
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

// The window of messages ending just after `message` (used to land on a specific, possibly old, message).
export async function fetchMessagesAround(conversationId, message, limit = 40) {
  const upTo = new Date(new Date(message.created_at).getTime() + 1).toISOString();
  return fetchMessages(conversationId, upTo, limit);
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

// Private bucket, server-shaped path "<conversation>/<uuid>.<ext>" (the original name never enters the path); storage RLS checks
// membership on upload AND download. The File is re-typed to the approved MIME for its extension: the SDK ignores the
// contentType option for a File and would otherwise send the browser's own (often empty / octet-stream) type, which the bucket
// refuses -- the same failure that broke DWG uploads on tasks.
export async function uploadChatFile(conversationId, file) {
  let meta;
  try { meta = await validateUploadFile(file, "chat"); } catch (e) { return { error: e }; }
  if (file.size > CHAT_MAX_FILE_MB * 1024 * 1024) return { error: new Error(`Files can be at most ${CHAT_MAX_FILE_MB} MB.`) };
  const path = `${conversationId}/${crypto.randomUUID()}.${meta.ext}`;
  const { error } = await supabase.storage.from("chat-attachments").upload(path, typedFile(file, meta.mime, meta.filename), { contentType: meta.mime, upsert: false });
  if (error) {
    logUploadFailure("chat-put", error, { bucket: "chat-attachments", path, ext: meta.ext, size: file.size, mime: meta.mime });
    return { error: new UploadError(/mime|415/i.test(error.message || "") ? "MIME_REJECTED" : "STORAGE_DOWN") };
  }
  return { attachment: { path, name: file.name, mime: meta.mime, size: file.size } };
}

// Signed URLs live 5 minutes; keep them for 4 so re-rendering / re-mounting a message never re-signs the same file,
// and share one in-flight request between identical callers.
const urlCache = new Map();
// `att` = the chat_message_attachments row. Files uploaded through Chat sit in chat-attachments (storage RLS = conversation
// membership). Files migrated from a legacy Reply still sit in their ORIGINAL private staff-attachments object: those are signed by
// the Edge Function, which re-checks the caller's membership through the same RLS before signing. No URL is ever stored.
export async function chatFileUrl(att, { fresh = false } = {}) {
  const path = att.storage_path;
  const hit = urlCache.get(path);
  if (!fresh && hit && hit.exp > Date.now()) return { url: await hit.promise, error: null };
  const legacy = att.bucket && att.bucket !== "chat-attachments";
  const promise = (legacy
    ? downloadChatAttachment(att.id).then((r) => r?.signed_url || null).catch(() => null)
    : supabase.storage.from("chat-attachments").createSignedUrl(path, 300).then(({ data, error }) => (error || !data?.signedUrl ? null : data.signedUrl))
  ).then((u) => { if (!u) urlCache.delete(path); return u; });
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
