"use client";

import { useEffect, useState } from "react";
import { getLobbyBoard } from "@/lib/quiz/api";
import type { LobbyTeam } from "@/lib/quiz/types";

/**
 * 開場等待時的入座看板（C16）。
 *
 * 主持人站在台上要做的判斷只有一個：現在可以開始了嗎？
 * 那個判斷需要的是「哪幾桌還沒進來」——不是總人數。
 * 三十桌的場子少了十個人，總數告訴不了你是某一桌整桌沒掃，
 * 還是十桌各少一個；而這兩件事要喊的話完全不一樣。
 *
 * 所以畫面上最大的那一行是缺席的桌號。主持人念得出號碼，
 * 那一桌的人才會低頭找桌卡。其他資訊都排在它後面。
 *
 * 兩秒一次輪詢。大螢幕只有一台，是全場唯一可以放心一直問的裝置。
 */

const POLL_MS = 2000;

/**
 * 缺席超過這個數字就不逐一列號碼。
 *
 * 十個號碼大概是主持人拿著麥克風一口氣念得完、台下也記得住的上限；
 * 再多就變成一串念不完的數字，反而讓人不知道有沒有念到自己那桌。
 */
const LIST_LIMIT = 10;

interface LobbyBoardProps {
  readonly sessionId: string;
}

export function LobbyBoard({ sessionId }: LobbyBoardProps) {
  const [teams, setTeams] = useState<LobbyTeam[] | null>(null);

  useEffect(() => {
    let cancelled = false;

    const poll = () => {
      getLobbyBoard(sessionId)
        .then((rows) => {
          if (!cancelled) {
            setTeams(rows);
          }
        })
        // 查不到就維持上一次的畫面。等待時閃一個錯誤訊息給全場看，
        // 比暫時停在舊資料糟得多
        .catch(() => undefined);
    };

    // 第一次也走非同步，避免在 effect 內同步觸發狀態更新
    const first = setTimeout(poll, 0);
    const timer = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [sessionId]);

  if (teams === null || teams.length === 0) {
    return null;
  }

  return <LobbyView teams={teams} />;
}

/**
 * 看板本身，跟資料怎麼來無關。
 *
 * 跟輪詢分開是為了能單獨把各種情況畫出來檢查：三十桌全空、
 * 只缺兩桌、全部到齊、隊名很長。這些狀態在真的活動當天各只會出現一次，
 * 沒辦法等到那時候才發現版面爆掉。
 */
export function LobbyView({ teams }: { readonly teams: readonly LobbyTeam[] }) {
  const joined = teams.filter((team) => team.playerCount > 0);
  const missing = teams.filter((team) => team.playerCount === 0);
  const seated = teams.reduce((sum, team) => sum + team.playerCount, 0);
  const captains = teams.filter((team) => team.captainName !== null);

  return (
    <div className="w-full">
      {/* 摘要：一眼看到進度，細節在下面 */}
      <div className="flex flex-wrap items-baseline justify-center gap-x-[2.5vw] gap-y-[1vh]">
        <p className="text-[2.4vw] font-semibold text-[var(--q-text)] tabular-nums">
          {joined.length}
          <span className="mx-[0.4vw] text-[1.6vw] font-normal text-[var(--q-text-soft)]">
            /
          </span>
          {teams.length}
          <span className="ml-[0.6vw] text-[1.6vw] font-normal text-[var(--q-text-soft)]">
            桌已加入
          </span>
        </p>
        <p className="text-[1.6vw] text-[var(--q-text-soft)] tabular-nums">
          已入座 {seated} 位
        </p>
        {captains.length > 0 ? (
          <p className="text-[1.6vw] text-[var(--q-text-soft)] tabular-nums">
            桌長 {captains.length} 位
          </p>
        ) : null}
      </div>

      {/*
        中間這一塊是主持人唯一要「做點什麼」的資訊，所以它隨進度換內容。
        一直放同一塊紅字沒有用：

        還沒開始入座時，缺三十桌是理所當然的，把三十個號碼用大紅字
        列出來只是在嚇人，主持人這時候要講的是「請大家掃桌卡」。

        剩下超過十桌時，念號碼比念「還有十五桌」慢得多，也記不住。
        底下的格子已經標出是哪幾桌，這裡只要給數字。

        剩下十桌以內才把號碼放大——那是真的要對著麥克風念的時候。
      */}
      {joined.length === 0 ? (
        <p className="mt-[2.2vh] text-center text-[2.2vw] font-semibold text-[var(--q-text)]">
          請掃桌上的 QR Code 入座
        </p>
      ) : missing.length === 0 ? (
        <p className="mt-[2.2vh] text-center text-[2.2vw] font-semibold text-[#047857]">
          {teams.length} 桌全部到齊
        </p>
      ) : missing.length > LIST_LIMIT ? (
        <p className="mt-[2.2vh] text-center text-[2.2vw] font-semibold text-[#e11d48] tabular-nums">
          還有 {missing.length} 桌沒加入
        </p>
      ) : (
        <div className="mx-auto mt-[2.2vh] w-fit max-w-full rounded-[1.2vw] bg-[#fff1f2] px-[3vw] py-[1.3vh] text-center">
          <p className="text-[1.4vw] text-[#9f1239]">還沒加入的桌次</p>
          <p className="mt-[0.6vh] flex flex-wrap justify-center gap-x-[1.6vw] gap-y-[0.4vh] text-[2.9vw] leading-tight font-semibold text-[#e11d48] tabular-nums">
            {missing.map((team) => (
              <span key={team.teamId}>{team.tableNo}</span>
            ))}
          </p>
        </div>
      )}

      {/*
        一桌一個圓圈，三種狀態一眼分得出來：

          還沒加入   虛線空心，靜止不動
          有人加入   浮起來，用桌子的顏色但是半透明——「這桌活了」
          選好桌長   停止漂浮、轉成實色，桌長的名字寫在下面

        「好了沒」是靠動與不動分辨的，那比顏色差異更容易在三十公尺外
        看出來，也不必去記哪個顏色代表什麼。

        每一顆的動畫延遲錯開，否則三十顆會像同一塊板子在上下震。
      */}
      <div
        className="mt-[2.2vh] grid justify-items-center gap-x-[0.6vw] gap-y-[1.6vh]"
        style={{ gridTemplateColumns: "repeat(auto-fit, minmax(8.5vw, 1fr))" }}
      >
        {teams.map((team, index) => {
          const here = team.playerCount > 0;
          const ready = team.captainName !== null;

          return (
            <div key={team.teamId} className="flex flex-col items-center">
              <div
                className={here && !ready ? "animate-bob" : undefined}
                style={{
                  // 錯開起跑點，讓它們各浮各的
                  animationDelay: `${(index % 7) * 0.42}s`,
                }}
              >
                <div
                  className="flex items-center justify-center rounded-full"
                  style={{
                    width: "5.6vw",
                    height: "5.6vw",
                    backgroundColor: ready
                      ? team.color
                      : here
                        ? `${team.color}33`
                        : "transparent",
                    border: ready
                      ? `0.2vw solid ${team.color}`
                      : here
                        ? `0.2vw solid ${team.color}`
                        : "0.16vw dashed var(--q-text-soft)",
                    opacity: here ? 1 : 0.4,
                    boxShadow: ready ? `0 0 1.6vw ${team.color}55` : undefined,
                  }}
                >
                  <span
                    className="text-[2.1vw] leading-none font-semibold tabular-nums"
                    style={{
                      // 實色底上要用白字，半透明底上用桌子的顏色
                      color: ready ? "#ffffff" : here ? team.color : "var(--q-text-soft)",
                    }}
                  >
                    {team.tableNo}
                  </span>
                </div>
              </div>

              <span className="mt-[0.6vh] max-w-[8vw] truncate text-[0.95vw] text-[var(--q-text-soft)] tabular-nums">
                {ready
                  ? `桌長 ${team.captainName}`
                  : here
                    ? `${team.playerCount} 位`
                    : "尚未加入"}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
