import { readSupabaseEnv } from "@/lib/env";
import { parseStageDisplay } from "@/lib/stageDisplay";
import { parseStageConfig } from "@/lib/stageConfig";
import type { PublicEvent } from "@/lib/join/api";

interface EventRow {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly subtitle: string | null;
  readonly world_template: string;
  readonly join_mode?: string | null;
  readonly stage_display?: string | null;
  readonly stage_config?: unknown;
  readonly status: PublicEvent["status"];
  readonly participant_count: number;
}

const BASE_COLUMNS =
  "id,code,name,subtitle,world_template,status,participant_count";

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

  const query = async (columns: string): Promise<Response> =>
    fetch(
      `${url}/rest/v1/events?select=${columns}&code=eq.${encodeURIComponent(code)}`,
      {
        headers: { apikey: anonKey },
        cache: "no-store",
        signal: AbortSignal.timeout(8000),
      },
    );

  // join_mode 與 stage_display 是後來才加上去的欄位。前端會比資料庫
  // 先上線，那段期間 PostgREST 會回 400（找不到欄位）——不能因此讓整個
  // 報到頁 500，退回不含那些欄位的查詢，一律當作畫角色模式。
  let response = await query(
    `${BASE_COLUMNS},join_mode,stage_display,stage_config`,
  );
  if (response.status === 400) {
    response = await query(BASE_COLUMNS);
  }

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
    joinMode: row.join_mode === "signature" ? "signature" : "draw",
    stageDisplay: parseStageDisplay(row.stage_display),
    stageConfig: parseStageConfig(row.stage_config),
    status: row.status,
    participantCount: row.participant_count,
  };
}
