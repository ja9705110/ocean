import { Application, Container, UPDATE_PRIORITY } from "pixi.js";
import { gsap } from "gsap";
import { CharacterSprite, populationScale } from "./CharacterSprite";
import { LayoutEngine } from "./LayoutEngine";
import { TextureCache } from "./TextureCache";
import { runDrawSequence } from "./DrawSequence";
import type { DrawSequenceHandle } from "./DrawSequence";
import type {
  CharacterData,
  LayoutBand,
  Rect,
  WorldFrameContext,
  WorldTemplate,
} from "@/world/types";

/**
 * 世界渲染器：PixiJS Application 的生命週期與角色管理。
 *
 * 這一層不認識「海洋」，所有視覺與行為都來自注入的 WorldTemplate。
 * 也不認識 Supabase——資料以 CharacterData 餵入，M5 的壓力測試
 * 靠這一點用假資料離線跑。
 */

/** 角色進場方式：初始全量載入用快速淡入，之後的新角色用完整進場動畫 */
export type AddMode = "initial" | "entrance";

/**
 * 進場佇列的節流間隔（規格第 7 節：讓「游進來」看得清楚，也保護 fps）。
 *
 * initial 只是還原既有世界，不需要演出感，間隔取小值；
 * entrance 是新角色游進來的重頭戲，必須看得清楚。
 */
const DRAIN_INTERVAL_MS: Record<AddMode, number> = {
  initial: 12,
  entrance: 300,
};

/** 單幀最多放行幾隻，避免低 fps 時佇列排到天荒地老 */
const MAX_DRAIN_PER_TICK: Record<AddMode, number> = {
  initial: 8,
  entrance: 1,
};

interface QueueItem {
  readonly data: CharacterData;
  readonly mode: AddMode;
}

export class WorldRenderer {
  private readonly app: Application;
  private readonly template: WorldTemplate;
  private readonly textures = new TextureCache();
  private readonly characters = new Map<string, CharacterSprite>();
  private readonly timelines = new Set<gsap.core.Timeline>();
  private readonly layout = new LayoutEngine();

  /** 每幀重用的角色清單，避免高頻配置（350 隻時的 GC 壓力） */
  private characterList: CharacterSprite[] = [];
  private characterListDirty = true;

  /** 效能統計：update 耗時的滾動平均（毫秒），壓力測試模式讀取 */
  private updateMsAverage = 0;

  /**
   * WebGL context 是否已遺失。大螢幕整晚運行時驅動程式可能重置 context，
   * 一旦發生畫面會靜止但程式毫無異狀——必須被觀測到才能處理。
   */
  private contextLost = false;

  /** 進行中的抽獎演出 */
  private drawSequence: DrawSequenceHandle | null = null;

  private backgroundLayer!: Container;
  private ambientLayer!: Container;
  private characterLayer!: Container;

  /**
   * 已經換下來、等著下一幀銷毀的舊圖層（見 rebuildEnvironment）。
   * 當場銷毀會讓 Pixi 在下一次 render 綁到一張已釋放的貼圖。
   */
  private staleLayers: Container[] = [];

  private queue: QueueItem[] = [];
  private drainTimerMs = 0;
  private nextBandIndex = 0;
  private elapsedSeconds = 0;
  private destroyed = false;

  /**
   * 速度倍率，由主持人在後台調整。
   *
   * 放在渲染器而不是模板：模板是一份不可變的描述，
   * 而這個值要能在活動進行中被改掉，且改了立刻生效。
   */
  private speedScale = 1;

  private constructor(app: Application, template: WorldTemplate) {
    this.app = app;
    this.template = template;
  }

  static async create(
    host: HTMLElement,
    template: WorldTemplate,
  ): Promise<WorldRenderer> {
    const app = new Application();
    await app.init({
      resizeTo: host,
      backgroundAlpha: 0,
      antialias: true,
      resolution: Math.min(window.devicePixelRatio || 1, 2),
      autoDensity: true,
    });
    host.appendChild(app.canvas);

    const renderer = new WorldRenderer(app, template);
    renderer.watchContextLoss(app.canvas);
    renderer.buildLayers();
    app.ticker.add(() => renderer.tick());
    // 換下來的舊圖層要在「這一幀畫完之後」才收。Application 的 render
    // 掛在 LOW，UTILITY 比它更低，所以這一個一定排在 render 後面。
    // 提前收的話，這一幀的繪製指令裡還指著那些 sprite，
    // 而它們的貼圖已經是 null 了。
    app.ticker.add(
      () => renderer.disposeStaleLayers(),
      undefined,
      UPDATE_PRIORITY.UTILITY,
    );
    return renderer;
  }

  private watchContextLoss(canvas: HTMLCanvasElement): void {
    canvas.addEventListener("webglcontextlost", () => {
      this.contextLost = true;
    });
    canvas.addEventListener("webglcontextrestored", () => {
      this.contextLost = false;
    });
  }

  private buildLayers(): void {
    this.backgroundLayer = this.template.buildBackground(this.app);
    this.ambientLayer = this.template.buildAmbient(this.app);
    this.characterLayer = new Container();

    // 由後往前：背景 →（環境）→ 角色 →（環境）
    //
    // 泡泡疊在角色前面才有前後層次，那是海洋要的；河流的光粒很亮，
    // 蓋在簽名上名字就讀不出來，所以那邊把環境層放到角色底下。
    this.app.stage.addChild(this.backgroundLayer);
    if (this.template.ambientBelowCharacters) {
      this.app.stage.addChild(this.ambientLayer);
      this.app.stage.addChild(this.characterLayer);
    } else {
      this.app.stage.addChild(this.characterLayer);
      this.app.stage.addChild(this.ambientLayer);
    }
  }

  get bounds(): Rect {
    return {
      x: 0,
      y: 0,
      width: this.app.screen.width,
      height: this.app.screen.height,
    };
  }

  get characterCount(): number {
    return this.characters.size;
  }

  /**
   * 隱藏／顯示程式繪製的背景層。
   *
   * 主持人上傳自己的主視覺當背景時整層關掉：Pixi 的畫布本來就是透明的
   * （backgroundAlpha: 0），關掉之後墊在畫布下面的那張圖就會透出來，
   * 環境光粒與角色照樣在上面跑。
   */
  setBackgroundVisible(visible: boolean): void {
    this.backgroundLayer.visible = visible;
  }

  /**
   * 隱藏／顯示環境裝飾層（泡泡、光粒）。
   *
   * 主持人改用自己的主視覺當底圖時要關掉：這些裝飾是沿著模板自己那條
   * 河道跑的，疊在別人的構圖上位置就不對了。
   */
  setAmbientVisible(visible: boolean): void {
    this.ambientLayer.visible = visible;
  }

  /**
   * 隱藏／顯示角色層。
   *
   * 餅乾馬賽克那一段要用：餅乾就是河的內容，簽名同時在河上只會互相蓋住。
   * 但不能整個畫布藏起來——那樣連河都一起不見了，畫面只剩黑底。
   */
  setCharactersVisible(visible: boolean): void {
    this.characterLayer.visible = visible;
  }

  /**
   * 重建背景與環境裝飾層。
   *
   * 主持人改河道形狀時要用。背景在建立時就烘成貼圖了（那是輝光零成本的
   * 前提），環境光粒的偏移函式也是建立時決定的，所以形狀改了非重建不可。
   *
   * 角色層刻意不動：重建整個世界會讓所有簽名重新進場一次，
   * 而主持人拉一次滑桿不該把現場已經在流的名字全部重播。
   *
   * 順序很講究，兩件事都是踩過才知道的：
   *
   * 1. 先建新的，再拆舊的。buildBackground 裡的 generateTexture 會當場
   *    跑一次繪製，那時候舊貼圖必須還活著。
   * 2. 舊圖層不能當場銷毀，要等下一幀。這一幀的批次繪製裡還握著它們的
   *    貼圖參照，提前釋放的話下一次 render 會去綁一張已經沒有內容的貼圖，
   *    Pixi 會丟 TypeError: Cannot read properties of null (reading '0')，
   *    而畫面看起來一切正常——只有 console 裡有一行紅字。
   */
  rebuildEnvironment(): void {
    if (this.destroyed) {
      return;
    }

    const stale = [this.backgroundLayer, this.ambientLayer];
    const backgroundVisible = this.backgroundLayer.visible;
    const ambientVisible = this.ambientLayer.visible;

    this.backgroundLayer = this.template.buildBackground(this.app);
    this.ambientLayer = this.template.buildAmbient(this.app);
    this.backgroundLayer.visible = backgroundVisible;
    this.ambientLayer.visible = ambientVisible;

    for (const layer of stale) {
      this.app.stage.removeChild(layer);
      this.staleLayers.push(layer);
    }

    // 層序要維持「背景 → 角色 → 環境」：addChild 會加到最上面，
    // 所以背景加完之後要明確搬回底層，否則會蓋住所有簽名
    this.app.stage.addChild(this.backgroundLayer);
    this.app.stage.addChild(this.ambientLayer);
    this.app.stage.setChildIndex(this.backgroundLayer, 0);
    this.app.stage.setChildIndex(
      this.ambientLayer,
      this.template.ambientBelowCharacters
        ? 1
        : this.app.stage.children.length - 1,
    );
  }

  /**
   * 收掉換下來的舊圖層。掛在 UTILITY 優先度，也就是每一幀 render 之後。
   *
   * 這個時序是必要的，不是保險：Pixi 的繪製指令是在 render 時才依場景
   * 重建的，在那之前指令裡還握著舊的 sprite。先銷毀就會在下一次 render
   * 讀到一張已經沒有內容的貼圖，丟出
   * TypeError: Cannot read properties of null (reading '0')。
   */
  private disposeStaleLayers(): void {
    if (this.staleLayers.length === 0) {
      return;
    }
    for (const layer of this.staleLayers) {
      if (!layer.destroyed) {
        layer.destroy({ children: true });
      }
    }
    this.staleLayers = [];
  }

  /** 調整整個世界的速度。1 是模板原速。 */
  setSpeedScale(value: number): void {
    this.speedScale = Number.isFinite(value) && value > 0 ? value : 1;
    // 環境層拿不到每幀的 context，只能由這裡通知
    this.template.onSpeedScaleChange?.(this.speedScale);
  }

  /**
   * 播放抽獎揭曉演出。回傳結束用的 handle；
   * 若已有演出進行中會先結束它（主持人連續按下一位的情況）。
   */
  playDrawSequence(
    winnerId: string,
    onReveal: () => void,
    onComplete: () => void,
  ): { finish(): void } | null {
    if (this.destroyed) {
      return null;
    }

    this.drawSequence?.finish();

    const handle = runDrawSequence({
      template: this.template,
      characters: [...this.characters.values()],
      winnerId,
      layer: this.characterLayer,
      bounds: this.bounds,
      onReveal,
      onComplete,
    });

    this.drawSequence = handle;
    return handle;
  }

  /** 結束演出，角色回到常態游動 */
  endDrawSequence(): void {
    this.drawSequence?.finish();
    this.drawSequence = null;
  }

  /** 效能統計。壓力測試模式的 HUD 每秒讀一次 */
  get stats(): {
    fps: number;
    updateMs: number;
    loaded: number;
    pending: number;
    contextLost: boolean;
  } {
    return {
      fps: Math.round(this.app.ticker.FPS),
      updateMs: this.updateMsAverage,
      loaded: this.characters.size,
      pending: this.queue.length,
      contextLost: this.contextLost,
    };
  }

  /** 把角色排入進場佇列（同 id 重複加入會被忽略，對帳時可整批重丟） */
  enqueue(data: CharacterData, mode: AddMode): void {
    if (this.destroyed || this.characters.has(data.id)) {
      return;
    }
    if (this.queue.some((item) => item.data.id === data.id)) {
      return;
    }
    this.queue.push({ data, mode });
  }

  /** 主持人隱藏角色時即時移除（也會從等待中的佇列剔除） */
  remove(id: string): void {
    this.queue = this.queue.filter((item) => item.data.id !== id);

    const character = this.characters.get(id);
    if (!character) {
      return;
    }

    this.characters.delete(id);
    this.characterListDirty = true;
    const url = character.data.imageUrl;
    character.destroy();
    void this.textures.release(url);
  }

  /**
   * 全量對帳：以後端回傳的完整清單為準，補上缺少的、移除多出的。
   * 初始載入與斷線重連後都走這裡（規格第 7 節：重連必須重新對帳）。
   */
  reconcile(list: readonly CharacterData[], mode: AddMode): void {
    const validIds = new Set(list.map((item) => item.id));

    for (const id of [...this.characters.keys()]) {
      if (!validIds.has(id)) {
        this.remove(id);
      }
    }
    this.queue = this.queue.filter((item) => validIds.has(item.data.id));

    for (const data of list) {
      this.enqueue(data, mode);
    }
  }

  private tick(): void {
    if (this.destroyed) {
      return;
    }

    const startMs = performance.now();
    const deltaSeconds = this.app.ticker.deltaMS / 1000;
    this.elapsedSeconds += deltaSeconds;

    this.drainQueue();

    const bounds = this.bounds;
    const popScale = populationScale(this.characters.size);

    if (this.characterListDirty) {
      this.characterList = [...this.characters.values()];
      this.characterListDirty = false;
    }

    for (const character of this.characterList) {
      const band = this.bandOf(character.state.bandIndex);
      const ctx: WorldFrameContext = {
        deltaSeconds,
        elapsedSeconds: this.elapsedSeconds,
        bounds,
        band,
        radius: character.radius(band, popScale),
        speedScale: this.speedScale,
      };
      character.update(this.template, ctx, popScale);
    }

    // 軟性避讓：行為更新完後，同帶鄰居互相輕推（規格第 10 節）
    this.layout.apply(
      this.characterList,
      bounds,
      (character) =>
        character.radius(this.bandOf(character.state.bandIndex), popScale),
      deltaSeconds,
    );

    // update 耗時的指數滾動平均
    const elapsed = performance.now() - startMs;
    this.updateMsAverage = this.updateMsAverage * 0.95 + elapsed * 0.05;
  }

  private bandOf(index: number): LayoutBand {
    const band = this.template.bands[index] ?? this.template.bands[0];
    if (!band) {
      throw new Error(`模板 ${this.template.key} 沒有定義任何佈局帶`);
    }
    return band;
  }

  private drainQueue(): void {
    const head = this.queue[0];
    if (!head) {
      this.drainTimerMs = 0;
      return;
    }

    this.drainTimerMs += this.app.ticker.deltaMS;

    const interval = DRAIN_INTERVAL_MS[head.mode];
    if (this.drainTimerMs < interval) {
      return;
    }

    // 幀率低時單幀累積了多個間隔，一次補放多隻，
    // 否則 350 隻的初始還原會被幀率拖成好幾十秒
    const due = Math.min(
      Math.floor(this.drainTimerMs / interval),
      MAX_DRAIN_PER_TICK[head.mode],
    );
    this.drainTimerMs = 0;

    for (let i = 0; i < due; i += 1) {
      const item = this.queue[0];
      // 模式不同的項目不可在同一批放行，節流語意會被破壞
      if (!item || item.mode !== head.mode) {
        break;
      }
      this.queue.shift();
      void this.spawn(item.data, item.mode);
    }
  }

  private async spawn(data: CharacterData, mode: AddMode): Promise<void> {
    try {
      const texture = await this.textures.loadFor(
        data.imageUrl,
        data.secondaryImageUrl,
      );
      if (this.destroyed || this.characters.has(data.id)) {
        return;
      }

      const bandIndex = this.nextBandIndex;
      this.nextBandIndex = (this.nextBandIndex + 1) % this.template.bands.length;
      const band = this.bandOf(bandIndex);
      const bounds = this.bounds;

      const character = new CharacterSprite(data, texture, bandIndex, band);

      // 初始化運動狀態（行為在 init 裡賦予個體差異）
      const popScale = populationScale(this.characters.size + 1);
      const radius = character.radius(band, popScale);
      const ctx: WorldFrameContext = {
        deltaSeconds: 0,
        elapsedSeconds: this.elapsedSeconds,
        bounds,
        band,
        radius,
        speedScale: this.speedScale,
      };
      this.template.characterBehavior.init(character.state, ctx);

      // 目標位置：帶內隨機，且完整落在畫面框內
      const bandTop = band.top * bounds.height;
      const bandBottom = band.bottom * bounds.height;
      character.state.x =
        radius + Math.random() * Math.max(1, bounds.width - radius * 2);
      character.state.y = bandTop + Math.random() * (bandBottom - bandTop);

      character.sprite.position.set(character.state.x, character.state.y);
      character.applySizing(band, popScale);
      this.characters.set(data.id, character);
      this.characterListDirty = true;
      this.characterLayer.addChild(character.sprite);

      if (mode === "entrance") {
        const timeline = this.template.entrance(character.sprite, bounds);
        this.trackTimeline(timeline);
        timeline.eventCallback("onComplete", () => {
          this.timelines.delete(timeline);
          character.finishEntrance();
        });
      } else {
        // 初始全量載入：短促淡入即可，重整大螢幕不必等 350 段進場動畫
        character.sprite.alpha = 0;
        const timeline = gsap.timeline();
        this.trackTimeline(timeline);
        timeline.to(character.sprite, {
          alpha: band.alpha,
          duration: 0.6,
          ease: "power1.out",
          onComplete: () => {
            this.timelines.delete(timeline);
            character.finishEntrance();
          },
        });
      }
    } catch {
      // 單張圖載入失敗不能中斷整個世界；M4 對帳時會再補
    }
  }

  private trackTimeline(timeline: gsap.core.Timeline): void {
    this.timelines.add(timeline);
  }

  destroy(): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;

    this.drawSequence?.finish();
    this.drawSequence = null;

    for (const timeline of this.timelines) {
      timeline.kill();
    }
    this.timelines.clear();

    for (const character of this.characters.values()) {
      character.destroy();
    }
    this.characters.clear();
    this.queue = [];

    // 已經移出舞台的舊圖層 app.destroy 收不到，要自己收
    this.disposeStaleLayers();

    // template 建立的容器在 destroy 時透過各自的 destroyed 事件清理 gsap
    this.app.destroy(
      { removeView: true },
      { children: true, texture: true },
    );
    void this.textures.destroy();
  }
}
