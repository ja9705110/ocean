"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { RowingDetector, strokeDistanceFor } from "@/lib/game/rowing";
import type { GripState } from "@/lib/game/rowing";
import {
  EMPTY_TALLY,
  JUDGEMENT_LABEL,
  RhythmScorer,
  beatPhase,
  beatTimeMs,
} from "@/lib/game/rhythm";
import type { RhythmConfig, RhythmTally, StrokeResult } from "@/lib/game/rhythm";

/**
 * 划槳控制器（G1）。
 *
 * 畫面分成兩半：上半是節拍，下半是兩塊拇指區。
 * 兩塊拇指區佔掉整個下半部不是為了好看——那是握持的位置，
 * 拇指壓在那裡時手掌自然包住機身，手機才不會在划的時候飛出去。
 *
 * 每秒 60 次的動畫（節拍環、拉槳進度）直接寫 DOM style，不走 React state。
 * 把這些丟進 state 會讓整棵樹每幀重繪一次，中階手機撐不住，
 * 而畫面卡頓在節奏遊戲裡等同於判定不準。
 */

interface RowingPadsProps {
  /** 第 0 拍的伺服器時刻 */
  readonly anchorMs: number;
  readonly rhythm: RhythmConfig;
  /** 伺服器時間軸上的現在 */
  readonly now: () => number;
  readonly onStroke?: (result: StrokeResult) => void;
  readonly onFinish?: (tally: RhythmTally) => void;
}

interface Feedback {
  readonly label: string;
  readonly tone: "perfect" | "good" | "miss";
  readonly detail: string;
  readonly seq: number;
}

const GRIP_HINT: Record<GripState, string> = {
  released: "兩隻拇指分別壓住下面兩塊",
  "one-hand": "另一隻拇指也要放上來",
  held: "",
};

function vibrate(pattern: number | number[]): void {
  if (typeof navigator !== "undefined" && "vibrate" in navigator) {
    try {
      navigator.vibrate(pattern);
    } catch {
      // 部分瀏覽器在非使用者手勢中會拒絕，忽略即可
    }
  }
}

export function RowingPads({
  anchorMs,
  rhythm,
  now,
  onStroke,
  onFinish,
}: RowingPadsProps) {
  // 偵測器與畫面無關，只是需要跨重繪存活；建構子不碰瀏覽器 API，可安全惰性建立
  const [detector] = useState(() => new RowingDetector({ strokeDistance: 90 }));
  const scorerRef = useRef<RhythmScorer | null>(null);
  const padAreaRef = useRef<HTMLDivElement | null>(null);
  const ringRef = useRef<HTMLDivElement | null>(null);
  const leftFillRef = useRef<HTMLDivElement | null>(null);
  const rightFillRef = useRef<HTMLDivElement | null>(null);
  const seqRef = useRef(0);
  const comboRef = useRef(0);
  const finishedRef = useRef(false);

  const [grip, setGrip] = useState<GripState>("released");
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [tally, setTally] = useState<RhythmTally>(EMPTY_TALLY);
  const [combo, setCombo] = useState(0);
  const [countdown, setCountdown] = useState<number | null>(null);

  // 最新的 callback 放進 ref，動畫迴圈才不必因為 props 換了新函式而重建
  const onStrokeRef = useRef(onStroke);
  const onFinishRef = useRef(onFinish);
  const nowRef = useRef(now);
  useEffect(() => {
    onStrokeRef.current = onStroke;
    onFinishRef.current = onFinish;
    nowRef.current = now;
  });

  // 回合換了（重玩、下一回合）就重新計分
  useEffect(() => {
    scorerRef.current = new RhythmScorer(anchorMs, rhythm);
    detector.reset();
    finishedRef.current = false;
    comboRef.current = 0;
    seqRef.current = 0;

    let cancelled = false;
    const reset = async () => {
      await Promise.resolve();
      if (cancelled) {
        return;
      }
      setTally(EMPTY_TALLY);
      setCombo(0);
      setFeedback(null);
      setGrip("released");
    };

    void reset();
    return () => {
      cancelled = true;
    };
  }, [anchorMs, rhythm, detector]);

  // 依實際版面高度換算一槳的距離
  useEffect(() => {
    const area = padAreaRef.current;
    if (!area) {
      return;
    }

    const apply = () => {
      detector.setStrokeDistance(strokeDistanceFor(area.clientHeight));
    };

    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(area);
    return () => {
      observer.disconnect();
    };
  }, [detector]);

  // 動畫與判定迴圈
  useEffect(() => {
    let raf = 0;
    let lastTallyPush = 0;
    let lastCountdown: number | null = null;
    let lastGrip: GripState | null = null;

    const frame = () => {
      raf = requestAnimationFrame(frame);

      const scorer = scorerRef.current;
      if (!scorer) {
        return;
      }

      const serverMs = nowRef.current();
      const snapshot = detector.snapshot;

      // 節拍環：往內縮到拍點，過拍瞬間彈開
      const ring = ringRef.current;
      if (ring) {
        const { phase } = beatPhase(serverMs, anchorMs, rhythm.bpm);
        const scale = 1 + 0.42 * (1 - phase);
        ring.style.transform = `scale(${scale.toFixed(3)})`;
        ring.style.opacity = (0.35 + 0.65 * phase).toFixed(3);
      }

      if (leftFillRef.current) {
        leftFillRef.current.style.transform = `scaleY(${snapshot.leftProgress.toFixed(3)})`;
      }
      if (rightFillRef.current) {
        rightFillRef.current.style.transform = `scaleY(${snapshot.rightProgress.toFixed(3)})`;
      }

      if (snapshot.grip !== lastGrip) {
        lastGrip = snapshot.grip;
        setGrip(snapshot.grip);
      }

      // 倒數：只在整數變化時進 state
      const secondsLeft = Math.ceil((anchorMs - serverMs) / 1000);
      const shown = secondsLeft > 0 ? secondsLeft : null;
      if (shown !== lastCountdown) {
        lastCountdown = shown;
        setCountdown(shown);
      }

      // 漏拍結算
      const missed = scorer.audit(serverMs);
      if (missed.length > 0) {
        comboRef.current = 0;
        seqRef.current += 1;
        setCombo(0);
        setFeedback({
          label: JUDGEMENT_LABEL.miss,
          tone: "miss",
          detail: "這一拍沒划到",
          seq: seqRef.current,
        });
      }

      if (serverMs - lastTallyPush > 220) {
        lastTallyPush = serverMs;
        setTally(scorer.tally);
      }

      const endMs =
        beatTimeMs(rhythm.totalBeats, anchorMs, rhythm.bpm) + rhythm.goodMs;
      if (!finishedRef.current && serverMs > endMs) {
        finishedRef.current = true;
        setTally(scorer.tally);
        onFinishRef.current?.(scorer.tally);
      }
    };

    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
    };
  }, [anchorMs, rhythm, detector]);

  const handleStroke = useCallback(
    (atMs: number, handOffsetMs: number) => {
      const scorer = scorerRef.current;
      if (!scorer) {
        return;
      }

      const result = scorer.registerStroke(atMs, handOffsetMs);
      if (!result) {
        // 前導拍：給觸感回饋但不判定，讓人先抓到手感
        vibrate(12);
        return;
      }

      if (result.duplicate) {
        return;
      }

      if (result.judgement === "miss") {
        comboRef.current = 0;
        vibrate(90);
      } else {
        comboRef.current += 1;
        vibrate(result.judgement === "perfect" ? [18] : [10]);
      }

      seqRef.current += 1;
      setCombo(comboRef.current);
      setFeedback({
        label: JUDGEMENT_LABEL[result.judgement],
        tone: result.judgement,
        detail: describeStroke(result),
        seq: seqRef.current,
      });
      onStrokeRef.current?.(result);
    },
    [],
  );

  const onPointerDown = useCallback(
    (side: "left" | "right") => (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      detector.pointerDown(side, e.pointerId, e.clientY);
    },
    [detector],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const stroke = detector.pointerMove(
        e.pointerId,
        e.clientY,
        nowRef.current(),
      );
      if (stroke) {
        handleStroke(stroke.atMs, stroke.handOffsetMs);
      }
    },
    [detector, handleStroke],
  );

  const onPointerRelease = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    detector.pointerUp(e.pointerId);
  }, [detector]);

  const held = grip === "held";

  return (
    <div
      className="flex min-h-dvh touch-none flex-col select-none"
      onContextMenu={(e) => e.preventDefault()}
    >
      {/* 上半：節拍與判定 */}
      <div className="relative flex flex-1 flex-col items-center justify-center px-6">
        <div className="relative flex h-40 w-40 items-center justify-center">
          <div className="absolute h-20 w-20 rounded-full border border-ink-600" />
          <div
            ref={ringRef}
            className="absolute h-20 w-20 rounded-full border-2 border-signal-500 will-change-transform"
          />
          {countdown !== null ? (
            <span className="relative text-5xl font-light text-ink-100 tabular-nums">
              {countdown}
            </span>
          ) : (
            <span className="relative text-xs tracking-[0.3em] text-ink-500">
              划
            </span>
          )}
        </div>

        <div className="mt-8 h-16 text-center">
          {feedback ? (
            <div key={feedback.seq} className="animate-rise">
              <p
                className={
                  feedback.tone === "perfect"
                    ? "text-3xl font-light text-signal-400"
                    : feedback.tone === "good"
                      ? "text-3xl font-light text-ink-100"
                      : "text-3xl font-light text-alert-500"
                }
              >
                {feedback.label}
              </p>
              <p className="mt-1 text-xs text-ink-500">{feedback.detail}</p>
            </div>
          ) : null}
        </div>

        <div className="flex items-center gap-6 text-xs text-ink-500 tabular-nums">
          <span>連續 {combo}</span>
          <span>完美 {tally.perfect}</span>
          <span>不錯 {tally.good}</span>
          <span>漏 {tally.miss}</span>
        </div>
      </div>

      {/* 下半：兩塊拇指區 */}
      <div ref={padAreaRef} className="relative h-[46dvh] px-4 pb-6">
        <div className="flex h-full gap-4">
          <Pad
            label="左手"
            fillRef={leftFillRef}
            onPointerDown={onPointerDown("left")}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerRelease}
            onPointerCancel={onPointerRelease}
          />
          <Pad
            label="右手"
            fillRef={rightFillRef}
            onPointerDown={onPointerDown("right")}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerRelease}
            onPointerCancel={onPointerRelease}
          />
        </div>

        {!held ? (
          <div className="pointer-events-none absolute inset-x-4 top-1/2 -translate-y-1/2 rounded-2xl bg-ink-950/85 px-6 py-5 text-center">
            <p className="text-sm text-ink-100">{GRIP_HINT[grip]}</p>
            <p className="mt-2 text-xs leading-relaxed text-ink-400">
              兩手握住手機，拇指壓著不要放開，
              <br />
              跟著鼓聲一起往下拉、再一起回來
            </p>
          </div>
        ) : null}
      </div>
    </div>
  );
}

interface PadProps {
  readonly label: string;
  readonly fillRef: React.RefObject<HTMLDivElement | null>;
  readonly onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void;
  readonly onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => void;
  readonly onPointerUp: (e: React.PointerEvent<HTMLDivElement>) => void;
  readonly onPointerCancel: (e: React.PointerEvent<HTMLDivElement>) => void;
}

function Pad({ label, fillRef, ...handlers }: PadProps) {
  return (
    <div
      {...handlers}
      className="relative flex-1 touch-none overflow-hidden rounded-3xl border border-ink-700 bg-ink-900"
    >
      {/* 拉槳進度由下往上長，直接對應拇指往下移動的距離 */}
      <div
        ref={fillRef}
        className="absolute inset-x-0 bottom-0 h-full origin-bottom bg-signal-900 will-change-transform"
        style={{ transform: "scaleY(0)" }}
      />
      <div className="relative flex h-full flex-col items-center justify-center gap-3">
        <span className="text-xs tracking-[0.3em] text-ink-500">{label}</span>
        <span className="text-2xl leading-none text-ink-600">↓</span>
      </div>
    </div>
  );
}

function describeStroke(result: StrokeResult): string {
  const parts: string[] = [];

  if (Math.abs(result.errorMs) > 40) {
    parts.push(result.errorMs > 0 ? "慢了一點" : "快了一點");
  }
  if (result.handOffsetMs > 120) {
    parts.push("兩手不夠齊");
  }
  return parts.join("，");
}
