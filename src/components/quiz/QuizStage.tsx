"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CreatureMark } from "@/components/quiz/CreatureMark";
import {
  getIndividualScores,
  getQuizStageState,
  getTeamScores,
} from "@/lib/quiz/api";
import { QUIZ_OPTIONS } from "@/lib/quiz/options";
import { timeline } from "@/lib/quiz/types";
import type {
  IndividualScore,
  QuizStageState,
  TeamScore,
} from "@/lib/quiz/types";
import { getServerClock } from "@/lib/game/clock";

/**
 * 問答的大螢幕（Q0）。
 *
 * 明亮配色：這一頁的內容是要讓兩三百人在三十公尺外讀完的文字。
 * 抽獎的深色世界在投影機上很美，但深底淺字投出來會糊、對比也不夠，
 * 而題目讀不完的話整個遊戲就不成立。
 *
 * 大螢幕是唯一一個「可以放心一直輪詢」的裝置——只有一台。
 * 因此這裡用兩秒一次的固定輪詢，把即時性留給它，
 * 手機那邊才有本錢盡量少打伺服器。
 */

const POLL_MS = 2000;

interface QuizStageProps {
  readonly sessionId: string;
}

export function QuizStage({ sessionId }: QuizStageProps) {
  const [state, setState] = useState<QuizStageState | null>(null);
  const [teams, setTeams] = useState<TeamScore[]>([]);
  const [players, setPlayers] = useState<IndividualScore[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [, setTick] = useState(0);

  const [clock] = useState(() => getServerClock());
  const modeRef = useRef<"individual" | "team">("team");

  useEffect(() => {
    void clock.sync().catch(() => undefined);
  }, [clock]);

  const refresh = useCallback(async () => {
    const next = await getQuizStageState(sessionId);
    if (!next) {
      return;
    }
    setState(next);
    setError(null);
    modeRef.current = next.mode;

    // 排行榜只在需要顯示時才查，平常沒必要一直算總分
    if (next.phase === "scoreboard" || next.phase === "reveal") {
      if (next.mode === "team") {
        setTeams(await getTeamScores(sessionId));
      } else {
        setPlayers(await getIndividualScores(sessionId, 10));
      }
    }
  }, [sessionId]);

  useEffect(() => {
    let cancelled = false;
    const timer = setInterval(() => {
      if (!cancelled) {
        refresh().catch((e: unknown) => {
          setError(e instanceof Error ? e.message : String(e));
        });
      }
    }, POLL_MS);

    // 第一次也走非同步，避免在 effect 內同步觸發狀態更新
    const first = setTimeout(() => {
      refresh().catch((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e));
      });
    }, 0);

    return () => {
      cancelled = true;
      clearInterval(timer);
      clearTimeout(first);
    };
  }, [refresh]);

  // 秒數要走，畫面就得定期重繪
  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), 250);
    return () => clearInterval(timer);
  }, []);

  const phase = timeline(
    clock.now(),
    state?.startedAtMs ?? null,
    state?.prepSeconds ?? 5,
    state?.answerSeconds ?? 20,
  );

  const revealed = state?.phase === "reveal" || state?.phase === "scoreboard";

  return (
    <main className="relative min-h-dvh overflow-hidden bg-sea-50 text-sea-900">
      <SeaBackdrop />

      <div className="relative flex min-h-dvh flex-col px-[4vw] py-[3vh]">
        {error ? (
          <p className="rounded-lg bg-white/80 px-4 py-2 text-sm text-[#c2410c]">
            {error}
          </p>
        ) : null}

        {!state || state.phase === "idle" || !state.questionId ? (
          <Standby name={state?.sessionName ?? ""} />
        ) : state.phase === "scoreboard" ? (
          <Scoreboard
            mode={state.mode}
            teams={teams}
            players={players}
            questionNo={state.questionNo}
            questionTotal={state.questionTotal}
          />
        ) : (
          <>
            <header className="flex items-baseline justify-between">
              <span className="text-[1.6vw] tracking-widest text-sea-500">
                第 {state.questionNo} 題 ／ 共 {state.questionTotal} 題
              </span>
              <span className="text-[1.6vw] text-sea-500">
                已作答 {state.answeredCount} ／ {state.playerCount}
              </span>
            </header>

            {/* 有配圖時題目縮小讓位。圖片是題目的一部分，看不清楚就等於沒出題 */}
            <div className="mt-[3vh] flex items-center gap-[3vw]">
              {state.imageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={state.imageUrl}
                  alt=""
                  className="max-h-[26vh] w-auto rounded-[1.2vw] object-contain shadow-xl"
                />
              ) : null}
              <h1
                className={`flex-1 leading-tight font-semibold text-sea-900 ${
                  state.imageUrl ? "text-[3.2vw]" : "text-[4.2vw]"
                }`}
              >
                {state.prompt}
              </h1>
            </div>

            <div className="mt-[3vh]">
              <StageTimer
                stage={phase.stage}
                secondsLeft={phase.secondsLeft}
                progress={phase.progress}
                revealed={revealed}
              />
            </div>

            <div className="mt-[3vh] grid flex-1 grid-cols-2 gap-[2vw] pb-[2vh]">
              {QUIZ_OPTIONS.map((option, index) => {
                const isCorrect = revealed && state.correctIndex === index;
                const dimmed = revealed && !isCorrect;
                const count = state.optionCounts?.[index];

                return (
                  <div
                    key={option.creatureKey}
                    className={[
                      "flex items-center gap-[2vw] rounded-[1.6vw] px-[2.4vw] py-[2vh] transition-all duration-500",
                      isCorrect
                        ? "scale-[1.02] shadow-2xl ring-[0.5vw]"
                        : dimmed
                          ? "opacity-35 grayscale"
                          : "shadow-lg",
                    ].join(" ")}
                    style={{
                      backgroundColor: option.surface,
                      color: option.color,
                    }}
                  >
                    <CreatureMark
                      creatureKey={option.creatureKey}
                      size={92}
                      color={option.color}
                    />
                    <span className="flex-1 text-[2.6vw] leading-tight font-medium text-sea-900">
                      {state.options?.[index]}
                    </span>
                    {revealed && count !== undefined ? (
                      <span className="text-[2vw] font-semibold tabular-nums">
                        {count}
                      </span>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    </main>
  );
}

/** 淺色的海：兩層緩慢移動的波，讓靜止畫面不會死板 */
function SeaBackdrop() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0">
      <div className="absolute inset-0 bg-gradient-to-b from-sea-100 via-sea-50 to-sea-200" />
      <svg
        className="absolute inset-x-0 bottom-0 h-[28vh] w-full"
        viewBox="0 0 1440 320"
        preserveAspectRatio="none"
      >
        <path
          fill="var(--color-sea-200)"
          fillOpacity="0.7"
          d="M0,192L60,181.3C120,171,240,149,360,160C480,171,600,213,720,213.3C840,213,960,171,1080,160C1200,149,1320,171,1380,181.3L1440,192L1440,320L0,320Z"
        />
        <path
          fill="var(--color-sea-300)"
          fillOpacity="0.55"
          d="M0,256L60,245.3C120,235,240,213,360,218.7C480,224,600,256,720,261.3C840,267,960,245,1080,234.7C1200,224,1320,224,1380,224L1440,224L1440,320L0,320Z"
        />
      </svg>
    </div>
  );
}

function Standby({ name }: { readonly name: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center text-center">
      <div className="flex gap-[3vw]">
        {QUIZ_OPTIONS.map((option) => (
          <div
            key={option.creatureKey}
            className="flex flex-col items-center gap-[1vh] rounded-[1.4vw] px-[2vw] py-[2vh] shadow-lg"
            style={{ backgroundColor: option.surface }}
          >
            <CreatureMark creatureKey={option.creatureKey} size={96} color={option.color} />
            <span className="text-[1.4vw] text-sea-700">{option.name}</span>
          </div>
        ))}
      </div>
      <h1 className="mt-[6vh] text-[4vw] font-semibold text-sea-800">
        {name || "海洋問答"}
      </h1>
      <p className="mt-[2vh] text-[1.8vw] text-sea-600">
        每一題都是這四隻海洋生物，位置固定不會變
      </p>
    </div>
  );
}

interface StageTimerProps {
  readonly stage: "prep" | "answer" | "closed";
  readonly secondsLeft: number;
  readonly progress: number;
  readonly revealed: boolean;
}

function StageTimer({
  stage,
  secondsLeft,
  progress,
  revealed,
}: StageTimerProps) {
  if (revealed) {
    return (
      <p className="text-[2vw] font-medium text-sea-700">正確答案</p>
    );
  }

  const label = stage === "prep" ? "準備" : stage === "answer" ? "作答" : "時間到";

  return (
    <div className="flex items-center gap-[2vw]">
      <span className="text-[1.6vw] text-sea-600">{label}</span>
      <span className="text-[4vw] leading-none font-semibold text-sea-800 tabular-nums">
        {secondsLeft}
      </span>
      <div className="h-[1.4vh] flex-1 overflow-hidden rounded-full bg-sea-200">
        <div
          className={
            stage === "prep"
              ? "h-full rounded-full bg-sea-400 transition-[width] duration-200 ease-linear"
              : "h-full rounded-full bg-sea-600 transition-[width] duration-200 ease-linear"
          }
          style={{
            width: `${Math.round((1 - Math.min(Math.max(progress, 0), 1)) * 100)}%`,
          }}
        />
      </div>
    </div>
  );
}

interface ScoreboardProps {
  readonly mode: "individual" | "team";
  readonly teams: readonly TeamScore[];
  readonly players: readonly IndividualScore[];
  readonly questionNo: number | null;
  readonly questionTotal: number;
}

function Scoreboard({
  mode,
  teams,
  players,
  questionNo,
  questionTotal,
}: ScoreboardProps) {
  // 只顯示有分數的，一整排零分的桌子佔掉版面又沒有資訊
  const rows =
    mode === "team"
      ? teams.filter((t) => t.playerCount > 0).slice(0, 10)
      : players.slice(0, 10);
  const top = rows[0];
  const best =
    top && "totalPoints" in top ? Math.max(top.totalPoints, 1) : 1;

  return (
    <div className="flex flex-1 flex-col">
      <header className="flex items-baseline justify-between">
        <h1 className="text-[3.2vw] font-semibold text-sea-800">
          {mode === "team" ? "各桌積分" : "個人排行"}
        </h1>
        <span className="text-[1.6vw] text-sea-500">
          第 {questionNo} 題 ／ 共 {questionTotal} 題
        </span>
      </header>

      <ol className="mt-[3vh] flex flex-1 flex-col justify-start gap-[1.2vh]">
        {rows.map((row, index) => {
          const isTeam = "teamId" in row;
          const points = row.totalPoints;
          const color = isTeam ? row.color : row.teamColor;
          const label = isTeam ? row.name : row.displayName;
          const sub = isTeam
            ? `${row.playerCount} 人 ｜ 答對 ${row.correctCount}`
            : `${row.teamName} ｜ 答對 ${row.correctCount}`;

          return (
            <li
              key={isTeam ? row.teamId : row.playerId}
              className="relative flex items-center gap-[1.5vw] overflow-hidden rounded-[1vw] bg-white/80 px-[1.6vw] py-[1.4vh] shadow"
            >
              {/* 分數條畫在背景，一眼看得出差距 */}
              <div
                className="absolute inset-y-0 left-0 transition-[width] duration-700 ease-out"
                style={{
                  width: `${Math.round((points / best) * 100)}%`,
                  backgroundColor: `${color}22`,
                }}
              />
              <span className="relative w-[3vw] text-[2vw] font-semibold text-sea-500 tabular-nums">
                {index + 1}
              </span>
              {/* 分組賽就畫出那一隊的海洋生物：大螢幕上大家認的是生物不是色塊 */}
              {isTeam ? (
                <span className="relative shrink-0">
                  <CreatureMark
                    creatureKey={row.creatureKey}
                    size={44}
                    color={color}
                  />
                </span>
              ) : (
                <span
                  className="relative size-[1.4vw] shrink-0 rounded-full"
                  style={{ backgroundColor: color }}
                />
              )}
              <span className="relative flex-1 text-[2.2vw] font-medium text-sea-900">
                {label}
              </span>
              <span className="relative text-[1.4vw] text-sea-500">{sub}</span>
              <span className="relative text-[2.4vw] font-semibold text-sea-800 tabular-nums">
                {points}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
