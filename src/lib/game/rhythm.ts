/**
 * 節拍與判定（G1）。
 *
 * 這一層刻意不碰 DOM、不碰 React、不碰網路：輸入是「伺服器時間軸上的
 * 毫秒」，輸出是判定結果。所有遊戲共用同一套節拍模型，
 * 海洋救援只是第一個使用者。
 *
 * 時間原點是回合的 started_at（第 0 拍）。started_at 之前的拍是負數，
 * 那是前導拍——手機在那段時間放節拍聲讓人抓到速度，但不計分。
 */

export type Judgement = "perfect" | "good" | "miss";

export const JUDGEMENT_LABEL: Record<Judgement, string> = {
  perfect: "完美",
  good: "不錯",
  miss: "沒跟上",
};

export interface RhythmConfig {
  /** 每分鐘拍數 */
  readonly bpm: number;
  /** 誤差在此範圍內算完美，單位毫秒 */
  readonly perfectMs: number;
  /** 誤差在此範圍內算不錯 */
  readonly goodMs: number;
  /** 正式開始前的前導拍數，只放聲音不計分 */
  readonly leadInBeats: number;
  /** 一回合共幾拍 */
  readonly totalBeats: number;
}

/**
 * 預設值。80 BPM 是實際划船的槳頻，一拍 750 毫秒——
 * 快到需要專注，慢到穿高跟鞋、拿著酒杯的人也跟得上。
 *
 * 判定窗刻意比一般音game寬鬆：這是尾牙不是比賽，
 * 全場一直看到「沒跟上」不會有人想玩第二輪。
 */
export const DEFAULT_RHYTHM: RhythmConfig = {
  bpm: 80,
  perfectMs: 110,
  goodMs: 230,
  leadInBeats: 4,
  totalBeats: 80,
};

export function beatIntervalMs(bpm: number): number {
  return 60000 / bpm;
}

/** 第 index 拍在伺服器時間軸上的時刻 */
export function beatTimeMs(
  index: number,
  anchorMs: number,
  bpm: number,
): number {
  return anchorMs + index * beatIntervalMs(bpm);
}

export interface BeatPosition {
  /** 最接近的拍序，可為負 */
  readonly index: number;
  /** 與該拍的誤差，正值代表偏慢 */
  readonly errorMs: number;
}

export function nearestBeat(
  serverMs: number,
  anchorMs: number,
  bpm: number,
): BeatPosition {
  const interval = beatIntervalMs(bpm);
  const index = Math.round((serverMs - anchorMs) / interval);
  return { index, errorMs: serverMs - beatTimeMs(index, anchorMs, bpm) };
}

/** 目前落在第幾拍，以及該拍已經走了多少（0~1）。用於畫面上的節拍動畫。 */
export function beatPhase(
  serverMs: number,
  anchorMs: number,
  bpm: number,
): { readonly index: number; readonly phase: number } {
  const interval = beatIntervalMs(bpm);
  const raw = (serverMs - anchorMs) / interval;
  const index = Math.floor(raw);
  return { index, phase: raw - index };
}

export function judge(errorMs: number, config: RhythmConfig): Judgement {
  const abs = Math.abs(errorMs);
  if (abs <= config.perfectMs) {
    return "perfect";
  }
  if (abs <= config.goodMs) {
    return "good";
  }
  return "miss";
}

export interface StrokeResult {
  readonly beatIndex: number;
  readonly errorMs: number;
  readonly judgement: Judgement;
  /** 這一拍已經划過了，不重複計分 */
  readonly duplicate: boolean;
  /** 兩手抵達的時間差，越小代表自己的雙手越同步 */
  readonly handOffsetMs: number;
}

export interface RhythmTally {
  readonly perfect: number;
  readonly good: number;
  readonly miss: number;
  /** 有效划槳次數（不含重複與前導拍） */
  readonly strokes: number;
  /** 0~1，完美算滿分、不錯算六成 */
  readonly accuracy: number;
  /** 雙手時間差的平均，單位毫秒 */
  readonly averageHandOffsetMs: number;
}

export const EMPTY_TALLY: RhythmTally = {
  perfect: 0,
  good: 0,
  miss: 0,
  strokes: 0,
  accuracy: 0,
  averageHandOffsetMs: 0,
};

/**
 * 逐拍記分。
 *
 * 兩種 Miss 要分開處理，否則數字會說謊：
 * 一種是「划了但差太多」，一種是「整拍沒划」。前者在 registerStroke
 * 當下就知道，後者要等那一拍的判定窗過去才能確定，由 audit() 補上。
 */
export class RhythmScorer {
  private readonly claimed = new Set<number>();
  private perfect = 0;
  private good = 0;
  private miss = 0;
  private strokes = 0;
  private handOffsetTotal = 0;
  private nextAuditBeat = 0;
  private readonly anchorMs: number;
  private readonly config: RhythmConfig;

  constructor(anchorMs: number, config: RhythmConfig) {
    this.anchorMs = anchorMs;
    this.config = config;
  }

  /**
   * 記錄一次划槳。回傳 null 代表落在前導拍——
   * 那是暖身，不該讓玩家看到「沒跟上」而以為自己划錯了。
   */
  registerStroke(atMs: number, handOffsetMs: number): StrokeResult | null {
    const { index, errorMs } = nearestBeat(atMs, this.anchorMs, this.config.bpm);

    if (index < 0) {
      return null;
    }

    const judgement = judge(errorMs, this.config);
    const duplicate = this.claimed.has(index);

    if (judgement === "miss") {
      // 亂划也是 Miss，但不佔用這一拍——之後划準了還是算數
      this.miss += 1;
    } else if (!duplicate) {
      this.claimed.add(index);
      this.strokes += 1;
      this.handOffsetTotal += handOffsetMs;
      if (judgement === "perfect") {
        this.perfect += 1;
      } else {
        this.good += 1;
      }
    }

    return { beatIndex: index, errorMs, judgement, duplicate, handOffsetMs };
  }

  /**
   * 結算已經來不及補救的拍。回傳這次新判定為漏拍的拍序，
   * 讓畫面可以即時顯示「沒跟上」。
   */
  audit(serverMs: number): number[] {
    const missed: number[] = [];

    while (this.nextAuditBeat < this.config.totalBeats) {
      const deadline =
        beatTimeMs(this.nextAuditBeat, this.anchorMs, this.config.bpm) +
        this.config.goodMs;

      if (deadline >= serverMs) {
        break;
      }
      if (!this.claimed.has(this.nextAuditBeat)) {
        this.miss += 1;
        missed.push(this.nextAuditBeat);
      }
      this.nextAuditBeat += 1;
    }

    return missed;
  }

  get tally(): RhythmTally {
    const scored = this.perfect + this.good + this.miss;
    return {
      perfect: this.perfect,
      good: this.good,
      miss: this.miss,
      strokes: this.strokes,
      accuracy:
        scored === 0 ? 0 : (this.perfect + this.good * 0.6) / scored,
      averageHandOffsetMs:
        this.strokes === 0 ? 0 : this.handOffsetTotal / this.strokes,
    };
  }
}

/**
 * 從 game_sessions.config 取出節拍設定。
 *
 * config 是 jsonb，內容由主持人端寫入，不保證型別；
 * 任何一個欄位壞掉都退回預設值，絕不能因為設定髒了就讓現場開不了場。
 */
export function parseRhythmConfig(
  config: Record<string, unknown> | null | undefined,
): RhythmConfig {
  const source = config ?? {};

  const pick = (key: string, fallback: number, min: number, max: number) => {
    const raw = source[key];
    const value = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isFinite(value)) {
      return fallback;
    }
    return Math.min(Math.max(value, min), max);
  };

  const perfectMs = pick("perfectMs", DEFAULT_RHYTHM.perfectMs, 40, 300);

  return {
    bpm: pick("bpm", DEFAULT_RHYTHM.bpm, 40, 200),
    perfectMs,
    // 設定寫反時（good 比 perfect 還嚴）會讓「不錯」永遠出不來，
    // 判定看起來就像壞掉了，這裡直接扶正
    goodMs: Math.max(pick("goodMs", DEFAULT_RHYTHM.goodMs, 60, 500), perfectMs),
    leadInBeats: pick("leadInBeats", DEFAULT_RHYTHM.leadInBeats, 0, 16),
    totalBeats: pick("totalBeats", DEFAULT_RHYTHM.totalBeats, 8, 600),
  };
}
