"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getOrCreateDeviceToken } from "@/lib/device";
import { getPlayState, joinGame, listTeamPlayers } from "@/lib/game/api";
import { getServerClock } from "@/lib/game/clock";
import {
  inspectMotion,
  requestMotionPermission,
} from "@/lib/game/motion";
import { parseRescueConfig } from "@/lib/game/rescue";
import type { Sensitivity } from "@/lib/game/motion";
import { RowingAudio } from "@/lib/game/rowingAudio";
import { canVibrate } from "@/lib/game/haptics";
import { MotionRower } from "@/components/game/MotionRower";
import { QuizPlayer } from "@/components/quiz/QuizPlayer";
import type { MotionResult } from "@/components/game/MotionRower";
import { GAME_STATUS_HINT } from "@/lib/game/types";
import type { JoinedSeat, PlayState, TeamPlayer } from "@/lib/game/types";

/**
 * 玩家端（G0 入座 + G1 划槳）。
 *
 * 掃桌卡 → 輸入姓名 → 入座 → 等待開始 → 按住並划 → 看成績。
 *
 * 輪詢而不是 Realtime：Realtime 的連線數是稀缺資源，
 * 要留給大螢幕與主持人。而且回合一旦開始，手機就完全停止輪詢——
 * 起始時間是從 started_at 自己推算的，進行中不需要再問伺服器任何事，
 * 這也是這個架構能撐住整場人數的原因。
 */

const LOBBY_POLL_MS = 5000;
const STATE_POLL_MS = 2500;
const LAST_NAME_KEY = "iwd:last-name";

interface PlayerSeatProps {
  readonly joinCode: string;
}

interface ActiveRound {
  readonly roundNo: number;
  readonly startAtMs: number;
  readonly durationMs: number;
  /** 由主持人在後台設定，全場統一 */
  readonly sensitivity: Sensitivity;
}

export function PlayerSeat({ joinCode }: PlayerSeatProps) {
  const [seat, setSeat] = useState<JoinedSeat | null>(null);
  const [teammates, setTeammates] = useState<TeamPlayer[]>([]);
  const [playState, setPlayState] = useState<PlayState | null>(null);
  const [round, setRound] = useState<ActiveRound | null>(null);
  const [result, setResult] = useState<MotionResult | null>(null);
  const [motionReady, setMotionReady] = useState(false);
  // 同上：支不支援震動只有瀏覽器知道，不能在 render 當下決定文字
  const [vibrates, setVibrates] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const deviceTokenRef = useRef<string>("");
  // 同一個值也放一份在 state：問答的畫面要把它當成 prop 傳下去，
  // 而 render 期間不能讀 ref
  const [deviceToken, setDeviceToken] = useState("");
  const clockRef = useRef(getServerClock());
  const lastRoundRef = useRef<number>(-1);
  // 建構子不碰 AudioContext（那要等使用者手勢），可安全惰性建立
  const [audio] = useState(() => new RowingAudio());

  useEffect(() => {
    return () => {
      audio.dispose();
    };
  }, [audio]);

  const now = useCallback(() => clockRef.current.now(), []);

  // 帶入先前用過的姓名
  useEffect(() => {
    let cancelled = false;

    const restore = async () => {
      await Promise.resolve();
      if (cancelled) {
        return;
      }
      const token = getOrCreateDeviceToken();
      deviceTokenRef.current = token;
      setDeviceToken(token);
      setVibrates(canVibrate());
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

  /**
   * 要求動作感應權限。
   *
   * iOS 只在使用者手勢裡才會跳出授權視窗，而且被拒絕之後再問不會再跳。
   * 入座那一按是最合理的時機——之後玩家就只會盯著大螢幕，不會再點手機。
   */
  const enableMotion = useCallback(async () => {
    // 音訊也一樣只能在手勢裡啟動，一起處理
    await audio.enable();

    const availability = inspectMotion();
    if (availability === "unsupported" || availability === "insecure") {
      setMotionReady(false);
      return false;
    }
    const granted = await requestMotionPermission();
    setMotionReady(granted);
    return granted;
  }, [audio]);

  const submit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const trimmed = name.trim();
      if (trimmed === "") {
        return;
      }

      setBusy(true);
      setError(null);

      await enableMotion();

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
        void clockRef.current.sync().catch(() => undefined);
      } catch (joinError) {
        setError(
          joinError instanceof Error ? joinError.message : String(joinError),
        );
      } finally {
        setBusy(false);
      }
    },
    [enableMotion, joinCode, name],
  );

  // 大廳輪詢隊友。回合進行中停掉——手機此時不該再跟伺服器說話。
  useEffect(() => {
    if (!seat || round) {
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
  }, [seat, round]);

  // 回合狀態輪詢
  useEffect(() => {
    if (!seat || round) {
      return;
    }

    let cancelled = false;
    const poll = () => {
      if (document.visibilityState !== "visible") {
        return;
      }
      getPlayState(seat.sessionId)
        .then((state) => {
          if (!cancelled && state) {
            setPlayState(state);
          }
        })
        .catch(() => undefined);
    };

    poll();
    const timer = setInterval(poll, STATE_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [seat, round]);

  // 偵測到新回合就進入划槳畫面
  useEffect(() => {
    if (
      !playState ||
      playState.status !== "playing" ||
      playState.startedAtMs === null ||
      playState.roundNo === lastRoundRef.current
    ) {
      return;
    }

    const startAtMs = playState.startedAtMs;
    // 靈敏度與回合長度都跟著回合走，開始之後就固定，
    // 中途主持人再改也不會動到進行中的這一回合
    const { durationMs, sensitivity } = parseRescueConfig(playState.config);
    lastRoundRef.current = playState.roundNo;

    let cancelled = false;
    const begin = async () => {
      await Promise.resolve();
      if (cancelled) {
        return;
      }
      setResult(null);
      setRound({
        roundNo: playState.roundNo,
        startAtMs,
        durationMs,
        sensitivity,
      });
    };

    void begin();
    return () => {
      cancelled = true;
    };
  }, [playState]);

  const finishRound = useCallback((value: MotionResult) => {
    setResult(value);
    setRound(null);
  }, []);

  const statusHint = useMemo(
    () => GAME_STATUS_HINT[playState?.status ?? seat?.sessionStatus ?? "setup"],
    [playState, seat],
  );

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

  // 問答有自己的一整套畫面：明亮配色、題目文字、四個選項。
  // 入座之後就直接交給它，不再經過划船那條路。
  if (seat.gameKey === "quiz" && deviceToken !== "") {
    return (
      <QuizPlayer
        sessionId={seat.sessionId}
        deviceToken={deviceToken}
        teamName={seat.teamName}
        teamColor={seat.teamColor}
      />
    );
  }

  if (round) {
    return (
      <main>
        <MotionRower
          creatureKey={seat.teamCreature}
          color={seat.teamColor}
          startAtMs={round.startAtMs}
          durationMs={round.durationMs}
          now={now}
          sensitivity={round.sensitivity}
          audio={audio}
          onFinish={finishRound}
        />
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
        <p className="mt-3 text-xs leading-relaxed text-ink-400">
          iPhone 請關掉側邊的靜音鍵
          {vibrates ? "，划的時候會震動" : ""}
        </p>
      </div>

      {/* 上一回合的成績 */}
      {result ? (
        <div className="mt-8 rounded-2xl border border-ink-800 bg-ink-900/60 px-7 py-6">
          <p className="text-xs text-ink-400">上一回合</p>
          <p className="mt-3 text-4xl font-light text-signal-400 tabular-nums">
            {result.strokes}
            <span className="ml-2 text-lg text-ink-400">下</span>
          </p>
          <p className="mt-3 text-xs text-ink-500 tabular-nums">
            平均 {Math.round(result.averageSpm)} 下／分 ｜ 最快{" "}
            {Math.round(result.peakSpm)} ｜ 握住{" "}
            {Math.round(result.heldRatio * 100)}％
          </p>
        </div>
      ) : null}

      <div className="mt-10">
        <p className="text-xs text-ink-400">隊友 {teammates.length} 位</p>
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

      {!motionReady ? (
        <button
          type="button"
          onClick={() => void enableMotion()}
          className="mt-10 w-full rounded-lg border border-ink-700 py-3 text-sm text-ink-300 transition-colors duration-300 ease-world hover:bg-ink-800"
        >
          允許動作感應與音效（沒有這個就划不動）
        </button>
      ) : null}

      <p className="mt-12 text-xs leading-relaxed text-ink-500">
        {statusHint}
        <br />
        請看大螢幕。
      </p>
    </main>
  );
}
