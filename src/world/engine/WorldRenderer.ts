import { Application, Container } from "pixi.js";
import { gsap } from "gsap";
import { CharacterSprite, populationScale } from "./CharacterSprite";
import { TextureCache } from "./TextureCache";
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

/** 進場佇列的節流間隔（規格第 7 節：讓「游進來」看得清楚，也保護 fps） */
const DRAIN_INTERVAL_MS: Record<AddMode, number> = {
  initial: 45,
  entrance: 300,
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

  private backgroundLayer!: Container;
  private ambientLayer!: Container;
  private characterLayer!: Container;

  private queue: QueueItem[] = [];
  private drainTimerMs = 0;
  private nextBandIndex = 0;
  private elapsedSeconds = 0;
  private destroyed = false;

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
    renderer.buildLayers();
    app.ticker.add(() => renderer.tick());
    return renderer;
  }

  private buildLayers(): void {
    this.backgroundLayer = this.template.buildBackground(this.app);
    this.ambientLayer = this.template.buildAmbient(this.app);
    this.characterLayer = new Container();

    // 由後往前：背景 → 角色 → 環境裝飾（泡泡、光束疊在角色前面才有層次）
    this.app.stage.addChild(this.backgroundLayer);
    this.app.stage.addChild(this.characterLayer);
    this.app.stage.addChild(this.ambientLayer);
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

    const deltaSeconds = this.app.ticker.deltaMS / 1000;
    this.elapsedSeconds += deltaSeconds;

    this.drainQueue();

    const bounds = this.bounds;
    const popScale = populationScale(this.characters.size);

    for (const character of this.characters.values()) {
      const band = this.bandOf(character.state.bandIndex);
      const ctx: WorldFrameContext = {
        deltaSeconds,
        elapsedSeconds: this.elapsedSeconds,
        bounds,
        band,
      };
      character.update(this.template, ctx, popScale);
    }
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
      return;
    }

    this.drainTimerMs += this.app.ticker.deltaMS;
    if (this.drainTimerMs < DRAIN_INTERVAL_MS[head.mode]) {
      return;
    }

    this.drainTimerMs = 0;
    this.queue.shift();
    void this.spawn(head.data, head.mode);
  }

  private async spawn(data: CharacterData, mode: AddMode): Promise<void> {
    try {
      const texture = await this.textures.load(data.imageUrl);
      if (this.destroyed || this.characters.has(data.id)) {
        return;
      }

      const bandIndex = this.nextBandIndex;
      this.nextBandIndex = (this.nextBandIndex + 1) % this.template.bands.length;
      const band = this.bandOf(bandIndex);
      const bounds = this.bounds;

      const character = new CharacterSprite(data, texture, bandIndex, band);

      // 初始化運動狀態（行為在 init 裡賦予個體差異）
      const ctx: WorldFrameContext = {
        deltaSeconds: 0,
        elapsedSeconds: this.elapsedSeconds,
        bounds,
        band,
      };
      this.template.characterBehavior.init(character.state, ctx);

      // 目標位置：帶內隨機
      const bandTop = band.top * bounds.height;
      const bandBottom = band.bottom * bounds.height;
      character.state.x = Math.random() * bounds.width;
      character.state.y = bandTop + Math.random() * (bandBottom - bandTop);

      character.sprite.position.set(character.state.x, character.state.y);
      character.applySizing(band, populationScale(this.characters.size + 1));
      this.characters.set(data.id, character);
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

    for (const timeline of this.timelines) {
      timeline.kill();
    }
    this.timelines.clear();

    for (const character of this.characters.values()) {
      character.destroy();
    }
    this.characters.clear();
    this.queue = [];

    // template 建立的容器在 destroy 時透過各自的 destroyed 事件清理 gsap
    this.app.destroy(
      { removeView: true },
      { children: true, texture: true },
    );
    void this.textures.destroy();
  }
}
