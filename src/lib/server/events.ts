import { readSupabaseEnv } from "@/lib/env";
import type { PublicEvent } from "@/lib/join/api";

interface EventRow {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly subtitle: string | null;
  readonly world_template: string;
  readonly status: PublicEvent["status"];
  readonly participant_count: number;
}

/**
 * Server Component 用的活動查詢（join 與 stage 頁共用）。
 * RLS 只允許 anon 讀公開狀態的活動，draft 在這裡等同不存在。
 */
export async function fetchEventByCode(
  code: string,
): Promise<PublicEvent | null> {
  const envResult = readSupabaseEnv();
  if (!envResult.ok) {
    return null;
  }

  const { url, anonKey } = envResult.env;
  const response = await fetch(
    `${url}/rest/v1/events?select=id,code,name,subtitle,world_template,status,participant_count&code=eq.${encodeURIComponent(code)}`,
    {
      headers: { apikey: anonKey },
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    },
  );

  if (!response.ok) {
    throw new Error(`活動查詢失敗（HTTP ${response.status}）`);
  }

  const rows = (await response.json()) as EventRow[];
  const row = rows[0];

  if (!row) {
    return null;
  }

  return {
    id: row.id,
    code: row.code,
    name: row.name,
    subtitle: row.subtitle,
    worldTemplate: row.world_template,
    status: row.status,
    participantCount: row.participant_count,
  };
}
