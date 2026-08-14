"use client";

import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { characterSmallImageUrl } from "@/lib/characterImages";
import type { CharacterData } from "@/world/types";
import type { EventStatus } from "@/lib/eventStatus";
import { parseStageDisplay, pickStageImages } from "@/lib/stageDisplay";
import type { StageDisplay } from "@/lib/stageDisplay";

/** 大螢幕每次輪詢取得的活動快照 */
export interface EventSnapshot {
  readonly status: EventStatus;
  readonly participantCount: number;
  readonly logoUrl: string | null;
  readonly bgmUrl: string | null;
  readonly subtitle: string | null;
}

export async function fetchEventSnapshot(
  eventId: string,
): Promise<EventSnapshot | null> {
  const supabase = getSupabaseBrowserClient();
  const { data, error } = await supabase.rpc("get_event_snapshot", {
    p_event_id: eventId,
  });

  if (error) {
    throw new Error(error.message);
  }

  const rows = (data ?? []) as {
    status: EventStatus;
    participant_count: number;
    logo_url: string | null;
    bgm_url: string | null;
    subtitle: string | null;
  }[];
  const row = rows[0];

  if (!row) {
    return null;
  }

  return {
    status: row.status,
    participantCount: row.participant_count,
    logoUrl: row.logo_url,
    bgmUrl: row.bgm_url,
    subtitle: row.subtitle,
  };
}

/** get_stage_participants RPC 的回傳列 */
interface StageParticipantRow {
  readonly id: string;
  readonly display_name: string;
  readonly character_name: string | null;
  readonly image_path: string;
  readonly signature_path?: string | null;
  readonly joined_at: string;
}

/** 大螢幕的顯示方式。主持人可能在活動中途改，所以要能單獨查。 */
export async function fetchStageDisplay(
  eventId: string,
): Promise<StageDisplay> {
  const supabase = getSupabaseBrowserClient();
  const { data, error } = await supabase
    .from("events")
    .select("stage_display")
    .eq("id", eventId)
    .single();

  if (error) {
    // 資料庫還沒跑過 C1 時這一欄不存在，當作只顯示簽名
    return "signature";
  }
  return parseStageDisplay(
    (data as { stage_display?: string | null }).stage_display,
  );
}

/**
 * 大螢幕初始渲染用的全量角色清單（依加入順序排序）。
 * 斷線重連後也用同一支做全量對帳（M4）。
 */
export async function fetchStageParticipants(
  eventId: string,
  display: StageDisplay = "signature",
): Promise<CharacterData[]> {
  const supabase = getSupabaseBrowserClient();
  const { data, error } = await supabase.rpc("get_stage_participants", {
    p_event_id: eventId,
  });

  if (error) {
    throw new Error(error.message);
  }

  const rows = (data ?? []) as StageParticipantRow[];

  return rows.map((row) => {
    const picked = pickStageImages(row, display);
    return {
      id: row.id,
      displayName: row.display_name,
      characterName: row.character_name,
      // 大螢幕一律用 256px 版本：350 張 512px 貼圖會吃掉 350MB VRAM
      imageUrl: characterSmallImageUrl(picked.primary),
      secondaryImageUrl:
        picked.secondary === null
          ? null
          : characterSmallImageUrl(picked.secondary),
      joinedAt: row.joined_at,
    };
  });
}
