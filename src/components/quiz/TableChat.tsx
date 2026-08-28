"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CreatureMark } from "@/components/quiz/CreatureMark";
import { listTableMessages, sendTableMessage } from "@/lib/quiz/api";
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

/** 作答中要盯著手機看意見，所以問得比平常勤 */
const ACTIVE_POLL_MS = 2000;
/** 不在作答的時候慢一點，省下的是三百支手機的頻寬 */
const IDLE_POLL_MS = 5000;

const MAX_LENGTH = 200;

interface TableChatProps {
  readonly sessionId: string;
  readonly deviceToken: string;
  readonly theme: QuizTheme;
  /** 作答視窗開著：這時候大家最需要交換意見 */
  readonly active: boolean;
  readonly onClose: () => void;
}

export function TableChat({
  sessionId,
  deviceToken,
  theme,
  active,
  onClose,
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
    const timer = setInterval(tick, active ? ACTIVE_POLL_MS : IDLE_POLL_MS);
    return () => {
      cancelled = true;
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [refresh, active]);

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
      await refresh();
    },
    [sessionId, deviceToken, refresh],
  );

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-[var(--q-bg)]">
      <header className="flex shrink-0 items-center justify-between border-b border-[var(--q-surface)] px-5 py-3">
        <div>
          <p className="text-sm font-medium text-[var(--q-text)]">同桌討論</p>
          <p className="mt-0.5 text-xs text-[var(--q-text-soft)]">
            只有這一桌看得到
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg bg-[var(--q-surface)] px-4 py-2 text-sm text-[var(--q-text)]"
        >
          收起來
        </button>
      </header>

      <div ref={listRef} className="min-h-0 flex-1 space-y-2 overflow-y-auto px-4 py-4">
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
        四顆貼圖是主角，排在最上面也最大。跟答題的圖案完全一樣——
        按下去不必解釋是什麼意思，隊長看到也不必翻譯。
      */}
      <div className="shrink-0 border-t border-[var(--q-surface)] px-4 pt-3">
        <div className="grid grid-cols-4 gap-2">
          {theme.options.map((option, index) => (
            <button
              key={option.creatureKey}
              type="button"
              onClick={() => void send("sticker", String(index))}
              className="flex flex-col items-center gap-1 rounded-2xl py-2.5 transition-transform duration-150 active:scale-95"
              style={{ backgroundColor: option.surface }}
            >
              <CreatureMark
                creatureKey={option.creatureKey}
                size={38}
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
          className="mt-3 mb-4 flex gap-2"
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
            className="min-w-0 flex-1 rounded-xl bg-[var(--q-surface)] px-4 py-3 text-base text-[var(--q-text)] outline-none placeholder:text-[var(--q-text-soft)]"
          />
          <button
            type="submit"
            disabled={draft.trim() === ""}
            className="shrink-0 rounded-xl px-5 py-3 text-sm font-medium text-white disabled:opacity-30"
            style={{ backgroundColor: "var(--q-accent)" }}
          >
            送出
          </button>
        </form>

        {tooFast ? (
          <p className="pb-3 text-center text-xs text-[var(--q-text-soft)]">
            按太快了，等一下下
          </p>
        ) : null}
      </div>
    </div>
  );
}
