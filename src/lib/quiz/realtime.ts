"use client";

import { getSupabaseBrowserClient } from "@/lib/supabase/client";

/**
 * 問答的即時推播（C23）。
 *
 * 資料庫那一端本來就在廣播了——start_quiz_question、jump_quiz_phase、
 * send_table_message 都有呼叫 realtime.send()，只是前端從來沒有訂閱，
 * 所以大螢幕與手機都靠輪詢，換題最慢會慢兩秒才跟上。
 *
 * 兩個頻道：
 *
 *   game:<場次 id>  換題、跳階段。大螢幕與全場手機都訂。
 *   table:<桌 id>   同桌的新訊息。只有那一桌的人訂——
 *                   頻道是桌不是場，扇出從三百五十變成三十幾。
 *
 * 廣播只說「有事發生了」，內容一律自己再拉一次。這樣不必擔心
 * 廣播漏掉或順序顛倒，也不會有人從廣播裡讀到還不該看見的正解。
 *
 * 輪詢不拿掉，改成慢速的保險。WebSocket 會斷——場館 Wi-Fi、手機
 * 進背景、連線數滿了都會。斷了就退回輪詢繼續玩，只是慢一點；
 * 沒有這一層的話，斷線的那支手機會整場停在同一題。
 */

export interface QuizRealtimeHandlers {
  /** 換題或跳階段：立刻重拉一次狀態 */
  readonly onChanged: () => void;
  /** 訂閱成功（含斷線重連）。重連時中間漏掉的都要補回來。 */
  readonly onSubscribed?: () => void;
}

/** 訂閱一場問答的換題與階段變化。回傳取消訂閱的函式。 */
export function subscribeQuizSession(
  sessionId: string,
  handlers: QuizRealtimeHandlers,
): () => void {
  const supabase = getSupabaseBrowserClient();
  const channel = supabase.channel(`game:${sessionId}`, {
    config: { broadcast: { self: true } },
  });

  channel.on("broadcast", { event: "quiz:question" }, () => {
    handlers.onChanged();
  });
  channel.on("broadcast", { event: "quiz:phase" }, () => {
    handlers.onChanged();
  });

  channel.subscribe((status) => {
    if (status === "SUBSCRIBED") {
      handlers.onSubscribed?.();
    }
  });

  return () => {
    void supabase.removeChannel(channel);
  };
}

/** 訂閱同桌的新訊息。回傳取消訂閱的函式。 */
export function subscribeTableChat(
  teamId: string,
  onMessage: () => void,
): () => void {
  const supabase = getSupabaseBrowserClient();
  const channel = supabase.channel(`table:${teamId}`, {
    // self: true——自己送出的也要收到，這樣送完不必再手動拉一次，
    // 而且自己的訊息與別人的會走同一條路，順序不會亂
    config: { broadcast: { self: true } },
  });

  channel.on("broadcast", { event: "table:message" }, () => {
    onMessage();
  });

  channel.subscribe();

  return () => {
    void supabase.removeChannel(channel);
  };
}
