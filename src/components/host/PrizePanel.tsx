"use client";

import { useCallback, useState } from "react";
import { createPrize, deletePrize, updatePrize } from "@/lib/draw/api";
import type { Prize } from "@/lib/draw/api";

/**
 * 獎項設定：什麼獎、抽幾人、順序。
 * 已抽出的獎項不可刪除，名額也不可低於已抽出數量——
 * 否則 draws 會出現對不上的孤兒紀錄。
 */

interface PrizePanelProps {
  readonly eventId: string;
  readonly prizes: Prize[];
  readonly onChanged: () => void;
}

export function PrizePanel({ eventId, prizes, onChanged }: PrizePanelProps) {
  const [name, setName] = useState("");
  const [quantity, setQuantity] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  const add = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const trimmed = name.trim();
      if (trimmed === "") {
        return;
      }
      const nextOrder =
        prizes.reduce((max, prize) => Math.max(max, prize.sortOrder), -1) + 1;
      void run(async () => {
        await createPrize(eventId, trimmed, quantity, nextOrder);
        setName("");
        setQuantity(1);
      });
    },
    [name, quantity, prizes, eventId, run],
  );

  const move = useCallback(
    (index: number, direction: -1 | 1) => {
      const current = prizes[index];
      const swap = prizes[index + direction];
      if (!current || !swap) {
        return;
      }
      void run(async () => {
        await updatePrize(current.id, { sortOrder: swap.sortOrder });
        await updatePrize(swap.id, { sortOrder: current.sortOrder });
      });
    },
    [prizes, run],
  );

  const totalQuota = prizes.reduce((sum, prize) => sum + prize.quantity, 0);
  const totalDrawn = prizes.reduce((sum, prize) => sum + prize.drawnCount, 0);

  return (
    <section className="rounded-lg border border-ink-800 bg-ink-900/50 p-7">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm text-ink-300">獎項</h2>
        <span className="text-xs text-ink-500">
          共 {totalQuota} 個名額 ｜ 已抽出 {totalDrawn}
        </span>
      </div>

      <p className="mt-3 text-xs leading-relaxed text-ink-500">
        由上而下依序抽獎。已抽出的獎項不能刪除，名額也不能改到比已抽出的人數少。
      </p>

      {error ? (
        <p className="mt-4 text-xs leading-relaxed text-alert-500">{error}</p>
      ) : null}

      {prizes.length > 0 ? (
        <ul className="mt-6 divide-y divide-ink-800 border-y border-ink-800">
          {prizes.map((prize, index) => {
            const locked = prize.drawnCount > 0;
            return (
              <li key={prize.id} className="flex items-center gap-3 py-3">
                <div className="flex shrink-0 flex-col gap-0.5">
                  <button
                    type="button"
                    aria-label="上移"
                    disabled={busy || index === 0}
                    onClick={() => move(index, -1)}
                    className="px-1 text-[0.6rem] leading-none text-ink-600 hover:text-ink-300 disabled:opacity-25"
                  >
                    ▲
                  </button>
                  <button
                    type="button"
                    aria-label="下移"
                    disabled={busy || index === prizes.length - 1}
                    onClick={() => move(index, 1)}
                    className="px-1 text-[0.6rem] leading-none text-ink-600 hover:text-ink-300 disabled:opacity-25"
                  >
                    ▼
                  </button>
                </div>

                <input
                  defaultValue={prize.name}
                  maxLength={40}
                  disabled={busy}
                  onBlur={(e) => {
                    const next = e.target.value.trim();
                    if (next !== "" && next !== prize.name) {
                      void run(() => updatePrize(prize.id, { name: next }));
                    } else {
                      e.target.value = prize.name;
                    }
                  }}
                  className="min-w-0 flex-1 rounded border border-transparent bg-transparent px-2 py-1.5 text-sm text-ink-100 outline-none transition-colors duration-300 ease-world hover:border-ink-700 focus:border-signal-500"
                />

                <div className="flex shrink-0 items-center gap-1.5">
                  <input
                    type="number"
                    min={Math.max(1, prize.drawnCount)}
                    max={500}
                    defaultValue={prize.quantity}
                    disabled={busy}
                    onBlur={(e) => {
                      const next = Number(e.target.value);
                      if (
                        Number.isFinite(next) &&
                        next >= Math.max(1, prize.drawnCount) &&
                        next !== prize.quantity
                      ) {
                        void run(() =>
                          updatePrize(prize.id, { quantity: next }),
                        );
                      } else {
                        e.target.value = String(prize.quantity);
                      }
                    }}
                    className="w-16 rounded border border-transparent bg-transparent px-2 py-1.5 text-right text-sm text-ink-100 outline-none transition-colors duration-300 ease-world hover:border-ink-700 focus:border-signal-500"
                  />
                  <span className="text-xs text-ink-500">位</span>
                </div>

                <span className="w-16 shrink-0 text-right text-xs text-ink-500">
                  {prize.drawnCount}／{prize.quantity}
                </span>

                <button
                  type="button"
                  disabled={busy || locked}
                  title={locked ? "已抽出，不能刪除" : "刪除獎項"}
                  onClick={() => void run(() => deletePrize(prize.id))}
                  className="shrink-0 text-xs text-alert-500 underline-offset-4 hover:underline disabled:opacity-25"
                >
                  刪除
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="mt-6 text-sm text-ink-500">還沒有設定獎項。</p>
      )}

      <form onSubmit={add} className="mt-6 flex flex-wrap items-end gap-3">
        <div className="min-w-[12rem] flex-1">
          <label htmlFor="prize-name" className="block text-xs text-ink-400">
            獎項名稱
          </label>
          <input
            id="prize-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={40}
            placeholder="例如：頭獎 掃地機器人"
            className="mt-1.5 w-full rounded-lg border border-ink-700 bg-ink-950 px-3 py-2 text-sm text-ink-100 outline-none transition-colors duration-300 ease-world placeholder:text-ink-600 focus:border-signal-500"
          />
        </div>
        <div className="w-24">
          <label htmlFor="prize-qty" className="block text-xs text-ink-400">
            抽幾位
          </label>
          <input
            id="prize-qty"
            type="number"
            min={1}
            max={500}
            value={quantity}
            onChange={(e) => setQuantity(Number(e.target.value))}
            className="mt-1.5 w-full rounded-lg border border-ink-700 bg-ink-950 px-3 py-2 text-sm text-ink-100 outline-none transition-colors duration-300 ease-world focus:border-signal-500"
          />
        </div>
        <button
          type="submit"
          disabled={busy || name.trim() === ""}
          className="rounded-lg border border-ink-700 px-5 py-2 text-sm text-ink-300 transition-colors duration-300 ease-world hover:bg-ink-800 disabled:opacity-40"
        >
          新增獎項
        </button>
      </form>
    </section>
  );
}
