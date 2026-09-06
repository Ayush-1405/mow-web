import { buildCorsHeaders } from "./cors.ts";
import type { Bilingual } from "./messages.ts";

export function errorResponse(status: number, message: Bilingual, origin: string | null): Response {
  const body = { error: { en: message.en, gu: message.gu } };
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...buildCorsHeaders(origin) },
  });
}

export function okResponse(data: unknown, origin: string | null, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...buildCorsHeaders(origin) },
  });
}
