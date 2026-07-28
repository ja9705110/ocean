"use client";

import { beatTimeMs, type RhythmConfig } from "@/lib/game/rhythm";

/**
 * 節拍聲（G1）。
 *
 * 節奏遊戲的節拍必須用聽的。只給視覺提示，人會盯著畫面而不是划槳，
 * 而且投影幕與手機之間的視線切換本身就會製造延遲。
 *
 * 排程方式是 WebAudio 的標準作法：用一個粗略的計時器每隔幾十毫秒醒來，
 * 把「接下來一小段時間內」的聲音預先排進音訊時鐘。直接在 setTimeout
 * 裡發聲會有幾十毫秒的抖動，那個抖動剛好落在判定窗的量級上。
 *
 * 聲音是即時合成的，沒有任何音檔——現場網路不好時，
 * 少一個要下載的資源就少一個開不了場的理由。
 */

interface AudioContextConstructor {
  new (): AudioContext;
}

function resolveAudioContext(): AudioContextConstructor | null {
  const scope = window as unknown as {
    AudioContext?: AudioContextConstructor;
    webkitAudioContext?: AudioContextConstructor;
  };
  return scope.AudioContext ?? scope.webkitAudioContext ?? null;
}

/** 排程器醒來的間隔 */
const TICK_MS = 40;
/** 每次醒來要往前排多久的聲音 */
const LOOKAHEAD_MS = 260;

export class Metronome {
  private ctx: AudioContext | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private nextBeat = 0;
  private anchorMs = 0;
  private config: RhythmConfig | null = null;
  private now: (() => number) | null = null;
  private volume = 0.9;

  /**
   * 建立並喚醒音訊。必須在使用者的點擊事件裡呼叫——
   * iOS 與多數瀏覽器只在使用者手勢中允許啟動音訊。
   */
  async enable(): Promise<boolean> {
    if (!this.ctx) {
      const Ctor = resolveAudioContext();
      if (!Ctor) {
        return false;
      }
      this.ctx = new Ctor();
    }

    if (this.ctx.state === "suspended") {
      try {
        await this.ctx.resume();
      } catch {
        return false;
      }
    }
    return this.ctx.state === "running";
  }

  get enabled(): boolean {
    return this.ctx?.state === "running";
  }

  setVolume(value: number): void {
    this.volume = Math.min(Math.max(value, 0), 1);
  }

  /**
   * 開始打拍。fromBeat 通常是負的前導拍，
   * 讓玩家在正式開始前就先聽到速度。
   */
  start(
    anchorMs: number,
    config: RhythmConfig,
    now: () => number,
    fromBeat: number,
  ): void {
    this.stop();
    this.anchorMs = anchorMs;
    this.config = config;
    this.now = now;
    this.nextBeat = fromBeat;
    this.timer = setInterval(() => {
      this.schedule();
    }, TICK_MS);
    this.schedule();
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  dispose(): void {
    this.stop();
    void this.ctx?.close().catch(() => undefined);
    this.ctx = null;
  }

  private schedule(): void {
    const ctx = this.ctx;
    const config = this.config;
    const now = this.now;

    if (!ctx || !config || !now || ctx.state !== "running") {
      return;
    }

    const serverMs = now();
    const horizon = serverMs + LOOKAHEAD_MS;

    while (this.nextBeat <= config.totalBeats) {
      const beatMs = beatTimeMs(this.nextBeat, this.anchorMs, config.bpm);
      if (beatMs > horizon) {
        break;
      }

      // 已經過去的拍就跳過，不要補打——遲到的鼓聲比沒有鼓聲更糟
      if (beatMs >= serverMs - 30) {
        // 容許的那 30 毫秒會讓排程時間落到 currentTime 之前，
        // WebAudio 對負數時間會直接丟例外，整個排程器就死了。
        const at = Math.max(
          ctx.currentTime,
          ctx.currentTime + (beatMs - serverMs) / 1000,
        );
        if (this.nextBeat < 0) {
          this.tick(ctx, at);
        } else {
          this.drum(ctx, at, this.nextBeat % 4 === 0);
        }
      }
      this.nextBeat += 1;
    }

    if (this.nextBeat > config.totalBeats) {
      this.stop();
    }
  }

  /** 前導拍：清脆的短音，明顯不同於正式的鼓聲 */
  private tick(ctx: AudioContext, at: number): void {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = "square";
    osc.frequency.setValueAtTime(1180, at);
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(0.16 * this.volume, at + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.06);

    osc.connect(gain).connect(ctx.destination);
    osc.start(at);
    osc.stop(at + 0.08);
  }

  /** 正式拍：低沉的鼓，音高下滑做出「咚」的感覺 */
  private drum(ctx: AudioContext, at: number, accent: boolean): void {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const peak = (accent ? 0.72 : 0.5) * this.volume;

    osc.type = "sine";
    osc.frequency.setValueAtTime(accent ? 210 : 170, at);
    osc.frequency.exponentialRampToValueAtTime(accent ? 82 : 70, at + 0.13);

    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(peak, at + 0.006);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.22);

    osc.connect(gain).connect(ctx.destination);
    osc.start(at);
    osc.stop(at + 0.26);
  }
}
