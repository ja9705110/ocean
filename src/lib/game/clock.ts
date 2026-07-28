"use client";

import { getSupabaseBrowserClient } from "@/lib/supabase/client";

/**
 * 與伺服器對時（G1）。
 *
 * 為什麼需要：節奏判定是以毫秒為單位的。手機的系統時間動輒差幾秒——
 * 沒開自動對時、時區設錯、使用者自己調過都很常見。若直接用 Date.now()
 * 去比對回合的起始時間，會出現「明明整桌划得很整齊卻全判 Miss」，
 * 而且現場完全查不出原因。
 *
 * 作法是簡化版的 NTP：量測數次往返，假設去程與回程各佔一半，
 * 推得本機時鐘與伺服器的差值。取往返最快的幾次的中位數——
 * 慢的那幾次通常是排隊或重傳，去回程不對稱，估出來的偏移不可信。
 *
 * 本機時間一律用 performance.timeOrigin + performance.now()，
 * 不用 Date.now()：後者會被系統對時或使用者手動調整往前往後跳，
 * 遊戲進行到一半跳一次就全毀。
 */

/** 取樣次數。再多的邊際效益很低，卻會拖慢入場。 */
const SAMPLE_COUNT = 5;
/** 只採信往返最快的幾次 */
const KEEP_BEST = 3;
/** 取樣間隔，避免連續請求彼此排隊而互相干擾 */
const SAMPLE_GAP_MS = 120;
/** 往返超過這個值就標記為品質不佳，介面上要提醒 */
export const POOR_RTT_MS = 400;

export interface ClockQuality {
  /** 是否成功對過時。false 時 now() 等同本機時間。 */
  readonly synced: boolean;
  /** 本機時間需要加上多少毫秒才等於伺服器時間 */
  readonly offsetMs: number;
  /** 最快的一次往返時間，用來判斷這次對時可不可信 */
  readonly bestRttMs: number;
}

/** 單調遞增的本機時間，換算成 epoch 毫秒 */
function localEpochMs(): number {
  return performance.timeOrigin + performance.now();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function fetchServerNow(): Promise<number> {
  const supabase = getSupabaseBrowserClient();
  const { data, error } = await supabase.rpc("server_now");

  if (error) {
    throw new Error(error.message);
  }
  // bigint 在 PostgREST 是以字串回傳的
  const value = Number(data);
  if (!Number.isFinite(value)) {
    throw new Error("SERVER_TIME_INVALID");
  }
  return value;
}

interface Sample {
  readonly offsetMs: number;
  readonly rttMs: number;
}

export class ServerClock {
  private offsetMs = 0;
  private bestRttMs = Number.POSITIVE_INFINITY;
  private synced = false;
  private inFlight: Promise<ClockQuality> | null = null;

  /** 伺服器時間軸上的現在，單位毫秒 */
  now(): number {
    return localEpochMs() + this.offsetMs;
  }

  get quality(): ClockQuality {
    return {
      synced: this.synced,
      offsetMs: this.offsetMs,
      bestRttMs: this.bestRttMs,
    };
  }

  /**
   * 對時。同時被呼叫多次時共用同一次量測——
   * 大廳輪詢與手動重試很容易撞在一起，各跑一輪只是多打伺服器。
   */
  async sync(): Promise<ClockQuality> {
    if (this.inFlight) {
      return this.inFlight;
    }

    this.inFlight = this.runSync().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async runSync(): Promise<ClockQuality> {
    const samples: Sample[] = [];

    for (let i = 0; i < SAMPLE_COUNT; i += 1) {
      try {
        const before = localEpochMs();
        const serverMs = await fetchServerNow();
        const after = localEpochMs();
        const rttMs = after - before;
        samples.push({ offsetMs: serverMs - (before + rttMs / 2), rttMs });
      } catch {
        // 單次失敗不影響整輪，只要還有一次成功就能對時
      }

      if (i < SAMPLE_COUNT - 1) {
        await delay(SAMPLE_GAP_MS);
      }
    }

    if (samples.length === 0) {
      // 全部失敗時保留上一次的結果，不要把已對好的時間清掉
      return this.quality;
    }

    const best = [...samples]
      .sort((a, b) => a.rttMs - b.rttMs)
      .slice(0, KEEP_BEST);
    const offsets = best.map((s) => s.offsetMs).sort((a, b) => a - b);

    this.offsetMs = offsets[Math.floor(offsets.length / 2)] ?? 0;
    this.bestRttMs = best[0]?.rttMs ?? Number.POSITIVE_INFINITY;
    this.synced = true;
    return this.quality;
  }
}

let shared: ServerClock | null = null;

/**
 * 全站共用的時鐘。對時結果與頁面同壽命，
 * 玩家從大廳走到遊戲畫面不需要重新量測。
 */
export function getServerClock(): ServerClock {
  shared ??= new ServerClock();
  return shared;
}
