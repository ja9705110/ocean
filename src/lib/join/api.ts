"use client";

import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { requireSupabaseEnv } from "@/lib/env";
import { withRetry } from "@/lib/retry";
import type { ProcessedCharacter } from "@/lib/image/processCharacter";

/** 參與者端看得到的活動公開資料 */
export interface PublicEvent {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly subtitle: string | null;
  readonly worldTemplate: string;
  readonly status: "open" | "locked" | "drawing" | "finished";
  readonly participantCount: number;
}

/** get_my_participant RPC 的回傳列 */
export interface MyParticipant {
  readonly id: string;
  readonly display_name: string;
  readonly character_name: string | null;
  readonly image_path: string;
  readonly is_visible: boolean;
  readonly joined_at: string;
}

export interface SubmitInput {
  readonly event: PublicEvent;
  readonly displayName: string;
  readonly characterName: string | null;
  readonly deviceToken: string;
  readonly image: ProcessedCharacter;
  /** 每次重試時回報進度文字 */
  readonly onStatus?: (message: string) => void;
}

export interface SubmitResult {
  readonly participantId: string;
  readonly imagePath: string;
  /** true 表示此裝置早已報名，這次沒有新增資料 */
  readonly alreadyJoined: boolean;
}

/** Storage 公開 bucket 的完整圖片網址 */
export function characterImageUrl(imagePath: string): string {
  const { url } = requireSupabaseEnv();
  return `${url}/storage/v1/object/public/characters/${imagePath}`;
}

/** 輪詢用：只抓人數 */
export async function fetchParticipantCount(eventId: string): Promise<number> {
  const supabase = getSupabaseBrowserClient();
  const { data, error } = await supabase
    .from("events")
    .select("participant_count")
    .eq("id", eventId)
    .single();

  if (error) {
    throw new Error(error.message);
  }

  return (data as { participant_count: number }).participant_count;
}

/** 以 device_token 取回自己的角色（RLS 對 anon 關閉 select，必須走 RPC） */
export async function fetchMyParticipant(
  eventId: string,
  deviceToken: string,
): Promise<MyParticipant | null> {
  const supabase = getSupabaseBrowserClient();
  const { data, error } = await supabase.rpc("get_my_participant", {
    p_event_id: eventId,
    p_device_token: deviceToken,
  });

  if (error) {
    throw new Error(error.message);
  }

  const rows = (data ?? []) as MyParticipant[];
  return rows[0] ?? null;
}

/** PostgREST 回傳的錯誤形狀（僅取用到的欄位） */
interface PostgrestErrorLike {
  readonly code?: string;
  readonly message?: string;
  readonly statusCode?: string | number;
}

function isUniqueViolation(error: PostgrestErrorLike): boolean {
  return error.code === "23505";
}

function isAlreadyExists(error: PostgrestErrorLike): boolean {
  // Storage 對重複路徑回傳 409 Duplicate；重試時第一次可能已成功上傳
  return String(error.statusCode) === "409";
}

/**
 * 送出角色：上傳兩種尺寸 → insert participants。
 *
 * 順序是刻意的（規格第 9 節第 6 點）：圖先上去、資料列後寫入，
 * 避免大螢幕收到沒有圖的角色。整段皆可重試且冪等：
 * - participant id 由前端先產生，重試不會生出第二隻角色
 * - Storage 的 409（已存在）與資料庫的 23505（唯一鍵衝突）都視為成功
 */
export async function submitParticipant(
  input: SubmitInput,
): Promise<SubmitResult> {
  const supabase = getSupabaseBrowserClient();
  const participantId = crypto.randomUUID();
  const { extension, primary, small } = input.image;
  const basePath = `${input.event.id}/${participantId}.${extension}`;
  const smallPath = `${input.event.id}/${participantId}@256.${extension}`;
  const contentType = primary.type;

  const uploadOne = async (path: string, blob: Blob): Promise<void> => {
    const { error } = await supabase.storage
      .from("characters")
      .upload(path, blob, { contentType, upsert: false });

    if (error && !isAlreadyExists(error as PostgrestErrorLike)) {
      throw new Error(error.message);
    }
  };

  await withRetry(() => uploadOne(basePath, primary), {
    onRetry: (attempt) =>
      input.onStatus?.(`網路不穩，正在重新上傳圖片（第 ${attempt} 次）`),
  });
  await withRetry(() => uploadOne(smallPath, small), {
    onRetry: (attempt) =>
      input.onStatus?.(`網路不穩，正在重新上傳圖片（第 ${attempt} 次）`),
  });

  input.onStatus?.("圖片上傳完成，正在登記角色");

  let alreadyJoined = false;

  await withRetry(
    async () => {
      const { error } = await supabase.from("participants").insert({
        id: participantId,
        event_id: input.event.id,
        display_name: input.displayName,
        character_name: input.characterName,
        image_path: basePath,
        device_token: input.deviceToken,
      });

      if (error) {
        if (isUniqueViolation(error)) {
          alreadyJoined = true;
          return;
        }
        throw new Error(error.message);
      }
    },
    {
      onRetry: (attempt) =>
        input.onStatus?.(`網路不穩，正在重新登記（第 ${attempt} 次）`),
    },
  );

  if (alreadyJoined) {
    // 這台裝置先前已報名成功（例如上次送出後斷線），改抓既有紀錄
    const existing = await fetchMyParticipant(
      input.event.id,
      input.deviceToken,
    );

    if (existing) {
      return {
        participantId: existing.id,
        imagePath: existing.image_path,
        alreadyJoined: true,
      };
    }
  }

  return { participantId, imagePath: basePath, alreadyJoined: false };
}
