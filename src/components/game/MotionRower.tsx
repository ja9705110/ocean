"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { GripPads } from "@/components/game/GripPads";
import type { Grip } from "@/components/game/GripPads";
import { RescueTrack } from "@/components/game/RescueTrack";
import {
  EMPTY_READING,
  MotionRowingSensor,
  SENSITIVITY_LABEL,
  TARGET_SPM,
} from "@/lib/game/motion";
import type { Sensitivity, ShakeReading } from "@/lib/game/motion";

/**
 * 划槳控制器：晃動版（G1b）。
 *
 * 兩隻拇指按住 → 感應器啟動 → 整支手機跟著身體做划船動作 →
 * 晃得越快，自己這一隊的海洋生物游得越快。
 *
 * 畫面上放一條自己的航道，是因為「我做的事有沒有用」這個回饋
 * 必須在第一秒就出現。等抬頭看大螢幕才知道，太慢了。
 *
 * 每秒 60 次的讀值與動畫都寫在 rAF 裡，只有整數變化才進 React state：
 * 感應器事件本身就有六十幾赫茲，再讓整棵樹跟著重繪，中階手機會掉幀。
 */

interface MotionRowerProps {
  readonly creatureKey: string;
  readonly color: string;
  /** 一回合幾秒 */
  readonly durationMs: number;
  /** 第 0 秒的時刻（伺服器時間軸） */
  readonly startAtMs: number;
  readonly now: () => number;
  readonly sensitivity: Sensitivity;
  readonly onSensitivityChange?: (value: Sensitivity) => void;
  readonly onFinish?: (result: MotionResult) => void;
}

export interface MotionResult {
  /** 總划槳次數 */
  readonly strokes: number;
  /** 平均划速 */
  readonly averageSpm: number;
  /** 最高划速 */
  readonly peakSpm: number;
  /** 0~1，航道走完的比例 */
  readonly progress: number;
  /** 實際握住的時間佔比 */
  readonly heldRatio: number;
}

/** 滿速時走完全程所需的秒數。用來把划速換算成航道進度。 */
const FULL_SPEED_SECONDS = 26;

const SENSITIVITIES: readonly Sensitivity[] = ["low", "medium", "high"];

export function MotionRower({
  creatureKey,
  color,
  durationMs,
  startAtMs,
  now,
  sensitivity,
  onSensitivityChange,
  onFinish,
}: MotionRowerProps) {
  const [sensor] = useState(() => new MotionRowingSensor());
  const [reading, setReading] = useState<ShakeReading>(EMPTY_READING);
  const [progress, setProgress] = useState(0);
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  const [counting, setCounting] = useState(true);
  const [noData, setNoData] = useState(false);

  const progressRef = useRef(0);
  const heldMsRef = useRef(0);
  const spmSumRef = useRef(0);
  const spmSamplesRef = useRef(0);
  const peakSpmRef = useRef(0);
  const finishedRef = useRef(false);

  const nowRef = useRef(now);
  const onFinishRef = useRef(onFinish);
  useEffect(() => {
    nowRef.current = now;
    onFinishRef.current = onFinish;
  });

  useEffect(() => {
    sensor.setSensitivity(sensitivity);
  }, [sensor, sensitivity]);

  useEffect(() => {
    sensor.start();
    return () => {
      sensor.stop();
    };
  }, [sensor]);

  const handleGrip = useCallback(
    (grip: Grip) => {
      sensor.setArmed(grip === "held");
    },
    [sensor],
  );

  useEffect(() => {
    let raf = 0;
    let lastMs = 0;
    let lastSecond: number | null = null;
    let lastNoData = false;
    let lastCounting = true;
    let lastPush = 0;

    const frame = () => {
      raf = requestAnimationFrame(frame);

      const serverMs = nowRef.current();
      const dt = lastMs === 0 ? 16 : Math.min(serverMs - lastMs, 200);
      lastMs = serverMs;

      const value = sensor.read(serverMs);
      const running = serverMs >= startAtMs && serverMs < startAtMs + durationMs;

      if (running) {
        if (sensor.isArmed) {
          heldMsRef.current += dt;
        }
        // 進度以「滿速幾秒跑完」為基準，速度快就走得快
        progressRef.current = Math.min(
          1,
          progressRef.current +
            (value.intensity * dt) / (FULL_SPEED_SECONDS * 1000),
        );

        spmSumRef.current += value.spm;
        spmSamplesRef.current += 1;
        peakSpmRef.current = Math.max(peakSpmRef.current, value.spm);
      }

      // 數字每秒更新十幾次就夠讀了。每幀都進 state 會讓整棵樹跟著重繪，
      // 而感應器事件本身已經有六十幾赫茲，那是掉幀的來源。
      if (serverMs - lastPush > 66) {
        lastPush = serverMs;
        setReading(value);
        setProgress(progressRef.current);
      }

      const isCounting = serverMs < startAtMs;
      if (isCounting !== lastCounting) {
        lastCounting = isCounting;
        setCounting(isCounting);
      }

      // 倒數與剩餘時間都用整數，只有變化時才進 state
      const shown =
        serverMs < startAtMs
          ? Math.ceil((startAtMs - serverMs) / 1000)
          : Math.max(0, Math.ceil((startAtMs + durationMs - serverMs) / 1000));
      if (shown !== lastSecond) {
        lastSecond = shown;
        setSecondsLeft(shown);
      }

      // 綁了事件卻始終收不到資料，代表這台裝置給不了動作感應
      const missing = !sensor.hasData && serverMs - startAtMs > 1500;
      if (missing !== lastNoData) {
        lastNoData = missing;
        setNoData(missing);
      }

      if (!finishedRef.current && serverMs >= startAtMs + durationMs) {
        finishedRef.current = true;
        onFinishRef.current?.({
          strokes: value.strokes,
          averageSpm:
            spmSamplesRef.current === 0
              ? 0
              : spmSumRef.current / spmSamplesRef.current,
          peakSpm: peakSpmRef.current,
          progress: progressRef.current,
          heldRatio: Math.min(1, heldMsRef.current / durationMs),
        });
      }
    };

    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
    };
  }, [sensor, startAtMs, durationMs]);

  return (
    <div
      className="flex min-h-dvh touch-none flex-col select-none"
      onContextMenu={(e) => e.preventDefault()}
    >
      {/* 自己這一隊的航道 */}
      <div className="px-4 pt-6">
        <RescueTrack
          creatureKey={creatureKey}
          color={color}
          progress={progress}
          intensity={reading.intensity}
        />
      </div>

      {/* 划速 */}
      <div className="flex flex-1 flex-col items-center justify-center px-6">
        {counting ? (
          <>
            <span className="text-6xl font-light text-ink-100 tabular-nums">
              {secondsLeft}
            </span>
            <p className="mt-4 text-sm text-ink-400">
              把手機握好，兩隻拇指放上去
            </p>
          </>
        ) : (
          <>
            <div className="flex items-baseline gap-2">
              <span className="text-6xl font-light text-signal-400 tabular-nums">
                {Math.round(reading.spm)}
              </span>
              <span className="text-sm text-ink-500">下／分</span>
            </div>

            {/* 速度條 */}
            <div className="mt-6 h-2.5 w-56 overflow-hidden rounded-full bg-ink-800">
              <div
                className="h-full rounded-full bg-signal-500 transition-[width] duration-100 ease-linear"
                style={{ width: `${Math.round(reading.intensity * 100)}%` }}
              />
            </div>

            <p className="mt-4 text-xs text-ink-500 tabular-nums">
              划了 {reading.strokes} 下 ｜ 剩 {secondsLeft} 秒 ｜ 滿速{" "}
              {TARGET_SPM} 下／分
            </p>
          </>
        )}

        {noData ? (
          <p className="mt-6 max-w-xs text-center text-xs leading-relaxed text-alert-500">
            這支手機沒有回傳動作感應資料。
            <br />
            請改用滑動模式，或換一個瀏覽器開啟。
          </p>
        ) : null}

        {/* 靈敏度：不同手機的重量與每個人的力氣差很多，現場要調得動 */}
        {onSensitivityChange && !counting ? (
          <div className="mt-8 flex gap-2">
            {SENSITIVITIES.map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => onSensitivityChange(value)}
                className={
                  value === sensitivity
                    ? "rounded-full border border-signal-500 px-4 py-1.5 text-xs text-signal-400"
                    : "rounded-full border border-ink-700 px-4 py-1.5 text-xs text-ink-500"
                }
              >
                {SENSITIVITY_LABEL[value]}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      {/* 握持區 */}
      <div className="h-[38dvh]">
        <GripPads onGripChange={handleGrip} intensity={reading.intensity} />
      </div>
    </div>
  );
}
