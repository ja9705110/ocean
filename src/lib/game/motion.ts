"use client";

/**
 * 晃動偵測（G1b）。
 *
 * 動作是真的划船：兩手握著手機，兩隻拇指壓住畫面下方的兩塊把感應器打開，
 * 然後整支手機跟著身體做划槳的動作。晃得越快，隊伍的海洋生物游得越快。
 *
 * 為什麼要「先按住才感應」：
 * 1. 安全。不按住就不算數，等於強迫雙手握持，手機才不會飛出去。
 * 2. 防作弊。不然把手機放在桌上用手拍、或塞進口袋跑步都能刷分。
 * 3. 大家一起把手放上去的那一刻，本身就是開場的儀式感。
 *
 * 這一層分成兩塊：
 * - ShakeAnalyser 是純數學，輸入加速度大小與時間，輸出划速。不碰任何
 *   瀏覽器 API，因此可以餵合成訊號直接驗證。
 * - MotionRowingSensor 負責跟 DeviceMotion 事件與 iOS 的授權流程打交道。
 */

/** 感應器目前的可用狀態 */
export type MotionAvailability =
  | "ready" // 可以直接開始
  | "needs-permission" // iOS 需要使用者明確允許
  | "insecure" // 非 HTTPS，瀏覽器不會給資料
  | "unsupported"; // 這個瀏覽器沒有動作感應

/**
 * 靈敏度。不同手機的重量與使用者的力氣差很多，
 * 與其猜一個「正確」的門檻，不如讓現場可以調。
 */
export type Sensitivity = "low" | "medium" | "high";

export const SENSITIVITY_LABEL: Record<Sensitivity, string> = {
  low: "要用力划",
  medium: "標準",
  high: "輕輕晃就算",
};

/** 觸發一次划槳所需的加速度變化量，單位 m/s² */
const TRIGGER: Record<Sensitivity, number> = {
  low: 4.2,
  medium: 2.6,
  high: 1.5,
};

/** 遲滯：訊號要先掉回這個值以下，才允許算下一次 */
const RELEASE_RATIO = 0.4;

/** 兩次划槳之間的最短間隔。比這更密的一定是手抖或雜訊。 */
const MIN_INTERVAL_MS = 130;

/** 計算划速時往回看多久 */
const WINDOW_MS = 3000;

/** 停手多久之後開始掉速 */
const IDLE_GRACE_MS = 900;

/** 從開始掉速到歸零所需的時間 */
const IDLE_FADE_MS = 1400;

/** 重力基線的時間常數。要遠慢於划槳的頻率，否則會把訊號本身濾掉。 */
const BASELINE_TAU_MS = 500;

/** 顯示用的平滑時間常數。太短會跳動，太長會遲鈍。 */
const SMOOTH_TAU_MS = 260;

/** 峰值顯示的衰減時間常數 */
const PEAK_TAU_MS = 900;

/** 對應到滿速的划速。一般人全力划大約落在這附近。 */
export const TARGET_SPM = 170;

export interface ShakeReading {
  /** 每分鐘划槳次數，已平滑 */
  readonly spm: number;
  /** 0~1，換算成海洋生物的速度 */
  readonly intensity: number;
  /** 這一回合累計的划槳次數 */
  readonly strokes: number;
  /** 最近的加速度峰值，用來在現場判斷靈敏度該調哪一檔 */
  readonly peak: number;
}

export const EMPTY_READING: ShakeReading = {
  spm: 0,
  intensity: 0,
  strokes: 0,
  peak: 0,
};

/** 取中位數。用平均會被單一次極端間隔拉走，中位數穩得多。 */
function median(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[mid] ?? 0;
  }
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

/**
 * 把加速度序列變成划速。
 *
 * 作法：先用一個很慢的低通濾波估出重力基線，減掉之後剩下的就是動作本身；
 * 接著用「超過門檻算一次、要掉回去才准算下一次」的遲滯偵測抓出每一划；
 * 最後取最近幾次間隔的中位數換算成每分鐘次數。
 *
 * 不直接數視窗內的次數，是因為那在剛開始划的前兩三秒會嚴重低估，
 * 大螢幕上看起來就像船卡住不動。
 */
export class ShakeAnalyser {
  private baseline = 0;
  private baselineReady = false;
  private above = false;
  private strokeTimes: number[] = [];
  private strokeCount = 0;
  private smoothedSpm = 0;
  private peakValue = 0;
  private lastSampleMs = 0;
  private lastReadMs = 0;
  private sensitivity: Sensitivity = "medium";

  setSensitivity(value: Sensitivity): void {
    this.sensitivity = value;
  }

  /**
   * 清掉節奏，但保留累計次數。
   * 中途換手、調整握姿都會走到這裡——那不該把已經划過的成績歸零。
   */
  resetRhythm(): void {
    this.baseline = 0;
    this.baselineReady = false;
    this.above = false;
    this.strokeTimes = [];
    this.smoothedSpm = 0;
    this.lastSampleMs = 0;
    this.lastReadMs = 0;
  }

  /** 全部歸零。只在新的一回合開始時用。 */
  reset(): void {
    this.resetRhythm();
    this.strokeCount = 0;
    this.peakValue = 0;
  }

  /**
   * 餵進一筆加速度大小（含重力，單位 m/s²）。
   * 回傳 true 代表這一筆構成了一次划槳。
   */
  push(magnitude: number, atMs: number): boolean {
    if (!Number.isFinite(magnitude)) {
      return false;
    }

    if (!this.baselineReady) {
      this.baseline = magnitude;
      this.baselineReady = true;
      this.lastSampleMs = atMs;
      return false;
    }

    const dt = Math.max(1, Math.min(atMs - this.lastSampleMs, 200));
    this.lastSampleMs = atMs;

    // 以時間常數而非固定係數做低通：不同手機的取樣率差很多，
    // 固定係數會讓高取樣率的機器基線追得太慢、低取樣率的追得太快
    const alpha = Math.exp(-dt / BASELINE_TAU_MS);
    this.baseline = this.baseline * alpha + magnitude * (1 - alpha);

    // 刻意用有號差值而不是絕對值：一次划槳會讓加速度往上衝一次、
    // 再往回落一次，取絕對值會把同一下算成兩下，
    // 顯示出來的「划了幾下」就會是實際的兩倍。
    const ac = magnitude - this.baseline;
    this.peakValue = Math.max(this.peakValue, Math.abs(ac));

    const trigger = TRIGGER[this.sensitivity];
    const last = this.strokeTimes[this.strokeTimes.length - 1] ?? -Infinity;

    if (!this.above && ac >= trigger && atMs - last >= MIN_INTERVAL_MS) {
      this.above = true;
      this.strokeTimes.push(atMs);
      this.strokeCount += 1;
      if (this.strokeTimes.length > 12) {
        this.strokeTimes.shift();
      }
      return true;
    }

    if (this.above && ac <= trigger * RELEASE_RATIO) {
      this.above = false;
    }
    return false;
  }

  read(atMs: number): ShakeReading {
    const dt =
      this.lastReadMs === 0
        ? 16
        : Math.max(1, Math.min(atMs - this.lastReadMs, 500));
    this.lastReadMs = atMs;

    const recent = this.strokeTimes.filter((t) => t >= atMs - WINDOW_MS);
    let instant = 0;

    if (recent.length >= 2) {
      const intervals: number[] = [];
      for (let i = 1; i < recent.length; i += 1) {
        intervals.push((recent[i] ?? 0) - (recent[i - 1] ?? 0));
      }
      const mid = median(intervals);
      instant = mid > 0 ? 60000 / mid : 0;
    }

    // 停手就要掉速，否則放著不動船還在前進，看起來像壞掉
    const lastStroke = this.strokeTimes[this.strokeTimes.length - 1];
    if (lastStroke !== undefined) {
      const idle = atMs - lastStroke - IDLE_GRACE_MS;
      if (idle > 0) {
        instant *= Math.max(0, 1 - idle / IDLE_FADE_MS);
      }
    } else {
      instant = 0;
    }

    const smoothK = 1 - Math.exp(-dt / SMOOTH_TAU_MS);
    this.smoothedSpm += (instant - this.smoothedSpm) * smoothK;
    this.peakValue *= Math.exp(-dt / PEAK_TAU_MS);

    return {
      spm: this.smoothedSpm,
      intensity: Math.min(Math.max(this.smoothedSpm / TARGET_SPM, 0), 1),
      strokes: this.strokeCount,
      peak: this.peakValue,
    };
  }
}

interface DeviceMotionEventStatic {
  requestPermission?: () => Promise<PermissionState | "granted" | "denied">;
}

function motionConstructor(): DeviceMotionEventStatic | null {
  if (typeof window === "undefined" || !("DeviceMotionEvent" in window)) {
    return null;
  }
  return window.DeviceMotionEvent as unknown as DeviceMotionEventStatic;
}

/**
 * 檢查這台裝置能不能用晃動偵測。
 *
 * 三種擋路的情況要分開回報，因為處理方式完全不同：
 * iOS 要跳授權、非 HTTPS 要換網址、老瀏覽器只能退回滑動操作。
 */
export function inspectMotion(): MotionAvailability {
  const ctor = motionConstructor();
  if (!ctor) {
    return "unsupported";
  }
  if (typeof window !== "undefined" && !window.isSecureContext) {
    return "insecure";
  }
  return typeof ctor.requestPermission === "function"
    ? "needs-permission"
    : "ready";
}

/**
 * 向 iOS 要求動作感應權限。
 * 必須在使用者的點擊事件裡呼叫，而且只能問一次——
 * 被拒絕之後再問，Safari 會直接回絕不再跳視窗。
 */
export async function requestMotionPermission(): Promise<boolean> {
  const ctor = motionConstructor();
  if (!ctor) {
    return false;
  }
  if (typeof ctor.requestPermission !== "function") {
    return true;
  }
  try {
    return (await ctor.requestPermission()) === "granted";
  } catch {
    return false;
  }
}

/**
 * 綁定 DeviceMotion 並產出划速。
 *
 * 沒有「按住」就完全不計數：這同時是安全機制與防作弊機制。
 */
export class MotionRowingSensor {
  private readonly analyser = new ShakeAnalyser();
  private listening = false;
  private armed = false;
  private received = false;
  private handler: ((event: DeviceMotionEvent) => void) | null = null;

  /** 是否真的收到過資料。有些瀏覽器不報錯，就是永遠不送事件。 */
  get hasData(): boolean {
    return this.received;
  }

  get isArmed(): boolean {
    return this.armed;
  }

  setSensitivity(value: Sensitivity): void {
    this.analyser.setSensitivity(value);
  }

  /** 兩隻拇指都在螢幕上時打開感應；放開就立刻停止累計 */
  setArmed(armed: boolean): void {
    if (armed === this.armed) {
      return;
    }
    this.armed = armed;
    if (!armed) {
      // 只清掉節奏，累計次數保留——中途換手不該把成績歸零
      this.analyser.resetRhythm();
    }
  }

  start(onStroke?: (atMs: number) => void): boolean {
    if (this.listening) {
      return true;
    }
    if (typeof window === "undefined" || !("DeviceMotionEvent" in window)) {
      return false;
    }

    this.handler = (event: DeviceMotionEvent) => {
      const a = event.accelerationIncludingGravity;
      if (!a || a.x === null || a.y === null || a.z === null) {
        return;
      }
      this.received = true;
      if (!this.armed) {
        return;
      }

      const magnitude = Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
      // 用事件自帶的時間戳，才不會把事件排隊的延遲算進節奏裡
      const atMs = performance.timeOrigin + event.timeStamp;
      if (this.analyser.push(magnitude, atMs)) {
        onStroke?.(atMs);
      }
    };

    window.addEventListener("devicemotion", this.handler);
    this.listening = true;
    return true;
  }

  stop(): void {
    if (this.handler) {
      window.removeEventListener("devicemotion", this.handler);
      this.handler = null;
    }
    this.listening = false;
  }

  reset(): void {
    this.analyser.reset();
    this.received = false;
  }

  read(atMs: number): ShakeReading {
    if (!this.armed) {
      // 沒握住就是零速，但不要動累計次數
      const held = this.analyser.read(atMs);
      return { ...held, spm: 0, intensity: 0 };
    }
    return this.analyser.read(atMs);
  }
}
