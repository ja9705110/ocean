"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CreatureMark } from "@/components/quiz/CreatureMark";
import { listTableMessages, sendTableMessage } from "@/lib/quiz/api";
import { subscribeTableChat } from "@/lib/quiz/realtime";
import type { TableChat as TableChatData } from "@/lib/quiz/api";
import type { QuizTheme } from "@/lib/quiz/themes";

/**
 * 同桌聊天室（C22）。
 *
 * 一桌十個人圍著一張圓桌，照理說用講的就好。但現場不是這樣：
 * 音樂很大聲、隔壁桌也在討論、坐對面的人根本聽不到你說什麼。
 * 隊長代表賽尤其明顯——九個人有意見，隊長聽得到的只有旁邊兩個。
 *
 * 所以最重要的不是打字，是那四顆貼圖鍵：跟答題選項一模一樣的圖案，
 * 按一下就等於「我覺得選這個」。隊長低頭一看就知道全桌的意向。
 * 打字是備用的，現場沒有人有空打字。
 *
 * 只看得到自己那一桌。別桌的討論在問答裡就是答案。
 */

/**
 * 輪詢只是保險。
 *
 * 新訊息靠 Realtime 廣播推過來，按下去到別人看到大約就是一次
 * 網路來回。這個間隔是為了 WebSocket 斷掉的時候還能繼續玩——
 * 場館 Wi-Fi、手機進背景、連線數滿了都會斷。
 */
const FALLBACK_POLL_MS = 6000;

const MAX_LENGTH = 200;

interface TableChatProps {
  readonly sessionId: string;
  readonly deviceToken: string;
  readonly theme: QuizTheme;
}

export function TableChat({
  sessionId,
  deviceToken,
  theme,
}: TableChatProps) {
  const [chat, setChat] = useState<TableChatData | null>(null);
  const [draft, setDraft] = useState("");
  const [tooFast, setTooFast] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await listTableMessages(sessionId, deviceToken);
      setChat(next);
    } catch {
      // 讀不到就維持上一次的內容。討論中跳錯誤只會打斷討論。
    }
  }, [sessionId, deviceToken]);

  useEffect(() => {
    let cancelled = false;
    const tick = () => {
      if (!cancelled && document.visibilityState === "visible") {
        void refresh();
      }
    };
    const first = setTimeout(tick, 0);
    const timer = setInterval(tick, FALLBACK_POLL_MS);
    return () => {
      cancelled = true;
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [refresh]);

  /*
    訂閱這一桌的頻道。要先知道 team_id 才訂得到，而 team_id 是第一次
    拉訊息時才拿到的——所以這個 effect 依賴 chat?.teamId，
    在第一次載入完成之後才會接上。
  */
  const teamId = chat?.teamId ?? null;
  useEffect(() => {
    if (teamId === null) {
      return;
    }
    return subscribeTableChat(teamId, () => {
      void refresh();
    });
  }, [teamId, refresh]);

  // 新訊息進來就捲到底。討論看的是最後一句，不是第一句。
  useEffect(() => {
    const list = listRef.current;
    if (list) {
      list.scrollTop = list.scrollHeight;
    }
  }, [chat]);

  const send = useCallback(
    async (kind: "text" | "sticker", body: string) => {
      const trimmed = body.trim().slice(0, MAX_LENGTH);
      if (trimmed === "") {
        return;
      }
      const ok = await sendTableMessage(
        sessionId,
        deviceToken,
        kind,
        trimmed,
      ).catch(() => false);

      if (!ok) {
        // 撞到 1.2 秒的間隔限制。不跳錯誤打斷討論，閃一下就好。
        setTooFast(true);
        setTimeout(() => setTooFast(false), 1200);
        return;
      }
      if (kind === "text") {
        setDraft("");
      }
      // 廣播開了 self:true，自己送的那則會沿著同一條路回來，
      // 這裡不必再拉一次；廣播沒到的話保險輪詢也會補上
      void refresh();
    },
    [sessionId, deviceToken, refresh],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col border-t border-[var(--q-surface)] bg-[var(--q-bg)]">
      <header className="flex shrink-0 items-baseline justify-between px-5 pt-2 pb-1">
        <p className="text-xs font-medium text-[var(--q-text-soft)]">
          同桌討論
        </p>
        <p className="text-xs text-[var(--q-text-soft)]">只有這一桌看得到</p>
      </header>

      <div ref={listRef} className="min-h-0 flex-1 space-y-2 overflow-y-auto px-4 py-3">
        {chat === null ? (
          <p className="pt-8 text-center text-sm text-[var(--q-text-soft)]">
            載入中
          </p>
        ) : chat.messages.length === 0 ? (
          <p className="pt-8 text-center text-sm leading-relaxed text-[var(--q-text-soft)]">
            還沒有人說話。
            <br />
            按下面的圖案就等於「我覺得選這個」。
          </p>
        ) : (
          chat.messages.map((m) => {
            const mine = m.playerId === chat.myPlayerId;
            const option =
              m.kind === "sticker"
                ? theme.options[Number(m.body)] ?? null
                : null;

            return (
              <div
                key={m.id}
                className={mine ? "flex justify-end" : "flex justify-start"}
              >
                <div className={mine ? "max-w-[78%]" : "max-w-[78%]"}>
                  {/* 自己的訊息不必再標一次自己的名字 */}
                  {mine ? null : (
                    <p className="mb-0.5 px-1 text-xs text-[var(--q-text-soft)]">
                      {m.displayName}
                      {m.isCaptain ? " ・桌長" : ""}
                    </p>
                  )}

                  {option ? (
                    <div
                      className="flex items-center gap-2 rounded-2xl px-3 py-2"
                      style={{ backgroundColor: option.surface }}
                    >
                      <CreatureMark
                        creatureKey={option.creatureKey}
                        size={34}
                        color={option.color}
                      />
                      <span
                        className="text-sm font-medium"
                        style={{ color: option.color }}
                      >
                        選這個
                      </span>
                    </div>
                  ) : (
                    <div
                      className="rounded-2xl px-3.5 py-2 text-sm break-words"
                      style={{
                        backgroundColor: mine
                          ? "var(--q-accent)"
                          : "var(--q-surface)",
                        color: mine ? "#ffffff" : "var(--q-text)",
                      }}
                    >
                      {m.body}
                    </div>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>

      {/*
        貼圖與輸入框永遠貼在畫面最底部（C24）。

        shrink-0 讓它們不會被訊息擠掉，而外層已經鎖成一個視窗高，
        所以「最底部」就是螢幕的最底部，不是頁面的最底部——
        訊息再多也不必捲整個網頁才找得到輸入框。

        底部再墊一層安全區：iPhone 沒有實體 Home 鍵，畫面最下緣那一條
        是系統的手勢區，輸入框壓在上面會按不到。
      */}
      <div
        className="shrink-0 border-t border-[var(--q-surface)] px-4 pt-2.5"
        style={{ paddingBottom: "max(0.5rem, env(safe-area-inset-bottom))" }}
      >
        <div className="grid grid-cols-4 gap-2">
          {theme.options.map((option, index) => (
            <button
              key={option.creatureKey}
              type="button"
              onClick={() => void send("sticker", String(index))}
              className="flex flex-col items-center gap-0.5 rounded-2xl py-2 transition-transform duration-150 active:scale-95"
              style={{ backgroundColor: option.surface }}
            >
              <CreatureMark
                creatureKey={option.creatureKey}
                size={30}
                color={option.color}
              />
              <span
                className="text-xs font-medium"
                style={{ color: option.color }}
              >
                {option.name}
              </span>
            </button>
          ))}
        </div>

        <form
          className="mt-2.5 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void send("text", draft);
          }}
        >
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            maxLength={MAX_LENGTH}
            placeholder="想補一句話？"
            className="min-w-0 flex-1 rounded-xl bg-[var(--q-surface)] px-4 py-2.5 text-base text-[var(--q-text)] outline-none placeholder:text-[var(--q-text-soft)]"
          />
          <button
            type="submit"
            disabled={draft.trim() === ""}
            className="shrink-0 rounded-xl px-5 py-2.5 text-sm font-medium text-white disabled:opacity-30"
            style={{ backgroundColor: "var(--q-accent)" }}
          >
            送出
          </button>
        </form>

        {tooFast ? (
          <p className="pt-1.5 text-center text-xs text-[var(--q-text-soft)]">
            按太快了，等一下下
          </p>
        ) : null}
      </div>
    </div>
  );
}
