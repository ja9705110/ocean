"use client";

import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { characterImageUrl } from "@/lib/characterImages";

/** 獎項與抽獎結果（M7） */

export interface Prize {
  readonly id: string;
  readonly name: string;
  readonly quantity: number;
  readonly sortOrder: number;
  /** 已抽出且未作廢的人數 */
  readonly drawnCount: number;
}

export interface DrawResult {
  readonly id: string;
  readonly roundNo: number;
  readonly prizeId: string | null;
  readonly prizeName: string;
  readonly participantId: string;
  readonly displayName: string;
  readonly characterName: string | null;
  readonly imageUrl: string;
  readonly drawnAt: string;
}

interface PrizeRow {
  readonly id: string;
  readonly name: string;
  readonly quantity: number;
  readonly sort_order: number;
  readonly drawn_count: number | string | null;
}

interface DrawRow {
  readonly id: string;
  readonly round_no: number;
  readonly prize_id: string | null;
  readonly prize_name: string;
  readonly participant_id: string;
  readonly display_name: string;
  readonly character_name: string | null;
  readonly image_path: string;
  readonly drawn_at: string;
}

export async function listPrizes(eventId: string): Promise<Prize[]> {
  const supabase = getSupabaseBrowserClient();
  const { data, error } = await supabase.rpc("list_event_prizes", {
    p_event_id: eventId,
  });

  if (error) {
    throw new Error(error.message);
  }

  return ((data ?? []) as PrizeRow[]).map((row) => ({
    id: row.id,
    name: row.name,
    quantity: row.quantity,
    sortOrder: row.sort_order,
    // count(*) 在 PostgREST 是 bigint，會以字串回傳
    drawnCount: Number(row.drawn_count ?? 0),
  }));
}

export async function listDraws(eventId: string): Promise<DrawResult[]> {
  const supabase = getSupabaseBrowserClient();
  const { data, error } = await supabase.rpc("list_event_draws", {
    p_event_id: eventId,
  });

  if (error) {
    throw new Error(error.message);
  }

  return ((data ?? []) as DrawRow[]).map((row) => ({
    id: row.id,
    roundNo: row.round_no,
    prizeId: row.prize_id,
    prizeName: row.prize_name,
    participantId: row.participant_id,
    displayName: row.display_name,
    characterName: row.character_name,
    imageUrl: characterImageUrl(row.image_path),
    drawnAt: row.drawn_at,
  }));
}

export async function createPrize(
  eventId: string,
  name: string,
  quantity: number,
  sortOrder: number,
): Promise<void> {
  const supabase = getSupabaseBrowserClient();
  const { error } = await supabase.from("prizes").insert({
    event_id: eventId,
    name: name.trim(),
    quantity,
    sort_order: sortOrder,
  });

  if (error) {
    throw new Error(error.message);
  }
}

export async function updatePrize(
  prizeId: string,
  patch: { readonly name?: string; readonly quantity?: number; readonly sortOrder?: number },
): Promise<void> {
  const supabase = getSupabaseBrowserClient();
  const row: Record<string, string | number> = {};
  if (patch.name !== undefined) {
    row.name = patch.name.trim();
  }
  if (patch.quantity !== undefined) {
    row.quantity = patch.quantity;
  }
  if (patch.sortOrder !== undefined) {
    row.sort_order = patch.sortOrder;
  }

  const { error } = await supabase.from("prizes").update(row).eq("id", prizeId);
  if (error) {
    throw new Error(error.message);
  }
}

export async function deletePrize(prizeId: string): Promise<void> {
  const supabase = getSupabaseBrowserClient();
  const { error } = await supabase.from("prizes").delete().eq("id", prizeId);
  if (error) {
    throw new Error(error.message);
  }
}

/** 中獎者由資料庫決定並直接廣播給大螢幕，前端只拿回結果顯示 */
export async function drawWinner(
  eventId: string,
  prizeId: string,
): Promise<DrawResult> {
  const supabase = getSupabaseBrowserClient();
  const { data, error } = await supabase.rpc("draw_winner", {
    p_event_id: eventId,
    p_prize_id: prizeId,
  });

  if (error) {
    throw new Error(translateDrawError(error.message));
  }

  const rows = (data ?? []) as {
    draw_id: string;
    round_no: number;
    prize_id: string;
    prize_name: string;
    participant_id: string;
    display_name: string;
    character_name: string | null;
    image_path: string;
  }[];
  const row = rows[0];

  if (!row) {
    throw new Error("抽獎沒有回傳結果，請重試。");
  }

  return {
    id: row.draw_id,
    roundNo: row.round_no,
    prizeId: row.prize_id,
    prizeName: row.prize_name,
    participantId: row.participant_id,
    displayName: row.display_name,
    characterName: row.character_name,
    imageUrl: characterImageUrl(row.image_path),
    drawnAt: new Date().toISOString(),
  };
}

export async function voidDraw(drawId: string): Promise<void> {
  const supabase = getSupabaseBrowserClient();
  const { error } = await supabase.rpc("void_draw", { p_draw_id: drawId });
  if (error) {
    throw new Error(error.message);
  }
}

export async function replayDraw(drawId: string): Promise<void> {
  const supabase = getSupabaseBrowserClient();
  const { error } = await supabase.rpc("replay_draw", { p_draw_id: drawId });
  if (error) {
    throw new Error(error.message);
  }
}

/** 把資料庫的錯誤代碼翻成主持人在現場看得懂的句子 */
function translateDrawError(message: string): string {
  if (message.includes("NO_ELIGIBLE_PARTICIPANT")) {
    return "沒有符合資格的參與者了。可能全部都已中獎，或都被排除／隱藏。";
  }
  if (message.includes("PRIZE_QUOTA_REACHED")) {
    return "這個獎項的名額已經抽完了。";
  }
  if (message.includes("NOT_EVENT_HOST")) {
    return "只有這場活動的主持人可以抽獎。";
  }
  if (message.includes("PRIZE_NOT_FOUND")) {
    return "找不到這個獎項，請重新整理。";
  }
  return message;
}
