// In-memory stand-in for the shared supabase client (TEST ONLY). Mirrors the behaviour of the real chat RPCs / RLS
// closely enough to exercise the React data flow: counts every call, and emits Realtime events the way Postgres would
// (including the UPDATE echo of a participant's own read-marker, which is what the original loop fed on).
const ME = "u-me";
const OTHER = "u-other";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LAT = 25;

export const stats = {
  rpc: {}, query: {}, storage: 0, channelsCreated: 0, channelsRemoved: 0, events: 0, capped: false, total: 0,
};
export const cfg = { idempotentMarkRead: true, replicaFull: true, cap: 4000 };

const users = { [ME]: { id: ME, full_name: "Me Tester" }, [OTHER]: { id: OTHER, full_name: "Other Person" } };
let seq = 0;
const iso = (offsetSec = 0) => new Date(Date.now() + offsetSec * 1000).toISOString();
const uid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;

export const db = { convs: [], parts: [], msgs: [], atts: [] };
for (let i = 1; i <= 12; i += 1) {
  const id = `c0000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
  db.convs.push({ id, type: i % 3 === 0 ? "task" : i % 3 === 1 ? "direct" : "department", title: i % 3 === 1 ? "Direct chat" : `Conversation ${i}`, department_id: null, task_id: null, job_card_id: null, is_active: true, created_at: iso(-5000 + i), last_message_at: null, last_message_preview: null, last_message_sender: null, management_visible: true });
  db.parts.push({ conversation_id: id, user_id: ME, role: "member", left_at: null, can_post: true, muted: false, last_read_at: iso(-4000), last_read_message_id: null, joined_at: iso(-4000) });
  db.parts.push({ conversation_id: id, user_id: OTHER, role: "member", left_at: null, can_post: true, muted: false, last_read_at: iso(-4000), last_read_message_id: null, joined_at: iso(-4000) });
  for (let k = 1; k <= 5; k += 1) {
    const m = { id: uid(), conversation_id: id, sender_id: k % 2 ? OTHER : ME, body: `msg ${k} in ${i}`, reply_to_id: null, mentions: [], is_system: false, created_at: iso(-3000 + i * 10 + k), edited_at: null, deleted_at: null };
    db.msgs.push(m);
  }
  const last = db.msgs.filter((m) => m.conversation_id === id).slice(-1)[0];
  const c = db.convs.find((x) => x.id === id);
  c.last_message_at = last.created_at; c.last_message_preview = last.body; c.last_message_sender = last.sender_id;
}
// conversation 2 has one genuinely unread message from the other user
db.parts.find((p) => p.conversation_id === db.convs[1].id && p.user_id === ME).last_read_at = iso(-3000);

// ---- realtime ----
const active = new Set();
export function emit(table, eventType, row, oldRow) {
  stats.events += 1;
  active.forEach((ch) => ch.subs.forEach((s) => {
    if (s.cfg.table !== table) return;
    if (s.cfg.filter) {
      const m = /^(\w+)=eq\.(.+)$/.exec(s.cfg.filter);
      const src = row || oldRow || {};
      if (m && String(src[m[1]]) !== m[2]) return;
    }
    // RLS: only participants of the conversation receive chat events
    const cid = table === "chat_conversations" ? (row || oldRow).id : (row || oldRow).conversation_id;
    if (!db.parts.some((p) => p.conversation_id === cid && p.user_id === ME && !p.left_at)) return;
    Promise.resolve().then(() => s.cb({ eventType, new: row || {}, old: oldRow || {}, table }));
  }));
}

function bump(bucket, name) {
  stats.total += 1;
  stats[bucket][name] = (stats[bucket][name] || 0) + 1;
  if (stats.total > cfg.cap) { stats.capped = true; throw new Error("HARNESS CAP: request storm"); }
}

const myConvs = () => db.convs.filter((c) => db.parts.some((p) => p.conversation_id === c.id && p.user_id === ME && !p.left_at));
const unreadOf = (c) => {
  const p = db.parts.find((x) => x.conversation_id === c.id && x.user_id === ME);
  return db.msgs.filter((m) => m.conversation_id === c.id && m.created_at > p.last_read_at && m.sender_id !== ME && !m.is_system && !m.deleted_at).length;
};
const rowOf = (c) => {
  const p = db.parts.find((x) => x.conversation_id === c.id && x.user_id === ME);
  return { id: c.id, type: c.type, title: c.type === "direct" ? "Other Person" : c.title, peer_id: c.type === "direct" ? OTHER : null, department: null, is_active: c.is_active, muted: p.muted, last_message_at: c.last_message_at, sort_at: c.last_message_at || c.created_at, last_message_preview: c.last_message_preview, last_sender: c.last_message_sender ? users[c.last_message_sender]?.full_name : null, unread: unreadOf(c), task_id: c.task_id, job_card_id: c.job_card_id };
};

const rpcs = {
  async chat_list_conversations(a) {
    let list = myConvs();
    if (a.p_conversation) list = list.filter((c) => c.id === a.p_conversation);
    return list.map(rowOf).sort((x, y) => (y.sort_at || "").localeCompare(x.sort_at || ""));
  },
  async chat_unread_total() { return myConvs().reduce((n, c) => n + unreadOf(c), 0); },
  async chat_conversation_details(a) {
    const c = myConvs().find((x) => x.id === a.p_conversation);
    if (!c) throw new Error("Conversation not found");
    return { id: c.id, type: c.type, title: c.type === "direct" ? "Other Person" : c.title, department: null, is_active: true, management_visible: true, context: {}, i_can_post: true, i_can_manage: false,
      notice: "This is a company work conversation and may be visible to authorized Management.",
      participants: db.parts.filter((p) => p.conversation_id === c.id).map((p) => ({ user_id: p.user_id, name: users[p.user_id].full_name, employee_code: "X", department: "Factory", role_label: "Employee", chat_role: "member", active: !p.left_at, joined_at: p.joined_at, left_at: p.left_at })) };
  },
  async chat_mark_read(a) {
    const p = db.parts.find((x) => x.conversation_id === a.p_conversation && x.user_id === ME);
    const latest = db.msgs.filter((m) => m.conversation_id === a.p_conversation).slice(-1)[0];
    if (cfg.idempotentMarkRead && (!latest || latest.id === p.last_read_message_id)) return false;
    const old = { ...p };
    p.last_read_at = iso(); p.last_read_message_id = latest ? latest.id : null;
    emit("chat_participants", "UPDATE", { ...p }, cfg.replicaFull ? old : { conversation_id: p.conversation_id, user_id: p.user_id });
    return true;
  },
  async chat_send_message(a) {
    const m = { id: uid(), conversation_id: a.p_conversation, sender_id: ME, body: a.p_body, reply_to_id: a.p_reply_to, mentions: [], is_system: false, created_at: iso(), edited_at: null, deleted_at: null };
    db.msgs.push(m);
    const c = db.convs.find((x) => x.id === a.p_conversation);
    c.last_message_at = m.created_at; c.last_message_preview = m.body; c.last_message_sender = ME;
    const p = db.parts.find((x) => x.conversation_id === c.id && x.user_id === ME);
    const old = { ...p };
    p.last_read_at = m.created_at; p.last_read_message_id = m.id;
    emit("chat_messages", "INSERT", { ...m });
    emit("chat_conversations", "UPDATE", { ...c }, { id: c.id });
    emit("chat_participants", "UPDATE", { ...p }, old);
    return m.id;
  },
  async chat_search_messages() { return []; },
};

// helpers the test script uses to play "the other user"
export function deliverForeign(conversationId, body) {
  const m = { id: uid(), conversation_id: conversationId, sender_id: OTHER, body, reply_to_id: null, mentions: [], is_system: false, created_at: iso(), edited_at: null, deleted_at: null };
  db.msgs.push(m);
  const c = db.convs.find((x) => x.id === conversationId);
  c.last_message_at = m.created_at; c.last_message_preview = body; c.last_message_sender = OTHER;
  emit("chat_messages", "INSERT", { ...m });
  emit("chat_conversations", "UPDATE", { ...c }, { id: c.id });
  return m.id;
}

function builder(table) {
  const f = { eq: [], lt: null, inn: null, order: null, limit: null };
  const run = async () => {
    bump("query", table);
    await sleep(LAT);
    let rows;
    if (table === "chat_messages") rows = db.msgs;
    else if (table === "chat_message_attachments") rows = db.atts;
    else if (table === "chat_participants") rows = db.parts.filter((p) => p.user_id === ME || true);
    else rows = [];
    rows = rows.filter((r) => f.eq.every(([c, v]) => String(r[c]) === String(v)));
    if (f.lt) rows = rows.filter((r) => r[f.lt[0]] < f.lt[1]);
    if (f.inn) rows = rows.filter((r) => f.inn[1].includes(r[f.inn[0]]));
    if (f.order) rows = [...rows].sort((a, b) => (f.order[1].ascending === false ? -1 : 1) * String(a[f.order[0]]).localeCompare(String(b[f.order[0]])));
    if (f.limit) rows = rows.slice(0, f.limit);
    return { data: rows.map((r) => ({ ...r })), error: null };
  };
  const b = {
    select() { return b; }, eq(c, v) { f.eq.push([c, v]); return b; }, lt(c, v) { f.lt = [c, v]; return b; }, in(c, v) { f.inn = [c, v]; return b; },
    order(c, o) { f.order = [c, o || {}]; return b; }, limit(n) { f.limit = n; return b; },
    maybeSingle: async () => { const r = await run(); return { data: r.data[0] || null, error: null }; },
    then(res, rej) { return run().then(res, rej); },
  };
  return b;
}

export const supabase = {
  rpc: async (name, args) => {
    bump("rpc", name);
    await sleep(LAT);
    try {
      if (!rpcs[name]) return { data: null, error: null };
      return { data: await rpcs[name](args || {}), error: null };
    } catch (e) {
      if (String(e.message).startsWith("HARNESS")) throw e;
      return { data: null, error: { message: e.message } };
    }
  },
  from: (t) => builder(t),
  storage: { from: () => ({ createSignedUrl: async () => { stats.storage += 1; return { data: { signedUrl: "data:image/gif;base64,R0lGODlhAQABAAAAACw=" }, error: null }; }, upload: async () => ({ error: null }) }) },
  auth: {
    getSession: async () => ({ data: { session: { user: { id: ME } } } }),
    getUser: async () => ({ data: { user: { id: ME } } }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
  },
  channel(name) {
    const ch = { topic: `realtime:${name}`, subs: [], on(_t, c, cb) { ch.subs.push({ cfg: c, cb }); return ch; }, subscribe() { active.add(ch); stats.channelsCreated += 1; return ch; } };
    return ch;
  },
  getChannels: () => [...active],
  removeChannel(ch) { if (active.delete(ch)) stats.channelsRemoved += 1; return Promise.resolve("ok"); },
};
export const activeChannelCount = () => active.size;
export const ME_ID = ME;
export const SUPABASE_URL_BASE = "fake";
export const SUPABASE_ANON_KEY_VALUE = "fake";
