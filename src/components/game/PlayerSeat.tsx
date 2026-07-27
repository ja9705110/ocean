"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getOrCreateDeviceToken } from "@/lib/device";
import { joinGame, listTeamPlayers } from "@/lib/game/api";
import { GAME_STATUS_HINT } from "@/lib/game/types";
import type { JoinedSeat, TeamPlayer } from "@/lib/game/types";

/**
 * 玩家入座（G0）。
 *
 * 掃桌卡 → 輸入姓名 → 入座 → 等待開始。
 * 姓名沿用抽獎端的 localStorage 紀錄，畫過角色的人不必再打一次。
 *
 * 等待期間以輪詢更新隊友名單。這是刻意的：Realtime 連線數是稀缺資源，
 * 要留給遊戲進行中的輸入通道，大廳階段沒必要佔用。
 */

const LOBBY_POLL_MS = 3000;
const LAST_NAME_KEY = "iwd:last-name";

interface PlayerSeatProps {
  readonly joinCode: string;
}

export function PlayerSeat({ joinCode }: PlayerSeatProps) {
  const [seat, setSeat] = useState<JoinedSeat | null>(null);
  const [teammates, setTeammates] = useState<TeamPlayer[]>([]);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const deviceTokenRef = useRef<string>("");

  // 帶入先前用過的姓名
  useEffect(() => {
    let cancelled = false;

    const restore = async () => {
      await Promise.resolve();
      if (cancelled) {
        return;
      }
      deviceTokenRef.current = getOrCreateDeviceToken();
      try {
        const stored = window.localStorage.getItem(LAST_NAME_KEY);
        if (stored) {
          setName(stored);
        }
      } catch {
        // localStorage 不可用時就讓使用者自己打
      }
    };

    void restore();
    return () => {
      cancelled = true;
    };
  }, []);

  const submit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const trimmed = name.trim();
      if (trimmed === "") {
        return;
      }

      setBusy(true);
      setError(null);
      try {
        const joined = await joinGame(
          joinCode,
          deviceTokenRef.current,
          trimmed,
        );
        try {
          window.localStorage.setItem(LAST_NAME_KEY, trimmed);
        } catch {
          // 存不進去不影響入座
        }
        setSeat(joined);
      } catch (joinError) {
        setError(
          joinError instanceof Error ? joinError.message : String(joinError),
        );
      } finally {
        setBusy(false);
      }
    },
    [joinCode, name],
  );

  // 大廳輪詢隊友
  useEffect(() => {
    if (!seat) {
      return;
    }

    let cancelled = false;
    const poll = () => {
      if (document.visibilityState !== "visible") {
        return;
      }
      listTeamPlayers(seat.teamId)
        .then((rows) => {
          if (!cancelled) {
            setTeammates(rows);
          }
        })
        .catch(() => undefined);
    };

    poll();
    const timer = setInterval(poll, LOBBY_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [seat]);

  if (!seat) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-8 py-16">
        <p className="text-xs tracking-[0.35em] text-ink-500 uppercase">
          {joinCode}
        </p>
        <h1 className="mt-6 text-3xl font-light text-ink-100">入座</h1>
        <p className="mt-4 text-sm leading-relaxed text-ink-400">
          你掃到的是這一桌的座位卡。輸入姓名就能加入這桌的隊伍。
        </p>

        <form className="mt-12" onSubmit={(e) => void submit(e)}>
          <label htmlFor="player-name" className="block text-sm text-ink-300">
            你的姓名
          </label>
          <input
            id="player-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={30}
            autoComplete="name"
            className="mt-3 w-full rounded-lg border border-ink-700 bg-ink-900 px-4 py-3 text-base text-ink-100 outline-none transition-colors duration-300 ease-world placeholder:text-ink-600 focus:border-signal-500"
            placeholder="讓隊友認得你"
          />

          {error ? (
            <p className="mt-5 text-xs leading-relaxed text-alert-500">
              {error}
            </p>
          ) : null}

          <button
            type="submit"
            disabled={busy || name.trim() === ""}
            className="mt-7 w-full rounded-lg bg-signal-500 py-3.5 text-base font-medium text-ink-950 transition-opacity duration-300 ease-world disabled:opacity-30"
          >
            {busy ? "入座中" : "入座"}
          </button>
        </form>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-8 py-16">
      <div
        className="rounded-2xl border px-7 py-8 text-center"
        style={{
          borderColor: `${seat.teamColor}66`,
          backgroundColor: `${seat.teamColor}12`,
        }}
      >
        <p className="text-xs tracking-[0.35em] text-ink-400 uppercase">
          第 {seat.tableNo} 桌
        </p>
        {/* 隊名未改過時就等於桌號，重複顯示會像是畫面出錯 */}
        {seat.teamName !== `第 ${seat.tableNo} 桌` ? (
          <h1
            className="mt-4 text-3xl font-light"
            style={{ color: seat.teamColor }}
          >
            {seat.teamName}
          </h1>
        ) : (
          <p
            className="mt-4 text-3xl font-light"
            style={{ color: seat.teamColor }}
          >
            入座完成
          </p>
        )}
        <p className="mt-5 text-sm text-ink-300">
          等隊友到齊就開始，手機先不要關掉
        </p>
      </div>

      <div className="mt-10">
        <p className="text-xs text-ink-400">
          隊友 {teammates.length} 位
        </p>
        <ul className="mt-4 flex flex-wrap gap-2">
          {teammates.map((mate) => (
            <li
              key={mate.id}
              className="rounded-full border border-ink-700 bg-ink-900 px-4 py-2 text-sm text-ink-200"
            >
              {mate.displayName}
            </li>
          ))}
        </ul>
      </div>

      <p className="mt-12 text-xs leading-relaxed text-ink-500">
        {GAME_STATUS_HINT[seat.sessionStatus]}
        <br />
        請看大螢幕。
      </p>
    </main>
  );
}
