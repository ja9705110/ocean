"use client";

import { useCallback, useMemo, useState } from "react";
import { drawWinner, replayDraw, voidDraw } from "@/lib/draw/api";
import type { DrawResult, Prize } from "@/lib/draw/api";

/**
 * 抽獎控制台。
 *
 * 一顆主按鈕就能運作：現場壓力下不該有選擇障礙。
 * 系統自動指向第一個還沒抽滿的獎項，主持人也可以手動切換。
 */

interface DrawPanelProps {
  readonly eventId: string;
  readonly prizes: Prize[];
  readonly draws: DrawResult[];
  readonly onChanged: () => void;
}

export function DrawPanel({
  eventId,
  prizes,
  draws,
  onChanged,
}: DrawPanelProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [manualPrizeId, setManualPrizeId] = useState<string | null>(null);

  // 預設指向第一個還有名額的獎項
  const autoPrize = useMemo(
    () => prizes.find((prize) => prize.drawnCount < prize.quantity) ?? null,
    [prizes],
  );

  const activePrize = useMemo(() => {
    if (manualPrizeId) {
      return prizes.find((prize) => prize.id === manualPrizeId) ?? autoPrize;
    }
    return autoPrize;
  }, [manualPrizeId, prizes, autoPrize]);

  const run = useCallback(
    async (action: () => Promise<void>) => {
      setBusy(true);
      setError(null);
      try {
        await action();
        onChanged();
      } catch (actionError) {
        setError(
          actionError instanceof Error
            ? actionError.message
            : String(actionError),
        );
      } finally {
        setBusy(false);
      }
    },
    [onChanged],
  );

  const draw = useCallback(() => {
    if (!activePrize) {
      return;
    }
    void run(async () => {
      await drawWinner(eventId, activePrize.id);
    });
  }, [activePrize, eventId, run]);

  const allDone = prizes.length > 0 && autoPrize === null;
  const quotaLeft = activePrize
    ? activePrize.quantity - activePrize.drawnCount
    : 0;

  return (
    <section className="rounded-lg border border-ink-800 bg-ink-900/50 p-7">
      <h2 className="text-sm text-ink-300">抽獎</h2>

      {prizes.length === 0 ? (
        <p className="mt-4 text-sm text-ink-500">請先在上方設定獎項。</p>
      ) : (
        <>
          <div className="mt-5 flex flex-wrap items-end gap-4">
            <div className="min-w-[14rem] flex-1">
              <label
                htmlFor="draw-prize"
                className="block text-xs text-ink-400"
              >
                目前抽的獎項
              </label>
              <select
                id="draw-prize"
                value={activePrize?.id ?? ""}
                onChange={(e) => setManualPrizeId(e.target.value)}
                className="mt-1.5 w-full rounded-lg border border-ink-700 bg-ink-950 px-3 py-2.5 text-sm text-ink-100 outline-none transition-colors duration-300 ease-world focus:border-signal-500"
              >
                {prizes.map((prize) => (
                  <option key={prize.id} value={prize.id}>
                    {prize.name}（{prize.drawnCount}／{prize.quantity}）
                  </option>
                ))}
              </select>
            </div>

            <button
              type="button"
              disabled={busy || !activePrize || quotaLeft <= 0}
              onClick={draw}
              className="rounded-lg bg-signal-500 px-8 py-3 text-base font-medium text-ink-950 transition-opacity duration-300 ease-world disabled:opacity-30"
            >
              {busy ? "抽獎中" : "抽出下一位"}
            </button>
          </div>

          <p className="mt-4 text-xs leading-relaxed text-ink-500">
            {allDone
              ? "所有獎項都抽完了。"
              : activePrize
                ? `這個獎項還剩 ${quotaLeft} 個名額。按下後大螢幕會播放聚集與揭曉動畫。`
                : "沒有可抽的獎項。"}
          </p>
        </>
      )}

      {error ? (
        <p className="mt-4 rounded-lg border border-ink-700 bg-ink-950 px-4 py-3 text-xs leading-relaxed text-alert-500">
          {error}
        </p>
      ) : null}

      {/* 中獎名單 */}
      {draws.length > 0 ? (
        <div className="mt-8">
          <h3 className="text-xs text-ink-400">中獎名單</h3>
          <ul className="mt-3 divide-y divide-ink-800 border-y border-ink-800">
            {draws.map((result) => (
              <li key={result.id} className="flex items-center gap-4 py-3">
                <span className="w-8 shrink-0 text-right font-mono text-xs text-ink-600">
                  {result.roundNo}
                </span>
                <div className="size-10 shrink-0 overflow-hidden rounded bg-ink-900">
                  {/* 參與者的角色圖，來源為 Storage 公開 bucket */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={result.imageUrl}
                    alt=""
                    className="size-full object-contain"
                    loading="lazy"
                  />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-ink-100">
                    {result.displayName}
                    {result.characterName ? (
                      <span className="ml-2 text-xs text-ink-500">
                        {result.characterName}
                      </span>
                    ) : null}
                  </p>
                  <p className="text-xs text-signal-400/80">
                    {result.prizeName}
                  </p>
                </div>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void run(() => replayDraw(result.id))}
                  className="shrink-0 text-xs text-ink-500 underline-offset-4 hover:text-ink-300 hover:underline disabled:opacity-40"
                >
                  重播
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void run(() => voidDraw(result.id))}
                  className="shrink-0 text-xs text-alert-500 underline-offset-4 hover:underline disabled:opacity-40"
                  title="作廢這一輪，名額會回到該獎項"
                >
                  作廢
                </button>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs leading-relaxed text-ink-500">
            重播會讓大螢幕重新播放該位的揭曉動畫（投影中斷時補救用）。
            作廢會收回這筆中獎，名額回到該獎項可重抽。
          </p>
        </div>
      ) : null}
    </section>
  );
}
