"use client";

import { useMemo } from "react";
import { CreatureMark } from "@/components/quiz/CreatureMark";
import {
  podiumMedal,
  podiumRevealDelayMs,
  rankPodium,
  type PodiumEntry,
} from "@/lib/quiz/podium";
import type { IndividualScore, QuizMode, TeamScore } from "@/lib/quiz/types";

/**
 * 頒獎畫面（C37）。
 *
 * 整場問答玩完之後的最後一頁。它跟每一題之間的「各桌積分」是兩件事：
 * 那一頁是進度，這一頁是結果——所以不是表格，是一座台子。
 *
 * 三個刻意的決定：
 *
 * 1. 由後往前揭曉。五個名次一次全部出現的話，眼睛會直接跳到第一名，
 *    中間那三位等於沒有被念到。一位一位上台，每一位都有屬於他的兩秒。
 * 2. 台子的高度照名次，不照分數。分數差一分跟差一千分，在台上
 *    應該長得一樣——那是名次的畫面，不是長條圖。
 * 3. 配色仍然是淺的。這一頁跟問答其他頁投在同一面牆上，
 *    深底淺字在投影機下會糊掉；金銀銅只用在台子本身。
 */

/**
 * 最高的那一座有多高，其餘名次照比例縮。
 *
 * 這個數字是量出來的：台子矮的時候，整組會沉在畫面下緣，
 * 標題與第一名之間空掉四分之一個螢幕。42vh 之後五座台子
 * 由外往內爬升的那條線才撐得起整個畫面。
 */
const TALLEST_VH = 42;

/** 前三名在台上還有名字，第四五名就只是名次。 */
const TITLES: Record<number, string> = { 1: "冠軍", 2: "亞軍", 3: "季軍" };

interface PodiumAwardProps {
  readonly mode: QuizMode;
  readonly sessionName: string;
  readonly teams: readonly TeamScore[];
  readonly players: readonly IndividualScore[];
}

export function PodiumAward({
  mode,
  sessionName,
  teams,
  players,
}: PodiumAwardProps) {
  /*
    隊長代表賽也是看各桌——隊長的分數就是全桌的分數，
    跟排行榜那一頁的取法一致。

    零分的桌子要濾掉：整場沒有人按過的那幾桌不該站上頒獎台，
    而且不足五桌時把它們補進來只會讓台上有人一臉茫然。
  */
  const places = useMemo(() => {
    const entries: PodiumEntry[] =
      mode === "individual"
        ? players
            .filter((p) => p.totalPoints > 0)
            .map((p) => ({
              key: p.playerId,
              name: p.displayName,
              sub: `${p.teamName} ｜ 答對 ${p.correctCount}`,
              color: p.teamColor,
              creatureKey: null,
              points: p.totalPoints,
            }))
        : teams
            .filter((t) => t.playerCount > 0 && t.totalPoints > 0)
            .map((t) => ({
              key: t.teamId,
              name: t.name,
              sub: `${t.playerCount} 人 ｜ 答對 ${t.correctCount}`,
              color: t.color,
              creatureKey: t.creatureKey,
              points: t.totalPoints,
            }));

    return rankPodium(entries);
  }, [mode, teams, players]);

  // 由左至右重排。名單本身是照名次的，畫面上不是
  const bySlot = useMemo(
    () => [...places].sort((a, b) => a.slot - b.slot),
    [places],
  );

  return (
    <div className="flex flex-1 flex-col">
      <style>{`
        /*
          上台：從台面下方浮上來。純淡入看起來像投影片換頁，
          帶一點位移才像「走上去」。
        */
        @keyframes podiumRise {
          from { opacity: 0; transform: translateY(26%); }
          to   { opacity: 1; transform: translateY(0); }
        }
        /*
          第一名站定之後，身後的金光緩慢地呼吸。
          金色是這場活動主視覺的顏色，跟餅乾照片牆的燙金是同一套。
        */
        @keyframes podiumHalo {
          0%, 100% { opacity: 0.45; transform: scale(1); }
          50%      { opacity: 0.85; transform: scale(1.05); }
        }
      `}</style>

      <header className="flex items-baseline justify-between">
        <h1 className="text-[3.2vw] font-semibold text-[var(--q-text)]">頒獎</h1>
        <span className="text-[1.6vw] text-[var(--q-text-soft)]">
          {sessionName}
        </span>
      </header>

      {bySlot.length === 0 ? (
        <div className="flex flex-1 items-center justify-center">
          <p className="text-[2vw] text-[var(--q-text-soft)]">
            還沒有人得分，先玩一題再頒獎
          </p>
        </div>
      ) : (
        <div className="flex flex-1 items-end justify-center gap-[1.4vw] pb-[2vh]">
          {bySlot.map((place) => {
            const { entry, rank } = place;
            const medal = podiumMedal(rank);
            const first = rank === 1;
            const delay = `${podiumRevealDelayMs(place.revealOrder)}ms`;

            return (
              <div
                key={entry.key}
                className="relative flex flex-col items-center"
                style={{
                  width: first ? "18vw" : "16vw",
                  // both：延遲還沒到之前就先套用 from，也就是還看不見。
                  // 沒有 both 的話五位會先全部出現、再各自animate一次。
                  animation:
                    "podiumRise 760ms cubic-bezier(0.16, 1, 0.3, 1) both",
                  animationDelay: delay,
                }}
              >
                {/* 第一名身後的光。放在最底層，不擋任何字 */}
                {first ? (
                  <div
                    aria-hidden
                    className="pointer-events-none absolute -inset-x-[4vw] -top-[4vh] bottom-0"
                    style={{
                      background:
                        "radial-gradient(closest-side, rgba(242, 192, 99, 0.55), rgba(242, 192, 99, 0) 72%)",
                      animation: "podiumHalo 4.2s ease-in-out infinite",
                      animationDelay: delay,
                    }}
                  />
                ) : null}

                {/* 名牌 */}
                <div className="relative flex flex-col items-center">
                  {TITLES[rank] ? (
                    <span
                      className="rounded-full px-[1vw] py-[0.4vh] text-[1.1vw] font-medium"
                      style={{
                        backgroundColor: medal.block,
                        color: medal.numeral,
                      }}
                    >
                      {TITLES[rank]}
                    </span>
                  ) : null}

                  <span className="mt-[1.2vh]">
                    {entry.creatureKey ? (
                      <CreatureMark
                        creatureKey={entry.creatureKey}
                        size={first ? 108 : 78}
                        color={entry.color}
                      />
                    ) : (
                      <span
                        className="block rounded-full"
                        style={{
                          width: first ? 108 : 78,
                          height: first ? 108 : 78,
                          backgroundColor: entry.color,
                        }}
                      />
                    )}
                  </span>

                  <span
                    className={`mt-[1.2vh] text-center leading-tight font-semibold text-[var(--q-text)] ${
                      first ? "text-[2.2vw]" : "text-[1.7vw]"
                    }`}
                  >
                    {entry.name}
                  </span>
                  <span className="mt-[0.4vh] text-center text-[1vw] text-[var(--q-text-soft)]">
                    {entry.sub}
                  </span>
                  <span
                    className={`mt-[0.6vh] font-semibold tabular-nums ${
                      first ? "text-[2.6vw]" : "text-[2vw]"
                    }`}
                    style={{ color: entry.color }}
                  >
                    {entry.points}
                  </span>
                </div>

                {/* 台子 */}
                <div
                  className="relative mt-[1.4vh] w-full overflow-hidden rounded-t-[0.8vw]"
                  style={{
                    height: `${TALLEST_VH * place.heightRatio}vh`,
                    backgroundColor: medal.block,
                    // 台面那一道亮邊，讓五座台子在淺色底上還分得出前後
                    boxShadow: `inset 0 0.8vh 0 ${medal.edge}, 0 0.6vh 1.6vh rgba(7, 46, 62, 0.18)`,
                  }}
                >
                  <span
                    className="absolute inset-x-0 top-[1.6vh] text-center text-[4.4vw] leading-none font-semibold tabular-nums"
                    style={{ color: medal.numeral }}
                  >
                    {rank}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
