"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CreatureMark } from "@/components/quiz/CreatureMark";
import { LobbyBoard } from "@/components/quiz/LobbyBoard";
import { subscribeQuizSession } from "@/lib/quiz/realtime";
import {
  getIndividualScores,
  getQuizStageState,
  getSessionTheme,
  getTeamScores,
} from "@/lib/quiz/api";
import { paletteVars, quizTheme } from "@/lib/quiz/themes";
import type { QuizTheme } from "@/lib/quiz/themes";

import { timeline } from "@/lib/quiz/types";
import type {
  IndividualScore,
  QuizMode,
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

/**
 * 輪詢只是保險。
 *
 * 換題與跳階段靠 Realtime 推過來，這個間隔是為了 WebSocket 斷掉時
 * 還能繼續跑——投影機那台電腦的 Wi-Fi 也會斷。大螢幕只有一台，
 * 問得勤一點沒有負擔，所以保險的間隔留在兩秒。
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
  const [theme, setTheme] = useState<QuizTheme>(() => quizTheme(null));

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const found = await getSessionTheme(sessionId).catch(() => null);
      if (!cancelled && found) {
        setTheme(found);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [sessionId]);
  const modeRef = useRef<QuizMode>("team");

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
      if (next.mode === "individual") {
        setPlayers(await getIndividualScores(sessionId, 10));
      } else {
        setTeams(await getTeamScores(sessionId));
      }
    }
  }, [sessionId]);

  /*
    主持人一按，大螢幕就要動（C23）。

    輪詢最慢會慢兩秒——現場那兩秒非常明顯：主持人說「看題目」，
    牆上還停在上一頁。資料庫那端本來就在廣播了
    （start_quiz_question／jump_quiz_phase 都有 realtime.send），
    這裡接上去就是一次網路來回。

    廣播只說「有事發生了」，內容照樣自己拉一次——這樣不必擔心
    廣播漏掉或順序顛倒，也不會有人從廣播裡讀到還不該看見的正解。
  */
  useEffect(() => {
    return subscribeQuizSession(sessionId, {
      onChanged: () => {
        refresh().catch(() => undefined);
      },
      // 斷線重連時中間漏掉的都要補回來
      onSubscribed: () => {
        refresh().catch(() => undefined);
      },
    });
  }, [sessionId, refresh]);

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
    <main
      style={paletteVars(theme.palette)}
      className="relative min-h-dvh overflow-hidden bg-[var(--q-bg)] text-[var(--q-text)]"
    >
      <WaterBackdrop />

      <div className="relative flex min-h-dvh flex-col px-[4vw] py-[3vh]">
        {error ? (
          <p className="rounded-lg bg-white/80 px-4 py-2 text-sm text-[#c2410c]">
            {error}
          </p>
        ) : null}

        {!state || state.phase === "idle" || !state.questionId ? (
          <Standby
            theme={theme}
            name={state?.sessionName ?? ""}
            sessionId={sessionId}
          />
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
              <span className="text-[1.6vw] tracking-widest text-[var(--q-bg)]0">
                第 {state.questionNo} 題 ／ 共 {state.questionTotal} 題
              </span>
              <span className="text-[1.6vw] text-[var(--q-bg)]0">
                {state.mode === "captain" ? "已作答桌數" : "已作答"}{" "}
                {state.answeredCount} ／ {state.playerCount}
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
                className={`flex-1 leading-tight font-semibold text-[var(--q-text)] ${
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

            {/* 讀題時間只放題目與倒數。選項一起出現會讓人邊讀邊猜，
                讀題的意義就沒了；等倒數歸零選項一次亮出來也更有戲。 */}
            {state.phase === "prep" ? (
              <div className="flex flex-1 flex-col items-center justify-center">
                <span className="text-[16vw] leading-none font-semibold text-[var(--q-accent)] tabular-nums">
                  {phase.secondsLeft}
                </span>
                <span className="mt-[2vh] text-[2vw] text-[var(--q-text-soft)]">
                  看清楚題目，倒數結束就可以按手機
                </span>
              </div>
            ) : (
            <div className="mt-[3vh] grid flex-1 grid-cols-2 gap-[2vw] pb-[2vh]">
              {theme.options.map((option, index) => {
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
                    <span className="flex-1 text-[2.6vw] leading-tight font-medium text-[var(--q-text)]">
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
            )}
          </>
        )}
      </div>
    </main>
  );
}

/** 水面：兩層波紋，顏色由主題決定，讓靜止畫面不會死板 */
function WaterBackdrop() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0">
      <div className="absolute inset-0 bg-gradient-to-b from-[var(--q-surface)] via-[var(--q-bg)] to-[var(--q-wave-top)]" />
      <svg
        className="absolute inset-x-0 bottom-0 h-[28vh] w-full"
        viewBox="0 0 1440 320"
        preserveAspectRatio="none"
      >
        <path
          fill="var(--q-wave-top)"
          fillOpacity="0.7"
          d="M0,192L60,181.3C120,171,240,149,360,160C480,171,600,213,720,213.3C840,213,960,171,1080,160C1200,149,1320,171,1380,181.3L1440,192L1440,320L0,320Z"
        />
        <path
          fill="var(--q-wave-bottom)"
          fillOpacity="0.55"
          d="M0,256L60,245.3C120,235,240,213,360,218.7C480,224,600,256,720,261.3C840,267,960,245,1080,234.7C1200,224,1320,224,1380,224L1440,224L1440,320L0,320Z"
        />
      </svg>
    </div>
  );
}

/**
 * 開場等待畫面。
 *
 * 這一段在現場會停留最久——大家陸續進場、找位子、掃桌卡。
 * 原本只放四個圖案與場次名稱，主持人得自己走下去問每一桌好了沒；
 * 現在把入座看板放在中間，缺哪幾桌直接寫在螢幕上。
 *
 * 四個圖案往下縮成一排：它教的是「等一下答題就按這四個」，
 * 重要，但沒有「第 7 桌還沒進來」重要。
 */
function Standby({
  theme,
  name,
  sessionId,
}: {
  readonly theme: QuizTheme;
  readonly name: string;
  readonly sessionId: string;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center">
      <h1 className="text-[2.8vw] font-semibold text-[var(--q-text)]">
        {name || theme.defaultSessionName}
      </h1>

      <div className="mt-[2.2vh] w-full">
        <LobbyBoard sessionId={sessionId} />
      </div>

      <div className="mt-[2.6vh] flex items-center gap-[2vw]">
        {theme.options.map((option) => (
          <div
            key={option.creatureKey}
            className="flex items-center gap-[0.7vw] rounded-[0.9vw] px-[1.2vw] py-[1vh] shadow"
            style={{ backgroundColor: option.surface }}
          >
            <CreatureMark
              creatureKey={option.creatureKey}
              size={44}
              color={option.color}
            />
            <span className="text-[1.1vw] text-[var(--q-text-soft)]">
              {option.name}
            </span>
          </div>
        ))}
      </div>
      <p className="mt-[1.2vh] text-[1.3vw] text-[var(--q-text-soft)]">
        每一題都是這四個圖案，位置固定不會變
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
      <p className="text-[2vw] font-medium text-[var(--q-text-soft)]">正確答案</p>
    );
  }

  const label = stage === "prep" ? "讀題" : stage === "answer" ? "作答" : "時間到";

  return (
    <div className="flex items-center gap-[2vw]">
      <span className="text-[1.6vw] text-[var(--q-text-soft)]">{label}</span>
      {/* 讀題階段中間已經有一個大倒數，這裡就不重複 */}
      {stage === "prep" ? null : (
        <span className="text-[4vw] leading-none font-semibold text-[var(--q-text)] tabular-nums">
          {secondsLeft}
        </span>
      )}
      <div className="h-[1.4vh] flex-1 overflow-hidden rounded-full bg-[var(--q-line)]">
        <div
          className={
            stage === "prep"
              ? "h-full rounded-full bg-[var(--q-accent)] transition-[width] duration-200 ease-linear"
              : "h-full rounded-full bg-[var(--q-text-soft)] transition-[width] duration-200 ease-linear"
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
  readonly mode: QuizMode;
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
  // 隊長代表賽也是看各桌——隊長的分數就是全桌的分數
  const rows =
    mode === "individual"
      ? players.slice(0, 10)
      : teams.filter((t) => t.playerCount > 0).slice(0, 10);
  const top = rows[0];
  const best =
    top && "totalPoints" in top ? Math.max(top.totalPoints, 1) : 1;

  return (
    <div className="flex flex-1 flex-col">
      <header className="flex items-baseline justify-between">
        <h1 className="text-[3.2vw] font-semibold text-[var(--q-text)]">
          {mode === "individual" ? "個人排行" : "各桌積分"}
        </h1>
        <span className="text-[1.6vw] text-[var(--q-bg)]0">
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
              <span className="relative w-[3vw] text-[2vw] font-semibold text-[var(--q-bg)]0 tabular-nums">
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
              <span className="relative flex-1 text-[2.2vw] font-medium text-[var(--q-text)]">
                {label}
              </span>
              <span className="relative text-[1.4vw] text-[var(--q-bg)]0">{sub}</span>
              <span className="relative text-[2.4vw] font-semibold text-[var(--q-text)] tabular-nums">
                {points}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
