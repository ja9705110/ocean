"use client";

import type { DrawResult } from "@/lib/draw/api";

/**
 * 中獎者牆：活動結束後的回顧畫面。
 *
 * 依獎項分組顯示，順序與抽獎順序一致。
 * 人數多時自動縮小格子——寧可小一點，也不要分頁讓人看不完。
 */

interface WinnersWallProps {
  readonly draws: readonly DrawResult[];
  readonly eventName: string;
}

interface PrizeGroup {
  readonly prizeName: string;
  readonly winners: DrawResult[];
}

function groupByPrize(draws: readonly DrawResult[]): PrizeGroup[] {
  const groups: PrizeGroup[] = [];

  for (const draw of draws) {
    const existing = groups.find((g) => g.prizeName === draw.prizeName);
    if (existing) {
      existing.winners.push(draw);
    } else {
      groups.push({ prizeName: draw.prizeName, winners: [draw] });
    }
  }

  return groups;
}

export function WinnersWall({ draws, eventName }: WinnersWallProps) {
  const groups = groupByPrize(draws);
  const total = draws.length;

  // 人數越多格子越小，讓所有人都能同時出現在畫面上
  const cardWidth =
    total <= 6 ? "14rem" : total <= 14 ? "11rem" : total <= 30 ? "8.5rem" : "6.5rem";

  return (
    // 世界仍在背後運轉，留一點點透出來當作質地，但不能干擾閱讀
    <div className="absolute inset-0 overflow-y-auto bg-ink-950/[0.97]">
      <div className="mx-auto max-w-[92%] px-10 py-16">
        <p className="text-center text-xs tracking-[0.45em] text-ink-500 uppercase">
          {eventName}
        </p>
        <h2 className="mt-6 text-center text-4xl font-light text-ink-100">
          恭喜中獎
        </h2>

        {total === 0 ? (
          <p className="mt-16 text-center text-sm text-ink-500">
            這場活動沒有抽出中獎者。
          </p>
        ) : (
          <div className="mt-14 space-y-12">
            {groups.map((group) => (
              <section key={group.prizeName}>
                <div className="flex items-baseline gap-4">
                  <h3 className="text-xl font-light text-signal-400">
                    {group.prizeName}
                  </h3>
                  <span className="text-xs text-ink-600">
                    {group.winners.length} 位
                  </span>
                  <span className="ml-2 h-px flex-1 bg-ink-800" />
                </div>

                <ul className="mt-7 flex flex-wrap justify-center gap-6">
                  {group.winners.map((winner) => (
                    <li
                      key={winner.id}
                      className="flex flex-col items-center"
                      style={{ width: cardWidth }}
                    >
                      <div className="flex aspect-square w-full items-center justify-center rounded-xl bg-ink-900/70 p-3">
                        {/* 中獎者畫的角色 */}
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={winner.imageUrl}
                          alt=""
                          className="max-h-full max-w-full object-contain"
                          loading="lazy"
                        />
                      </div>
                      <p className="mt-3 w-full truncate text-center text-base font-light text-ink-100">
                        {winner.displayName}
                      </p>
                      {winner.characterName ? (
                        <p className="w-full truncate text-center text-xs text-ink-500">
                          {winner.characterName}
                        </p>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}

        <p className="mt-20 text-center text-xs text-ink-600">
          感謝每一位參與，世界因為你們而完整。
        </p>
      </div>
    </div>
  );
}
