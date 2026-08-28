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

      {/* 每一桌的細節。桌號用桌上的實際編號，主持人喊得出來。 */}
      <div
        className="mt-[2.2vh] grid gap-[0.7vw]"
        style={{
          gridTemplateColumns: "repeat(auto-fit, minmax(11vw, 1fr))",
        }}
      >
        {teams.map((team) => {
          const here = team.playerCount > 0;
          return (
            <div
              key={team.teamId}
              className="rounded-[0.8vw] px-[1vw] py-[0.85vh]"
              style={{
                backgroundColor: here ? `${team.color}1f` : "transparent",
                border: here
                  ? `0.14vw solid ${team.color}`
                  : "0.14vw dashed var(--q-text-soft)",
                opacity: here ? 1 : 0.45,
              }}
            >
              <div className="flex items-baseline justify-between gap-[0.6vw]">
                <span
                  className="text-[1.9vw] leading-none font-semibold tabular-nums"
                  style={{ color: here ? team.color : "var(--q-text-soft)" }}
                >
                  {team.tableNo}
                </span>
                <span className="text-[1.1vw] text-[var(--q-text-soft)] tabular-nums">
                  {here ? `${team.playerCount} 位` : "尚未加入"}
                </span>
              </div>

              {/* 隊名沒改過時就等於桌號，再印一次只是雜訊 */}
              {team.name !== `第 ${team.tableNo} 桌` ? (
                <p className="mt-[0.4vh] truncate text-[1vw] text-[var(--q-text-soft)]">
                  {team.name}
                </p>
              ) : null}

              {team.captainName ? (
                <p
                  className="mt-[0.4vh] truncate text-[1vw] font-medium"
                  style={{ color: team.color }}
                >
                  桌長 {team.captainName}
                </p>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
