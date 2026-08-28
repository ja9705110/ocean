"use client";

import { useEffect, useState } from "react";
import { getIndividualScores, getTeamScores } from "@/lib/quiz/api";
import type {
  IndividualScore,
  QuizMode,
  TeamScore,
} from "@/lib/quiz/types";

/**
 * 手機上的排行榜（C19）。
 *
 * 大螢幕上有一份，但那份只放得下前幾名，而且字再大，
 * 三十公尺外坐後排的人還是看不到自己排第幾。分數就是這個遊戲的
 * 全部樂趣，讓人「知道自己現在幾分、排第幾」不能只靠抬頭。
 *
 * 只在公布分數那一段抓資料。作答中間全場手機最忙，
 * 那時候多打一次伺服器最不划算，而那時候也沒有排行榜可看。
 */

const TOP = 8;

interface PlayerRankingProps {
  readonly sessionId: string;
  readonly mode: QuizMode;
  /** 這支手機屬於哪一桌，用來把自己那一列標出來 */
  readonly teamName: string;
  readonly teamColor: string;
  readonly myTotal: number;
}

export function PlayerRanking({
  sessionId,
  mode,
  teamName,
  teamColor,
  myTotal,
}: PlayerRankingProps) {
  const [teams, setTeams] = useState<TeamScore[] | null>(null);
  const [players, setPlayers] = useState<IndividualScore[] | null>(null);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      // 讓狀態更新脫離 effect 的同步階段，避免掛載當下的連鎖重渲染
      await Promise.resolve();
      try {
        if (mode === "individual") {
          const rows = await getIndividualScores(sessionId, TOP);
          if (!cancelled) {
            setPlayers(rows);
          }
        } else {
          const rows = await getTeamScores(sessionId);
          if (!cancelled) {
            setTeams(rows);
          }
        }
      } catch {
        // 排行榜抓不到不該蓋掉整個畫面，下一題照樣玩得下去
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [sessionId, mode]);

  const rows =
    mode === "individual"
      ? (players ?? []).map((p, i) => ({
          key: p.playerId,
          rank: i + 1,
          name: p.displayName,
          sub: p.teamName,
          color: p.teamColor,
          points: p.totalPoints,
          mine: false,
        }))
      : (teams ?? []).slice(0, TOP).map((t, i) => ({
          key: t.teamId,
          rank: i + 1,
          name: t.name,
          sub: `${t.playerCount} 位`,
          color: t.color,
          points: t.totalPoints,
          mine: t.name === teamName,
        }));

  if (rows.length === 0) {
    return null;
  }

  return (
    <section className="px-5 pb-6">
      <p className="text-xs tracking-widest text-[var(--q-text-soft)]">
        {mode === "individual" ? "個人排行" : "各桌排行"}
      </p>

      <ul className="mt-3 space-y-1.5">
        {rows.map((row) => (
          <li
            key={row.key}
            className="flex items-center gap-3 rounded-xl px-3 py-2.5"
            style={{
              // 自己那一列用桌子的顏色墊底，低頭掃一眼就找得到
              backgroundColor: row.mine ? `${row.color}22` : "var(--q-surface)",
              border: row.mine
                ? `2px solid ${row.color}`
                : "2px solid transparent",
            }}
          >
            <span className="w-5 shrink-0 text-sm text-[var(--q-text-soft)] tabular-nums">
              {row.rank}
            </span>
            <span
              className="size-2.5 shrink-0 rounded-full"
              style={{ backgroundColor: row.color }}
            />
            <span className="min-w-0 flex-1 truncate text-sm text-[var(--q-text)]">
              {row.name}
            </span>
            <span className="shrink-0 text-xs text-[var(--q-text-soft)]">
              {row.sub}
            </span>
            <span className="w-14 shrink-0 text-right text-sm font-medium text-[var(--q-text)] tabular-nums">
              {row.points}
            </span>
          </li>
        ))}
      </ul>

      {/*
        個人賽時上面那份是全場前八名，多數人不在裡面。
        自己的分數一定要有一個固定的位置，不然看排行榜只會覺得跟自己無關。
      */}
      <p className="mt-4 text-center text-sm text-[var(--q-text-soft)]">
        你目前{" "}
        <span
          className="text-base font-medium tabular-nums"
          style={{ color: teamColor }}
        >
          {myTotal}
        </span>{" "}
        分
        {mode === "individual" ? "" : `　・　${teamName}`}
      </p>
    </section>
  );
}
