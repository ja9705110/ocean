"use client";

/**
 * 划船音效（G1c）。
 *
 * 全部即時合成，沒有任何音檔——現場網路不好時，
 * 少一個要下載的資源就少一個開不了場的理由，
 * 而且三百多支手機同時抓同一個檔案本身就是個問題。
 *
 * 聲音分三層：
 * 1. 水聲底噪：持續播放，音量與亮度隨划速上升。這是「速度感」的來源，
 *    比任何數字都直接。
 * 2. 每一划的槳聲：入水的悶響加上濺起的水花。
 * 3. 倒數、起跑、結束的提示音。
 *
 * 兩個現場一定會遇到的限制：
 * - 音訊只能在使用者手勢裡啟動，所以 enable() 一定要在按鈕的
 *   click 處理裡呼叫，錯過就沒有第二次機會。
 * - iPhone 的實體靜音鍵會把網頁音訊整個關掉，網頁端無法偵測也無法繞過。
 *   介面上必須提醒玩家關掉靜音。
 */

interface AudioContextConstructor {
  new (): AudioContext;
}

function resolveAudioContext(): AudioContextConstructor | null {
  if (typeof window === "undefined") {
    return null;
  }
  const scope = window as unknown as {
    AudioContext?: AudioContextConstructor;
    webkitAudioContext?: AudioContextConstructor;
  };
  return scope.AudioContext ?? scope.webkitAudioContext ?? null;
}

/** 底噪的緩衝長度。夠長才聽不出循環接點。 */
const NOISE_SECONDS = 2.5;

/** 音量變化的平滑時間。突然變大聲會像爆音。 */
const RAMP_SECONDS = 0.25;

export class RowingAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private ambienceSource: AudioBufferSourceNode | null = null;
  private ambienceGain: GainNode | null = null;
  private ambienceFilter: BiquadFilterNode | null = null;
  private muted = false;

  get enabled(): boolean {
    return this.ctx?.state === "running";
  }

  get isMuted(): boolean {
    return this.muted;
  }

  /**
   * 建立並喚醒音訊。必須在使用者的點擊事件裡呼叫。
   * 回傳 false 代表這台裝置或這個瀏覽器不給播。
   */
  async enable(): Promise<boolean> {
    if (!this.ctx) {
      const Ctor = resolveAudioContext();
      if (!Ctor) {
        return false;
      }
      this.ctx = new Ctor();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : 1;
      this.master.connect(this.ctx.destination);
      this.noise = this.createNoise(this.ctx);
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

  setMuted(muted: boolean): void {
    this.muted = muted;
    const ctx = this.ctx;
    const master = this.master;
    if (ctx && master) {
      master.gain.setTargetAtTime(muted ? 0 : 1, ctx.currentTime, 0.05);
    }
  }

  /** 白噪音緩衝，水聲與濺水都由它濾出來 */
  private createNoise(ctx: AudioContext): AudioBuffer {
    const length = Math.floor(ctx.sampleRate * NOISE_SECONDS);
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i += 1) {
      data[i] = Math.random() * 2 - 1;
    }
    return buffer;
  }

  /**
   * 開始播放水聲底噪。level 為 0~1 的划速強度，之後用 setAmbience 更新。
   */
  startAmbience(): void {
    const ctx = this.ctx;
    const master = this.master;
    const noise = this.noise;
    if (!ctx || !master || !noise || this.ambienceSource) {
      return;
    }

    const source = ctx.createBufferSource();
    source.buffer = noise;
    source.loop = true;

    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 420;
    filter.Q.value = 0.4;

    const gain = ctx.createGain();
    gain.gain.value = 0.0001;

    source.connect(filter).connect(gain).connect(master);
    source.start();

    this.ambienceSource = source;
    this.ambienceFilter = filter;
    this.ambienceGain = gain;
  }

  /** 更新水聲。划得越快，越大聲也越亮——那就是速度感。 */
  setAmbience(level: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.ambienceGain || !this.ambienceFilter) {
      return;
    }
    const clamped = Math.min(Math.max(level, 0), 1);
    this.ambienceGain.gain.setTargetAtTime(
      0.02 + clamped * 0.13,
      ctx.currentTime,
      RAMP_SECONDS,
    );
    this.ambienceFilter.frequency.setTargetAtTime(
      420 + clamped * 1900,
      ctx.currentTime,
      RAMP_SECONDS,
    );
  }

  stopAmbience(): void {
    const source = this.ambienceSource;
    if (source) {
      try {
        source.stop();
      } catch {
        // 已經停過就算了
      }
      this.ambienceSource = null;
      this.ambienceGain = null;
      this.ambienceFilter = null;
    }
  }

  /**
   * 一次划槳：低頻的入水悶響 + 高頻的濺水。
   * 兩層疊起來才像槳，只有其中一層聽起來會像敲桌子或沙沙聲。
   */
  stroke(intensity: number): void {
    const ctx = this.ctx;
    const master = this.master;
    const noise = this.noise;
    if (!ctx || !master || !noise || ctx.state !== "running") {
      return;
    }

    const power = Math.min(Math.max(intensity, 0), 1);
    const at = ctx.currentTime;

    // 入水
    const thump = ctx.createOscillator();
    const thumpGain = ctx.createGain();
    thump.type = "sine";
    thump.frequency.setValueAtTime(150 + power * 40, at);
    thump.frequency.exponentialRampToValueAtTime(58, at + 0.12);
    thumpGain.gain.setValueAtTime(0.0001, at);
    thumpGain.gain.exponentialRampToValueAtTime(0.22 + power * 0.2, at + 0.008);
    thumpGain.gain.exponentialRampToValueAtTime(0.0001, at + 0.2);
    thump.connect(thumpGain).connect(master);
    thump.start(at);
    thump.stop(at + 0.24);

    // 濺水
    const splash = ctx.createBufferSource();
    splash.buffer = noise;
    // 每次從噪音的不同位置切一段，聽起來才不會每下都一模一樣
    const offset = Math.random() * (NOISE_SECONDS - 0.4);

    const band = ctx.createBiquadFilter();
    band.type = "bandpass";
    band.frequency.setValueAtTime(1100 + power * 900, at);
    band.frequency.exponentialRampToValueAtTime(2600 + power * 1200, at + 0.16);
    band.Q.value = 0.9;

    const splashGain = ctx.createGain();
    splashGain.gain.setValueAtTime(0.0001, at);
    splashGain.gain.exponentialRampToValueAtTime(0.09 + power * 0.14, at + 0.012);
    splashGain.gain.exponentialRampToValueAtTime(0.0001, at + 0.26);

    splash.connect(band).connect(splashGain).connect(master);
    splash.start(at, offset, 0.32);
  }

  /** 倒數。最後一下的音高不同，人才知道就是現在。 */
  countdown(final: boolean): void {
    this.tone(final ? 1180 : 720, final ? 0.34 : 0.09, final ? 0.3 : 0.18);
  }

  /** 起跑號角 */
  start(): void {
    this.tone(392, 0.5, 0.22, "sawtooth");
    this.tone(588, 0.5, 0.14, "sawtooth", 0.04);
  }

  /** 結束：往上跑的三個音，收尾要讓人想再玩一次 */
  finish(): void {
    this.tone(523, 0.18, 0.2);
    this.tone(659, 0.18, 0.2, "triangle", 0.16);
    this.tone(784, 0.5, 0.24, "triangle", 0.32);
  }

  /** 划到一半放開手的警示 */
  gripLost(): void {
    this.tone(220, 0.3, 0.18, "square");
  }

  private tone(
    frequency: number,
    duration: number,
    peak: number,
    type: OscillatorType = "triangle",
    delay = 0,
  ): void {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master || ctx.state !== "running") {
      return;
    }

    const at = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = type;
    osc.frequency.setValueAtTime(frequency, at);
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(peak, at + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + duration);

    osc.connect(gain).connect(master);
    osc.start(at);
    osc.stop(at + duration + 0.05);
  }

  dispose(): void {
    this.stopAmbience();
    const ctx = this.ctx;
    this.ctx = null;
    this.master = null;
    this.noise = null;
    void ctx?.close().catch(() => undefined);
  }
}
