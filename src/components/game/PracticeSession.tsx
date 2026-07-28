"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { RowingPads } from "@/components/game/RowingPads";
import { getServerClock, POOR_RTT_MS } from "@/lib/game/clock";
import type { ClockQuality } from "@/lib/game/clock";
import { Metronome } from "@/lib/game/metronome";
import { DEFAULT_RHYTHM, beatIntervalMs } from "@/lib/game/rhythm";
import type { RhythmConfig, RhythmTally } from "@/lib/game/rhythm";

/**
 * 試划（G1 驗收畫面）。
 *
 * 不需要活動、不需要入座、不需要主持人——目的只有一個：
 * 拿手機實際感受「跟著鼓點划船」是什麼手感。這是判斷這個遊戲
 * 好不好玩的關鍵時刻，早一點試比做完整套再試便宜太多。
 *
 * 試划完全在本機時間軸上進行：起始時間與判定用的是同一個時鐘，
 * 就算對時失敗也照樣準。仍然會對一次時，是為了在這裡就先看到
 * 現場網路的往返品質——那是正式開場前唯一能提前發現的問題。
 */

const TEMPO_OPTIONS = [
  { bpm: 62, label: "慢", hint: "熱身、長輩多的場次" },
  { bpm: 80, label: "標準", hint: "實際划船的槳頻" },
  { bpm: 96, label: "快", hint: "需要專注才跟得上" },
  { bpm: 112, label: "衝刺", hint: "最後一段的極限" },
] as const;

const PRACTICE_TOTAL_BEATS = 32;
const PRACTICE_LEAD_IN_BEATS = 6;

type Phase = "intro" | "rowing" | "done";

export function PracticeSession() {
  const [phase, setPhase] = useState<Phase>("intro");
  const [bpm, setBpm] = useState(DEFAULT_RHYTHM.bpm);
  const [rhythm, setRhythm] = useState<RhythmConfig | null>(null);
  const [anchorMs, setAnchorMs] = useState(0);
  const [tally, setTally] = useState<RhythmTally | null>(null);
  const [clockQuality, setClockQuality] = useState<ClockQuality | null>(null);
  const [soundOn, setSoundOn] = useState(true);

  // 節拍器的建構子不碰 AudioContext（那要等使用者手勢），可安全惰性建立
  const [metronome] = useState(() => new Metronome());
  const clockRef = useRef(getServerClock());

  useEffect(() => {
    return () => {
      metronome.dispose();
    };
  }, [metronome]);

  const now = useCallback(() => clockRef.current.now(), []);

  const start = useCallback(async () => {
    const config: RhythmConfig = {
      ...DEFAULT_RHYTHM,
      bpm,
      totalBeats: PRACTICE_TOTAL_BEATS,
      leadInBeats: PRACTICE_LEAD_IN_BEATS,
    };

    // 必須在這個點擊事件裡啟動音訊，之後就沒有機會了
    const audioReady = soundOn ? await metronome.enable() : false;

    const anchor =
      clockRef.current.now() + PRACTICE_LEAD_IN_BEATS * beatIntervalMs(bpm);

    setRhythm(config);
    setAnchorMs(anchor);
    setTally(null);
    setPhase("rowing");

    if (audioReady) {
      metronome.start(anchor, config, now, -PRACTICE_LEAD_IN_BEATS);
    }

    // 對時放在開始之後才跑：讓玩家馬上划得到，網路慢也不會卡在等待畫面
    void clockRef.current
      .sync()
      .then(setClockQuality)
      .catch(() => undefined);
  }, [bpm, metronome, now, soundOn]);

  const finish = useCallback((result: RhythmTally) => {
    metronome.stop();
    setTally(result);
    setPhase("done");
  }, [metronome]);

  const abort = useCallback(() => {
    metronome.stop();
    setPhase("intro");
  }, [metronome]);

  if (phase === "rowing" && rhythm) {
    return (
      <main className="relative">
        <button
          type="button"
          onClick={abort}
          className="absolute top-4 right-5 z-10 text-xs text-ink-500"
        >
          結束
        </button>
        <RowingPads
          anchorMs={anchorMs}
          rhythm={rhythm}
          now={now}
          onFinish={finish}
        />
      </main>
    );
  }

  if (phase === "done" && tally) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-8 py-16">
        <p className="text-xs tracking-[0.35em] text-ink-500 uppercase">試划結果</p>
        <p className="mt-6 text-6xl font-light text-signal-400 tabular-nums">
          {Math.round(tally.accuracy * 100)}
          <span className="ml-2 text-2xl text-ink-400">分</span>
        </p>

        <dl className="mt-10 space-y-3 text-sm">
          <Row label="完美" value={`${tally.perfect} 次`} />
          <Row label="不錯" value={`${tally.good} 次`} />
          <Row label="沒跟上" value={`${tally.miss} 次`} />
          <Row
            label="雙手時間差"
            value={`平均 ${Math.round(tally.averageHandOffsetMs)} 毫秒`}
          />
        </dl>

        <p className="mt-8 text-xs leading-relaxed text-ink-500">
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

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-8 py-16">
      <p className="text-xs tracking-[0.35em] text-ink-500 uppercase">試划</p>
      <h1 className="mt-6 text-3xl font-light text-ink-100">跟著鼓聲划船</h1>
      <p className="mt-5 text-sm leading-relaxed text-ink-400">
        兩手握住手機，兩隻拇指分別壓在下面的兩塊上。
        <br />
        聽到鼓聲的那一刻，兩隻拇指一起往下拉，再一起回到上面。
        <br />
        重要的不是快，是準——而且兩手要一起。
      </p>

      <div className="mt-10">
        <p className="text-sm text-ink-300">速度</p>
        <div className="mt-3 grid grid-cols-2 gap-2">
          {TEMPO_OPTIONS.map((option) => (
            <button
              key={option.bpm}
              type="button"
              onClick={() => setBpm(option.bpm)}
              className={
                option.bpm === bpm
                  ? "rounded-lg border border-signal-500 bg-signal-900/40 px-4 py-3 text-left transition-colors duration-300 ease-world"
                  : "rounded-lg border border-ink-700 bg-ink-900 px-4 py-3 text-left transition-colors duration-300 ease-world"
              }
            >
              <span className="text-sm text-ink-100">{option.label}</span>
              <span className="mt-1 block text-xs text-ink-500">
                {option.bpm} BPM · {option.hint}
              </span>
            </button>
          ))}
        </div>
      </div>

      <label className="mt-8 flex items-center gap-3 text-sm text-ink-300">
        <input
          type="checkbox"
          checked={soundOn}
          onChange={(e) => setSoundOn(e.target.checked)}
          className="h-4 w-4 accent-[var(--color-signal-500)]"
        />
        開啟鼓聲（現場請戴耳機或調小音量）
      </label>

      <button
        type="button"
        onClick={() => void start()}
        className="mt-10 w-full rounded-lg bg-signal-500 py-3.5 text-base font-medium text-ink-950"
      >
        開始試划
      </button>

      <p className="mt-6 text-xs leading-relaxed text-ink-500">
        共 {PRACTICE_TOTAL_BEATS} 拍，約{" "}
        {Math.round((PRACTICE_TOTAL_BEATS * beatIntervalMs(bpm)) / 1000)} 秒。
        前面幾聲是預備拍，不計分。
      </p>
    </main>
  );
}

function Row({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="flex items-baseline justify-between border-b border-ink-800 pb-3">
      <dt className="text-ink-400">{label}</dt>
      <dd className="text-ink-100 tabular-nums">{value}</dd>
    </div>
  );
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
