"use client";

import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { characterSmallImageUrl } from "@/lib/characterImages";
import type { CharacterData } from "@/world/types";

/**
 * 大螢幕的即時訂閱：接收資料庫廣播的參與者變更。
 *
 * topic「event:{event_id}」由 broadcast_participant_change 觸發器發送，
 * payload 只含要投影的欄位。圖片一律由大螢幕自行去 Storage 抓，
 * 絕不走 Realtime（規格第 7 節、第 16 節第 2 點）。
 */

interface JoinedPayload {
  readonly id: string;
  readonly display_name: string;
  readonly character_name: string | null;
  readonly image_path: string;
  readonly joined_at: string;
}

interface RemovedPayload {
  readonly id: string;
}

export interface StageRealtimeHandlers {
  /** 新角色加入或被取消隱藏 */
  onJoined(character: CharacterData): void;
  /** 角色被隱藏或刪除 */
  onRemoved(id: string): void;
  /**
   * 頻道（重新）訂閱成功。斷線重連後必定觸發，
   * 呼叫端應在此做全量對帳，補上斷線期間遺漏的角色（規格第 7 節）。
   */
  onSubscribed(): void;
}

/** 回傳取消訂閱函式 */
export function subscribeStageRealtime(
  eventId: string,
  handlers: StageRealtimeHandlers,
): () => void {
  const supabase = getSupabaseBrowserClient();

  const channel = supabase.channel(`event:${eventId}`, {
    config: { broadcast: { self: false } },
  });

  channel.on(
    "broadcast",
    { event: "participant:joined" },
    ({ payload }) => {
      const row = payload as JoinedPayload;
      handlers.onJoined({
        id: row.id,
        displayName: row.display_name,
        characterName: row.character_name,
        imageUrl: characterSmallImageUrl(row.image_path),
        joinedAt: row.joined_at,
      });
    },
  );

  channel.on(
    "broadcast",
    { event: "participant:removed" },
    ({ payload }) => {
      handlers.onRemoved((payload as RemovedPayload).id);
    },
  );

  channel.subscribe((status) => {
    if (status === "SUBSCRIBED") {
      handlers.onSubscribed();
    }
  });

  return () => {
    void supabase.removeChannel(channel);
  };
}
