// Mood of Wood — Node API — notification writer.
//
// Plain insert into public.notifications, matching the shape every
// staff_* RPC already inserts (recipient_id, entity_type, entity_id,
// title_en, title_gu). No RLS write policy exists for this table (writes
// are service-role only, same as every other pilot table) — this must
// only ever be called with the admin client, from inside another
// endpoint's handler, never exposed as its own endpoint.

export async function createNotification(admin, { recipientId, entityType, entityId, titleEn, titleGu }) {
  const { error } = await admin.from("notifications").insert({
    recipient_id: recipientId,
    entity_type: entityType,
    entity_id: entityId,
    title_en: titleEn,
    title_gu: titleGu,
  });
  if (error) {
    console.error(`createNotification: insert failed for recipient=${recipientId}:`, error.message);
    throw error;
  }
}
