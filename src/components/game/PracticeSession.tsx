"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { MotionRower } from "@/components/game/MotionRower";
import type { MotionResult } from "@/components/game/MotionRower";
import { RowingPads } from "@/components/game/RowingPads";
import { getServerClock, POOR_RTT_MS } from "@/lib/game/clock";
import type { ClockQuality } from "@/lib/game/clock";
import {
  inspectMotion,
  requestMotionPermission,
  SENSITIVITY_LABEL,
} from "@/lib/game/motion";
import type { MotionAvailability, Sensitivity } from "@/lib/game/motion";
import { DEFAULT_RHYTHM } from "@/lib/game/rhythm";
import type { RhythmTally } from "@/lib/game/rhythm";
import { OCEAN_CREATURES } from "@/lib/creatures/ocean";

/**
 * 試划（G1 驗收畫面）。
 *
 * 不需要活動、不需要入座、不需要主持人——目的只有一個：
 * 拿手機實際感受「按住、然後真的做出划船的動作」是什麼手感。
 * 這是判斷這個遊戲好不好玩的關鍵時刻，早一點試比做完整套再試便宜太多。
 *
 * 主要操作是晃動偵測。滑動模式留著當後備：
 * 部分內建瀏覽器（LINE、Facebook）與較舊的 Android 不送動作感應事件，
 * 現場有人開不起來時要有東西可以退，不能整桌少一個人。
 */

const PRACTICE_MS = 30000;
const LEAD_IN_MS = 5000;

type Phase = "intro" | "rowing" | "done";
type Mode = "motion" | "touch";

const AVAILABILITY_NOTE: Record<MotionAvailability, string> = {
  ready: "",
  "needs-permission": "按下開始時，手機會問你要不要允許使用動作感應，請選允許。",
  insecure: "這個網址不是 HTTPS，瀏覽器不會提供動作感應。請用正式網址開啟。",
  unsupported: "這個瀏覽器沒有動作感應，只能用滑動模式。",
};

export function PracticeSession() {
  const [phase, setPhase] = useState<Phase>("intro");
  const [mode, setMode] = useState<Mode>("motion");
  const [availability, setAvailability] = useState<MotionAvailability>("ready");
  const [permissionDenied, setPermissionDenied] = useState(false);
  const [sensitivity, setSensitivity] = useState<Sensitivity>("medium");
  const [creatureKey, setCreatureKey] = useState("whale");
  const [startAtMs, setStartAtMs] = useState(0);
  const [motionResult, setMotionResult] = useState<MotionResult | null>(null);
  const [touchTally, setTouchTally] = useState<RhythmTally | null>(null);
  const [clockQuality, setClockQuality] = useState<ClockQuality | null>(null);

  const clockRef = useRef(getServerClock());
  const now = useCallback(() => clockRef.current.now(), []);

  // 一進頁面就先看看這台裝置給不給動作感應，不要等到按下開始才發現
  useEffect(() => {
    let cancelled = false;
    const probe = async () => {
      await Promise.resolve();
      if (cancelled) {
        return;
      }
      const found = inspectMotion();
      setAvailability(found);
      if (found === "unsupported" || found === "insecure") {
        setMode("touch");
      }
    };
    void probe();
    return () => {
      cancelled = true;
    };
  }, []);

  const start = useCallback(async () => {
    let chosen = mode;

    if (chosen === "motion" && availability === "needs-permission") {
      // 必須在這個點擊事件裡問，而且被拒絕之後再問也不會跳視窗了
      const granted = await requestMotionPermission();
      if (!granted) {
        setPermissionDenied(true);
        chosen = "touch";
        setMode("touch");
      }
    }

    setStartAtMs(clockRef.current.now() + LEAD_IN_MS);
    setMotionResult(null);
    setTouchTally(null);
    setPhase("rowing");

    // 對時放在開始之後才跑：讓玩家馬上划得到，網路慢也不會卡在等待畫面
    void clockRef.current
      .sync()
      .then(setClockQuality)
      .catch(() => undefined);
  }, [availability, mode]);

  const finishMotion = useCallback((result: MotionResult) => {
    setMotionResult(result);
    setPhase("done");
  }, []);

  const finishTouch = useCallback((result: RhythmTally) => {
    setTouchTally(result);
    setPhase("done");
  }, []);

  if (phase === "rowing") {
    return (
      <main className="relative">
        <button
          type="button"
          onClick={() => setPhase("intro")}
          className="absolute top-4 right-5 z-10 text-xs text-ink-500"
        >
          結束
        </button>
        {mode === "motion" ? (
          <MotionRower
            creatureKey={creatureKey}
            color="#4fc3d9"
            durationMs={PRACTICE_MS}
            startAtMs={startAtMs}
            now={now}
            sensitivity={sensitivity}
            onSensitivityChange={setSensitivity}
            onFinish={finishMotion}
          />
        ) : (
          <RowingPads
            anchorMs={startAtMs}
            rhythm={{ ...DEFAULT_RHYTHM, totalBeats: 32 }}
            now={now}
            onFinish={finishTouch}
          />
        )}
      </main>
    );
  }

  if (phase === "done") {
    return (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-8 py-16">
        <p className="text-xs tracking-[0.35em] text-ink-500 uppercase">
          試划結果
        </p>

        {motionResult ? (
          <>
            <p className="mt-6 text-6xl font-light text-signal-400 tabular-nums">
              {Math.round(motionResult.progress * 100)}
              <span className="ml-2 text-2xl text-ink-400">％ 航程</span>
            </p>
            <dl className="mt-10 space-y-3 text-sm">
              <Row label="總共划了" value={`${motionResult.strokes} 下`} />
              <Row
                label="平均划速"
                value={`${Math.round(motionResult.averageSpm)} 下／分`}
              />
              <Row
                label="最快划速"
                value={`${Math.round(motionResult.peakSpm)} 下／分`}
              />
              <Row
                label="握住的時間"
                value={`${Math.round(motionResult.heldRatio * 100)}％`}
              />
            </dl>
            <p className="mt-8 text-xs leading-relaxed text-ink-500">
              {describeMotion(motionResult, sensitivity)}
            </p>
          </>
        ) : null}

        {touchTally ? (
          <>
            <p className="mt-6 text-6xl font-light text-signal-400 tabular-nums">
              {Math.round(touchTally.accuracy * 100)}
              <span className="ml-2 text-2xl text-ink-400">分</span>
            </p>
            <dl className="mt-10 space-y-3 text-sm">
              <Row label="完美" value={`${touchTally.perfect} 次`} />
              <Row label="不錯" value={`${touchTally.good} 次`} />
              <Row label="沒跟上" value={`${touchTally.miss} 次`} />
            </dl>
          </>
        ) : null}

        <p className="mt-6 text-xs leading-relaxed text-ink-500">
          {describeQuality(clockQuality)}
        </p>

        <button
          type="button"
          onClick={() => setPhase("intro")}
          className="mt-10 w-full rounded-lg bg-signal-500 py-3.5 text-base font-medium text-ink-950"
        >
          再試一次
        </button>
      </main>
    );
  }

  const note = permissionDenied
    ? "你剛剛沒有允許動作感應。要重新啟用得先到瀏覽器設定把權限打開，這裡先用滑動模式。"
    : AVAILABILITY_NOTE[availability];

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-8 py-16">
      <p className="text-xs tracking-[0.35em] text-ink-500 uppercase">試划</p>
      <h1 className="mt-6 text-3xl font-light text-ink-100">划去救貓</h1>
      <p className="mt-5 text-sm leading-relaxed text-ink-400">
        兩手握住手機，兩隻拇指分別壓在畫面下方的兩塊上——按住感應器才會啟動。
        <br />
        接著整支手機跟著身體做划船的動作，晃得越快，你的海洋生物游得越快。
        <br />
        放開拇指就會停下來。
      </p>

      <div className="mt-10">
        <label htmlFor="creature" className="block text-sm text-ink-300">
          你這一隊是哪一種海洋生物
        </label>
        <select
          id="creature"
          value={creatureKey}
          onChange={(e) => setCreatureKey(e.target.value)}
          className="mt-3 w-full rounded-lg border border-ink-700 bg-ink-900 px-4 py-3 text-base text-ink-100 outline-none transition-colors duration-300 ease-world focus:border-signal-500"
        >
          {OCEAN_CREATURES.map((creature) => (
            <option key={creature.key} value={creature.key}>
              {creature.name}
            </option>
          ))}
        </select>
      </div>

      <div className="mt-8">
        <p className="text-sm text-ink-300">靈敏度</p>
        <p className="mt-1 text-xs text-ink-500">
          手機重、力氣小就調鬆一點。划的時候還可以再改。
        </p>
        <div className="mt-3 flex gap-2">
          {(["low", "medium", "high"] as const).map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => setSensitivity(value)}
              className={
                value === sensitivity
                  ? "flex-1 rounded-lg border border-signal-500 bg-signal-900/40 px-3 py-2.5 text-xs text-ink-100"
                  : "flex-1 rounded-lg border border-ink-700 bg-ink-900 px-3 py-2.5 text-xs text-ink-400"
              }
            >
              {SENSITIVITY_LABEL[value]}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-8">
        <p className="text-sm text-ink-300">操作方式</p>
        <div className="mt-3 flex gap-2">
          <button
            type="button"
            disabled={availability === "unsupported" || availability === "insecure"}
            onClick={() => setMode("motion")}
            className={
              mode === "motion"
                ? "flex-1 rounded-lg border border-signal-500 bg-signal-900/40 px-3 py-2.5 text-xs text-ink-100"
                : "flex-1 rounded-lg border border-ink-700 bg-ink-900 px-3 py-2.5 text-xs text-ink-400 disabled:opacity-30"
            }
          >
            晃動手機
          </button>
          <button
            type="button"
            onClick={() => setMode("touch")}
            className={
              mode === "touch"
                ? "flex-1 rounded-lg border border-signal-500 bg-signal-900/40 px-3 py-2.5 text-xs text-ink-100"
                : "flex-1 rounded-lg border border-ink-700 bg-ink-900 px-3 py-2.5 text-xs text-ink-400"
            }
          >
            滑螢幕（後備）
          </button>
        </div>
      </div>

      {note ? (
        <p className="mt-5 text-xs leading-relaxed text-ink-400">{note}</p>
      ) : null}

      <button
        type="button"
        onClick={() => void start()}
        className="mt-10 w-full rounded-lg bg-signal-500 py-3.5 text-base font-medium text-ink-950"
      >
        開始試划
      </button>

      <p className="mt-6 text-xs leading-relaxed text-ink-500">
        共 {PRACTICE_MS / 1000} 秒，開始前有 {LEAD_IN_MS / 1000} 秒倒數。
      </p>
    </main>
  );
}

function Row({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}) {
  return (
    <div className="flex items-baseline justify-between border-b border-ink-800 pb-3">
      <dt className="text-ink-400">{label}</dt>
      <dd className="text-ink-100 tabular-nums">{value}</dd>
    </div>
  );
}

/**
 * 把結果翻譯成「下一步該調什麼」。
 * 現場沒有人會去看數字然後自己推論，要直接講。
 */
function describeMotion(
  result: MotionResult,
  sensitivity: Sensitivity,
): string {
  if (result.strokes === 0) {
    return "完全沒有偵測到划槳。先確認兩隻拇指有壓住下面兩塊，再把靈敏度調到「輕輕晃就算」試一次。";
  }
  if (result.heldRatio < 0.6) {
    return "有不少時間沒握住，那段不會計分。這是安全機制——手機要抓牢。";
  }
  if (result.peakSpm > 260) {
    return `最快衝到 ${Math.round(result.peakSpm)} 下／分，偏高，可能把手抖也算進去了。把靈敏度調成「要用力划」再試一次。`;
  }
  if (result.averageSpm < 60 && sensitivity !== "high") {
    return "划速偏低。如果你覺得自己已經很用力了，把靈敏度調鬆一點再試。";
  }
  return `這樣的手感如果覺得對，就用這個靈敏度（${SENSITIVITY_LABEL[sensitivity]}）。`;
}

function describeQuality(quality: ClockQuality | null): string {
  if (!quality || !quality.synced) {
    return "這次沒有連上伺服器對時。試划不受影響，但正式開場前要確認網路。";
  }
  if (quality.bestRttMs > POOR_RTT_MS) {
    return `與伺服器的往返約 ${Math.round(quality.bestRttMs)} 毫秒，偏慢。現場若是同一種網路，開場前要先處理。`;
  }
  return `與伺服器的往返約 ${Math.round(quality.bestRttMs)} 毫秒，時差已校正 ${Math.round(quality.offsetMs)} 毫秒。`;
}
