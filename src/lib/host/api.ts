"use client";

import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { characterImageUrl } from "@/lib/characterImages";
import { parseStageDisplay } from "@/lib/stageDisplay";
import type { StageDisplay } from "@/lib/stageDisplay";
import type { EventStatus } from "@/lib/eventStatus";

/** 主持人清單頁看到的活動 */
export interface HostEvent {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly subtitle: string | null;
  readonly worldTemplate: string;
  readonly drawCount: number;
  readonly allowRepeat: boolean;
  readonly status: EventStatus;
  readonly participantCount: number;
  readonly drawnCount: number;
  readonly createdAt: string;
}

/** 控制台看到的參與者（含已隱藏者） */
export interface HostParticipant {
  readonly id: string;
  readonly displayName: string;
  readonly characterName: string | null;
  readonly imageUrl: string;
  readonly isVisible: boolean;
  readonly isEligible: boolean;
  readonly joinedAt: string;
}

interface EventRow {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly subtitle: string | null;
  readonly world_template: string;
  readonly draw_count: number;
  readonly allow_repeat: boolean;
  readonly status: EventStatus;
  readonly participant_count: number;
  readonly drawn_count?: number | string | null;
  readonly created_at: string;
}

function toHostEvent(row: EventRow): HostEvent {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    subtitle: row.subtitle,
    worldTemplate: row.world_template,
    drawCount: row.draw_count,
    allowRepeat: row.allow_repeat,
    status: row.status,
    participantCount: row.participant_count,
    // count(*) 在 PostgREST 是 bigint，會以字串回傳
    drawnCount: Number(row.drawn_count ?? 0),
    createdAt: row.created_at,
  };
}

export async function listMyEvents(): Promise<HostEvent[]> {
  const supabase = getSupabaseBrowserClient();
  const { data, error } = await supabase.rpc("list_my_events");

  if (error) {
    throw new Error(error.message);
  }
  return ((data ?? []) as EventRow[]).map(toHostEvent);
}

export interface CreateEventInput {
  readonly name: string;
  readonly subtitle: string | null;
  readonly worldTemplate: string;
  readonly drawCount: number;
  readonly allowRepeat: boolean;
}

export async function createEvent(
  input: CreateEventInput,
): Promise<HostEvent> {
  const supabase = getSupabaseBrowserClient();
  const { data, error } = await supabase.rpc("create_event", {
    p_name: input.name,
    p_subtitle: input.subtitle,
    p_world_template: input.worldTemplate,
    p_draw_count: input.drawCount,
    p_allow_repeat: input.allowRepeat,
  });

  if (error) {
    throw new Error(error.message);
  }
  return toHostEvent(data as EventRow);
}

/** 認領無主活動（例如 M1 建立的種子活動 DEMO01） */
export async function claimEvent(code: string): Promise<HostEvent> {
  const supabase = getSupabaseBrowserClient();
  const { data, error } = await supabase.rpc("claim_event", { p_code: code });

  if (error) {
    throw new Error(error.message);
  }
  return toHostEvent(data as EventRow);
}

export interface EventSettingsPatch {
  readonly subtitle?: string | null;
  readonly logoUrl?: string | null;
  readonly bgmUrl?: string | null;
  /** 大螢幕的世界模板（ocean / river / forest） */
  readonly worldTemplate?: string;
  /** 報到方式：draw = 畫角色，signature = 電子簽名 */
  readonly joinMode?: "draw" | "signature";
  /** 大螢幕顯示簽名、彩繪，還是兩者 */
  readonly stageDisplay?: StageDisplay;
}

/**
 * 讀取活動的報到模式與大螢幕顯示方式。
 *
 * 刻意不塞進 list_my_events：那是 returns table 的函式，加欄位就得
 * 先 drop 再建，而每一次改動函式簽章都要重跑一次安裝腳本。
 * 這裡直接讀資料表，RLS 的 events_host_read 已經涵蓋。
 */
export interface CheckinSettings {
  readonly joinMode: "draw" | "signature";
  readonly stageDisplay: StageDisplay;
}

export async function fetchCheckinSettings(
  eventId: string,
): Promise<CheckinSettings> {
  const supabase = getSupabaseBrowserClient();
  const { data, error } = await supabase
    .from("events")
    .select("join_mode,stage_display")
    .eq("id", eventId)
    .single();

  if (error) {
    // 資料庫還沒跑過 C0／C1 時這些欄位不存在，當作原本的畫角色模式
    return { joinMode: "draw", stageDisplay: "signature" };
  }

  const row = data as {
    join_mode?: string | null;
    stage_display?: string | null;
  };

  return {
    joinMode: row.join_mode === "signature" ? "signature" : "draw",
    stageDisplay: parseStageDisplay(row.stage_display),
  };
}

export async function updateEventSettings(
  eventId: string,
  patch: EventSettingsPatch,
): Promise<void> {
  const supabase = getSupabaseBrowserClient();
  const row: Record<string, string | null> = {};

  if (patch.subtitle !== undefined) {
    row.subtitle = patch.subtitle;
  }
  if (patch.logoUrl !== undefined) {
    row.logo_url = patch.logoUrl;
  }
  if (patch.bgmUrl !== undefined) {
    row.bgm_url = patch.bgmUrl;
  }
  if (patch.worldTemplate !== undefined) {
    row.world_template = patch.worldTemplate;
  }
  if (patch.joinMode !== undefined) {
    row.join_mode = patch.joinMode;
  }
  if (patch.stageDisplay !== undefined) {
    row.stage_display = patch.stageDisplay;
  }

  const { error } = await supabase.from("events").update(row).eq("id", eventId);
  if (error) {
    throw new Error(error.message);
  }
}

/**
 * 上傳活動 Logo，回傳公開網址。
 * 檔名帶時間戳：同名覆寫會被 CDN 快取住，換了 Logo 卻看到舊的。
 */
export async function uploadEventLogo(
  eventId: string,
  file: File,
): Promise<string> {
  const supabase = getSupabaseBrowserClient();
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "png";
  const path = `${eventId}/logo-${Date.now()}.${extension}`;

  const { error } = await supabase.storage
    .from("assets")
    .upload(path, file, { contentType: file.type, upsert: false });

  if (error) {
    throw new Error(error.message);
  }

  const { data } = supabase.storage.from("assets").getPublicUrl(path);
  return data.publicUrl;
}

export async function updateEventStatus(
  eventId: string,
  status: EventStatus,
): Promise<void> {
  const supabase = getSupabaseBrowserClient();
  const { error } = await supabase
    .from("events")
    .update({ status })
    .eq("id", eventId);

  if (error) {
    throw new Error(error.message);
  }
}

interface ParticipantRow {
  readonly id: string;
  readonly display_name: string;
  readonly character_name: string | null;
  readonly image_path: string;
  readonly is_visible: boolean;
  readonly is_eligible: boolean;
  readonly joined_at: string;
}

export async function listEventParticipants(
  eventId: string,
): Promise<HostParticipant[]> {
  const supabase = getSupabaseBrowserClient();
  const { data, error } = await supabase.rpc("list_event_participants", {
    p_event_id: eventId,
  });

  if (error) {
    throw new Error(error.message);
  }

  return ((data ?? []) as ParticipantRow[]).map((row) => ({
    id: row.id,
    displayName: row.display_name,
    characterName: row.character_name,
    // 主持人清單用 512px 版本：需要看清楚才能判斷內容是否恰當
    imageUrl: characterImageUrl(row.image_path),
    isVisible: row.is_visible,
    isEligible: row.is_eligible,
    joinedAt: row.joined_at,
  }));
}

/**
 * 隱藏或恢復角色。
 * 資料庫觸發器會同步 participant_count 並廣播給大螢幕即時移除。
 */
export async function setParticipantVisible(
  participantId: string,
  isVisible: boolean,
): Promise<void> {
  const supabase = getSupabaseBrowserClient();
  const { error } = await supabase
    .from("participants")
    .update({ is_visible: isVisible })
    .eq("id", participantId);

  if (error) {
    throw new Error(error.message);
  }
}

/** 排除或恢復抽獎資格（不影響角色在世界中的顯示） */
export async function setParticipantEligible(
  participantId: string,
  isEligible: boolean,
): Promise<void> {
  const supabase = getSupabaseBrowserClient();
  const { error } = await supabase
    .from("participants")
    .update({ is_eligible: isEligible })
    .eq("id", participantId);

  if (error) {
    throw new Error(error.message);
  }
}
