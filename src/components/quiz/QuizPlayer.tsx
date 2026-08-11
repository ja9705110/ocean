"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CreatureMark } from "@/components/quiz/CreatureMark";
import {
  claimCaptain,
  getQuizPlayState,
  getSessionTheme,
  submitQuizAnswer,
} from "@/lib/quiz/api";
import { paletteVars, quizTheme } from "@/lib/quiz/themes";
import type { QuizTheme } from "@/lib/quiz/themes";

import { ANSWER_GRACE_MS, timeline } from "@/lib/quiz/types";
import type { QuizMode, QuizPlayState } from "@/lib/quiz/types";
import { getServerClock } from "@/lib/game/clock";
import { hapticCountdown, hapticStroke } from "@/lib/game/haptics";

/**
 * 問答的手機端（Q0）。
 *
 * 題目與選項文字手機上也有。Kahoot 的原版刻意只給顏色形狀、逼人抬頭，
 * 但現場會有長輩、坐後排、視力不好的人——把他們排除在遊戲外，
 * 省下的那點「儀式感」完全不值得。
 *
 * 輪詢節奏是刻意設計的：階段轉換（讀題→作答→時間到）手機自己從
 * started_at 推算，不必問伺服器。真正需要問的只有「換題了沒」與
 * 「公布了沒」，因此作答視窗中間那段完全不打伺服器——
 * 那正是三百支手機同時最忙的時候。
 */

/** 待機與公布後的輪詢間隔 */
const IDLE_POLL_MS = 2500;
/** 作答視窗結束後，等公布答案的輪詢間隔 */
const WAIT_POLL_MS = 1500;

interface QuizPlayerProps {
  readonly sessionId: string;
  readonly deviceToken: string;
  readonly teamName: string;
  readonly teamColor: string;
}

export function QuizPlayer({
  sessionId,
  deviceToken,
  teamName,
  teamColor,
}: QuizPlayerProps) {
  const [state, setState] = useState<QuizPlayState | null>(null);
  const [pending, setPending] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [claiming, setClaiming] = useState(false);
  const [tick, setTick] = useState(0);

  // 全站共用的對時時鐘。用 useState 惰性取得而不是 useRef，
  // 是因為算剩餘秒數要在 render 裡讀它。
  const [clock] = useState(() => getServerClock());
  // 主題在一場遊戲中不會變，掛載時查一次就好
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
  const lastCountdownRef = useRef(-1);

  useEffect(() => {
    void clock.sync().catch(() => undefined);
  }, [clock]);

  const refresh = useCallback(async () => {
    const next = await getQuizPlayState(sessionId, deviceToken);
    if (next) {
      setState(next);
    }
  }, [sessionId, deviceToken]);

  // 換題就清掉本機的暫存選擇
  const questionId = state?.questionId ?? null;
  useEffect(() => {
    let cancelled = false;
    const reset = async () => {
      await Promise.resolve();
      if (!cancelled) {
        setPending(null);
        setError(null);
      }
    };
    void reset();
    return () => {
      cancelled = true;
    };
  }, [questionId]);

  // 畫面每秒重算一次剩餘時間；階段轉換不需要問伺服器
  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), 250);
    return () => clearInterval(timer);
  }, []);

  // 最新狀態放進 ref 給輪詢迴圈讀。
  // 若把 state 放進下面那個 effect 的相依陣列，每收到一次回應就會重建
  // 迴圈並立刻再打一次，變成無限迴圈。
  const stateRef = useRef<QuizPlayState | null>(null);
  useEffect(() => {
    stateRef.current = state;
  });

  // 輪詢：作答視窗進行中完全不打伺服器
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const loop = (delay: number) => {
      timer = setTimeout(() => {
        if (cancelled) {
          return;
        }
        if (document.visibilityState === "visible") {
          void refresh().catch(() => undefined);
        }
        loop(nextPollDelay(stateRef.current, clock.now()));
      }, delay);
    };

    // 第一次也走同一條路，避免在 effect 內同步觸發狀態更新
    loop(0);
    return () => {
      cancelled = true;
      if (timer !== null) {
        clearTimeout(timer);
      }
    };
  }, [refresh, clock]);

  const answered = state?.myChoice ?? pending;
  const phase = timeline(
    clock.now(),
    state?.startedAtMs ?? null,
    state?.prepSeconds ?? 5,
    state?.answerSeconds ?? 20,
  );

  // 讀題倒數的最後三秒給一下震動，低頭的人也知道要準備了
  useEffect(() => {
    if (phase.stage === "prep" && phase.secondsLeft <= 3 && phase.secondsLeft > 0) {
      if (lastCountdownRef.current !== phase.secondsLeft) {
        lastCountdownRef.current = phase.secondsLeft;
        hapticCountdown(false);
      }
    }
  }, [phase.stage, phase.secondsLeft]);

  const claim = useCallback(async () => {
    setClaiming(true);
    setError(null);
    try {
      await claimCaptain(sessionId, deviceToken);
      await refresh();
    } catch (claimError) {
      setError(
        claimError instanceof Error ? claimError.message : String(claimError),
      );
    } finally {
      setClaiming(false);
    }
  }, [sessionId, deviceToken, refresh]);

  const choose = useCallback(
    async (index: number) => {
      if (!state?.questionId || answered !== null) {
        return;
      }
      setPending(index);
      setError(null);
      hapticStroke(1);
      try {
        await submitQuizAnswer(state.questionId, deviceToken, index);
      } catch (submitError) {
        setPending(null);
        setError(
          submitError instanceof Error
            ? submitError.message
            : String(submitError),
        );
      }
    },
    [state, answered, deviceToken],
  );

  // 隊長代表賽時只有隊長按得動。伺服器端也會擋，這裡只是不要給錯的期待。
  const mayAnswer = state?.mode !== "captain" || state.iAmCaptain;
  const open = phase.stage === "answer" && state?.phase !== "reveal" && mayAnswer;
  const revealed = state?.phase === "reveal" || state?.phase === "scoreboard";
  void tick;

  return (
    <main
      style={paletteVars(theme.palette)}
      className="flex min-h-dvh flex-col bg-[var(--q-bg)] text-[var(--q-text)]"
    >
      {/* 抬頭：隊伍與累計分數 */}
      <header className="flex items-center justify-between px-5 pt-5 text-sm">
        <span className="flex items-center gap-2">
          <span
            className="size-2.5 rounded-full"
            style={{ backgroundColor: teamColor }}
          />
          {teamName}
        </span>
        <span className="tabular-nums text-[var(--q-text-soft)]">
          {state?.myTotal ?? 0} 分
        </span>
      </header>

      {state === null || state.phase === "idle" || !state.questionId ? (
        <Waiting
          theme={theme}
          mode={state?.mode ?? "captain"}
          iAmCaptain={state?.iAmCaptain ?? false}
          captainName={state?.captainName ?? null}
          claiming={claiming}
          onClaim={() => void claim()}
        />
      ) : (
        <>
          <section className="px-5 pt-6">
            <p className="text-xs tracking-widest text-[var(--q-bg)]0">
              第 {state.questionNo} 題 ／ 共 {state.questionTotal} 題
            </p>
            {/* 題目字級刻意放大：現場一定有人看不清楚大螢幕 */}
            <h1 className="mt-3 text-2xl leading-snug font-medium text-[var(--q-text)]">
              {state.prompt}
            </h1>
            {state.imageUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={state.imageUrl}
                alt=""
                className="mt-4 max-h-[22vh] w-full rounded-xl object-contain"
              />
            ) : null}
          </section>

          <div className="px-5 pt-5">
            <TimerBar
              stage={phase.stage}
              secondsLeft={phase.secondsLeft}
              progress={phase.progress}
              answered={answered !== null}
            />
          </div>

          {error ? (
            <p className="px-5 pt-4 text-sm text-[#c2410c]">{error}</p>
          ) : null}

          {/* 隊長代表賽：不是隊長的人看得到題目與大家的選擇，但不能按 */}
          {state.mode === "captain" && !state.iAmCaptain ? (
            <div className="mx-5 mt-4 rounded-xl bg-[var(--q-surface)] px-4 py-3 text-sm text-[var(--q-text-soft)]">
              {state.captainName
                ? `這一桌由 ${state.captainName} 代表作答，一起討論給答案`
                : "這一桌還沒有隊長"}
            </div>
          ) : null}

          <div className="grid flex-1 grid-cols-2 gap-3 p-4">
            {theme.options.map((option, index) => {
              const text = state.options?.[index] ?? "";
              const chosen = answered === index;
              const isCorrect = revealed && state.correctIndex === index;
              const isWrong = revealed && chosen && !isCorrect;

              return (
                <button
                  key={option.creatureKey}
                  type="button"
                  disabled={!open || answered !== null}
                  onClick={() => void choose(index)}
                  className={[
                    "flex flex-col items-center justify-center gap-2 rounded-2xl border-2 p-3 text-center transition-all duration-200",
                    // 公布之後：正確的放大、選錯的變灰，其餘淡出
                    isCorrect
                      ? "scale-[1.03] border-current shadow-lg"
                      : isWrong
                        ? "border-transparent opacity-40 grayscale"
                        : revealed
                          ? "border-transparent opacity-30 grayscale"
                          : chosen
                            ? "scale-[1.03] border-current shadow-lg"
                            : open
                              ? "border-transparent active:scale-95"
                              : "border-transparent opacity-45",
                  ].join(" ")}
                  style={{
                    color: option.color,
                    backgroundColor: option.surface,
                  }}
                >
                  <CreatureMark
                    creatureKey={option.creatureKey}
                    size={64}
                    color={option.color}
                  />
                  <span className="text-base leading-tight font-medium text-[var(--q-text)]">
                    {text}
                  </span>
                  {isCorrect ? (
                    <span className="text-xs font-medium">正確答案</span>
                  ) : null}
                </button>
              );
            })}
          </div>

          <footer className="px-5 pb-6 text-center text-sm">
            {revealed ? (
              <RevealNote
                myPoints={state.myPoints}
                answered={answered !== null}
                correct={answered === state.correctIndex}
              />
            ) : answered !== null ? (
              <span className="text-[var(--q-text-soft)]">
                已送出「{state.options?.[answered]}」，等大家答完
              </span>
            ) : state.mode === "captain" && !state.iAmCaptain ? (
              <span className="text-[var(--q-bg)]0">等隊長按下答案</span>
            ) : open ? (
              <span className="text-[var(--q-text-soft)]">
                選一個 —— 越快答對分數越高
              </span>
            ) : phase.stage === "prep" ? (
              <span className="text-[var(--q-text-soft)]">先看題目，時間到才能按</span>
            ) : (
              <span className="text-[var(--q-bg)]0">時間到了</span>
            )}
          </footer>
        </>
      )}
    </main>
  );
}

interface WaitingProps {
  readonly theme: QuizTheme;
  readonly mode: QuizMode;
  readonly iAmCaptain: boolean;
  readonly captainName: string | null;
  readonly claiming: boolean;
  readonly onClaim: () => void;
}

function Waiting({
  theme,
  mode,
  iAmCaptain,
  captainName,
  claiming,
  onClaim,
}: WaitingProps) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-8 text-center">
      <div className="flex gap-3">
        {theme.options.map((option) => (
          <CreatureMark
            key={option.creatureKey}
            creatureKey={option.creatureKey}
            size={44}
            color={option.color}
          />
        ))}
      </div>
      <p className="mt-8 text-lg text-[var(--q-text)]">等主持人出題</p>
      <p className="mt-3 text-sm leading-relaxed text-[var(--q-text-soft)]">
        題目會同時出現在大螢幕和這裡。
        <br />
        每一題都是這四個圖案，位置固定不會變。
      </p>

      {/* 隊長要在開始前推派好，題目出來才搶就來不及了 */}
      {mode === "captain" ? (
        <div className="mt-8 w-full max-w-xs">
          {iAmCaptain ? (
            <p className="rounded-xl bg-[var(--q-surface)] px-4 py-3 text-sm text-[var(--q-text-soft)]">
              你是這一桌的隊長，等一下由你按答案
            </p>
          ) : captainName ? (
            <p className="rounded-xl bg-[var(--q-surface)] px-4 py-3 text-sm text-[var(--q-text-soft)]">
              這一桌由 {captainName} 代表作答
            </p>
          ) : (
            <>
              <button
                type="button"
                disabled={claiming}
                onClick={onClaim}
                className="w-full rounded-xl bg-[var(--q-text-soft)] py-3.5 text-base font-medium text-white disabled:opacity-40"
              >
                {claiming ? "推派中" : "我當這桌的隊長"}
              </button>
              <p className="mt-3 text-xs leading-relaxed text-[var(--q-bg)]0">
                這一場由每桌一位隊長代表按答案。
                <br />
                先按的人就是隊長，桌上先講好再按。
              </p>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

interface TimerBarProps {
  readonly stage: "prep" | "answer" | "closed";
  readonly secondsLeft: number;
  readonly progress: number;
  readonly answered: boolean;
}

function TimerBar({ stage, secondsLeft, progress, answered }: TimerBarProps) {
  const label =
    stage === "prep"
      ? `${secondsLeft} 秒後開放作答`
      : stage === "answer"
        ? answered
          ? "已作答"
          : `剩 ${secondsLeft} 秒`
        : "時間到";

  return (
    <div>
      <div className="flex items-baseline justify-between text-sm text-[var(--q-text-soft)]">
        <span>{label}</span>
        {stage === "answer" && !answered ? (
          <span className="text-2xl font-medium text-[var(--q-text-soft)] tabular-nums">
            {secondsLeft}
          </span>
        ) : null}
      </div>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-[var(--q-line)]">
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

function RevealNote({
  myPoints,
  answered,
  correct,
}: {
  readonly myPoints: number | null;
  readonly answered: boolean;
  readonly correct: boolean;
}) {
  if (!answered) {
    return <span className="text-[var(--q-bg)]0">這題沒有作答</span>;
  }
  if (correct) {
    return (
      <span className="font-medium text-[#1f9d5c]">
        答對了，這題 +{myPoints ?? 0} 分
      </span>
    );
  }
  return <span className="text-[var(--q-bg)]0">這題答錯了，下一題追回來</span>;
}

/**
 * 下一次該隔多久問伺服器。
 *
 * 作答視窗進行中不必問——階段自己算得出來，題目也不會換。
 * 那段時間正是全場手機最忙的時候，省下的是最貴的那幾秒。
 */
function nextPollDelay(
  state: QuizPlayState | null,
  nowMs: number,
): number {
  if (!state || state.startedAtMs === null || !state.questionId) {
    return IDLE_POLL_MS;
  }

  const at = timeline(
    nowMs,
    state.startedAtMs,
    state.prepSeconds,
    state.answerSeconds,
  );

  if (at.stage === "answer") {
    // 睡到作答結束、再加上寬限期才醒來，中間完全不打伺服器。
    // 那正是全場手機最忙的時候，也是最不需要問伺服器的時候。
    return Math.max(600, at.secondsLeft * 1000 + ANSWER_GRACE_MS);
  }
  if (at.stage === "prep") {
    return Math.max(600, at.secondsLeft * 1000);
  }
  // 作答結束了。公布是自動的，這段要問得勤一點，不然正解會慢半拍才出現
  return state.phase === "reveal" || state.phase === "scoreboard"
    ? IDLE_POLL_MS
    : WAIT_POLL_MS;
}
