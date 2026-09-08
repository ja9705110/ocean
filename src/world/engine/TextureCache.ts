import { Assets, Texture } from "pixi.js";

/**
 * 角色貼圖的統一持有者。
 *
 * 大螢幕整晚不關機（規格第 16 節第 7 點），貼圖的載入與釋放
 * 必須集中管理：角色移除時經由這裡釋放，world 銷毀時全部清空，
 * 不允許散落在各處的 Texture 參照。
 */

/** 合成圖的長邊上限。跟單張角色一樣是 256，兩張疊起來也不該更吃記憶體 */
const COMPOSITE_MAX_SIDE = 256;

/** 下方那張圖佔的寬度比例，以及兩張之間的間距（相對於總高） */
const SECONDARY_WIDTH_RATIO = 0.82;
const GAP_RATIO = 0.06;

/** 合成貼圖的快取鍵。兩張圖的組合才是同一張貼圖 */
function compositeKey(primaryUrl: string, secondaryUrl: string): string {
  return `composite:${primaryUrl}|${secondaryUrl}`;
}

/** 圓形貼圖的邊長。跟單張角色一樣是 256。 */
const CIRCLE_SIDE = 256;

/**
 * 圓形外圈那一道邊的粗細與顏色。
 *
 * 照片是實心的，沒有這一圈的話它在深色河道上會像一塊貼紙。
 * 顏色跟主視覺的燙金同一組。
 */
const CIRCLE_RIM_RATIO = 0.022;
const CIRCLE_RIM_COLOR = "rgba(232, 201, 140, 0.55)";

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    // Storage 是另一個網域，不設這個的話畫進 canvas 會污染畫布
    image.crossOrigin = "anonymous";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`圖片載入失敗：${url}`));
    image.src = url;
  });
}

export class TextureCache {
  private readonly byUrl = new Map<string, Texture>();
  /** 合成貼圖不是 Assets 管的，要自己銷毀 */
  private readonly composites = new Map<string, Texture>();
  /** 圓形裁切的貼圖，同樣是自己畫的，要自己銷毀 */
  private readonly circles = new Map<string, Texture>();

  async load(url: string): Promise<Texture> {
    const cached = this.byUrl.get(url);
    if (cached) {
      return cached;
    }

    const texture = await Assets.load<Texture>({
      src: url,
      parser: "loadTextures",
    });
    this.byUrl.set(url, texture);
    return texture;
  }

  /**
   * 把兩張圖上下合成成一張貼圖。
   *
   * 為什麼是合成成一張，而不是給角色掛兩個 sprite：
   * 佈局引擎、避讓、進場動畫、抽獎的聚集都是以「一個角色一個 sprite」
   * 為前提寫的。多掛一個 sprite 等於要在那四個地方各補一次同步邏輯。
   * 合成成一張之後，下游全部不必知道這件事存在。
   *
   * 任何一張載入失敗就退回只用主圖：少一張簽名遠好過那個人整個不見。
   */
  async loadComposite(
    primaryUrl: string,
    secondaryUrl: string,
  ): Promise<Texture> {
    const key = compositeKey(primaryUrl, secondaryUrl);
    const cached = this.composites.get(key);
    if (cached) {
      return cached;
    }

    let primary: HTMLImageElement;
    let secondary: HTMLImageElement;
    try {
      [primary, secondary] = await Promise.all([
        loadImage(primaryUrl),
        loadImage(secondaryUrl),
      ]);
    } catch {
      return this.load(primaryUrl);
    }

    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return this.load(primaryUrl);
    }

    // 以主圖的寬為基準，第二張等比縮到指定寬度比例
    const width = Math.max(1, primary.width);
    const secondaryWidth = width * SECONDARY_WIDTH_RATIO;
    const secondaryHeight =
      secondary.width > 0
        ? (secondary.height / secondary.width) * secondaryWidth
        : 0;
    const gap = width * GAP_RATIO;
    const height = primary.height + gap + secondaryHeight;

    // 合成後可能超過單張的尺寸上限，等比縮回去
    const scale = Math.min(1, COMPOSITE_MAX_SIDE / Math.max(width, height));
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));

    ctx.scale(scale, scale);
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(primary, 0, 0, width, primary.height);
    ctx.drawImage(
      secondary,
      (width - secondaryWidth) / 2,
      primary.height + gap,
      secondaryWidth,
      secondaryHeight,
    );

    const texture = Texture.from(canvas);
    this.composites.set(key, texture);
    return texture;
  }

  /**
   * 把圖裁成圓形（C33）。
   *
   * 取中央的正方形再切圓——每一個頭像都是這樣做的，而且餅乾在上傳時
   * 已經被框在畫面正中央，中央那一塊就是餅乾本身。
   *
   * 「把整張 1:1.4 的照片塞進圓裡」是另一種做法，但那樣切出來的
   * 不是圓，是兩側被削掉的橢圓形，看起來像沒對齊。
   *
   * 載入失敗就退回原圖：一張方的照片遠好過那個人整個不見。
   */
  async loadCircle(url: string): Promise<Texture> {
    const key = `circle:${url}`;
    const cached = this.circles.get(key);
    if (cached) {
      return cached;
    }

    let image: HTMLImageElement;
    try {
      image = await loadImage(url);
    } catch {
      return this.load(url);
    }

    const canvas = document.createElement("canvas");
    canvas.width = CIRCLE_SIDE;
    canvas.height = CIRCLE_SIDE;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return this.load(url);
    }

    // 來源取中央的正方形
    const side = Math.min(image.width, image.height);
    const sourceX = (image.width - side) / 2;
    const sourceY = (image.height - side) / 2;

    const half = CIRCLE_SIDE / 2;
    ctx.save();
    ctx.beginPath();
    ctx.arc(half, half, half, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(image, sourceX, sourceY, side, side, 0, 0, CIRCLE_SIDE, CIRCLE_SIDE);
    ctx.restore();

    // 外圈。畫在 clip 之外，這樣線寬不會被切掉一半。
    const rim = CIRCLE_SIDE * CIRCLE_RIM_RATIO;
    ctx.strokeStyle = CIRCLE_RIM_COLOR;
    ctx.lineWidth = rim;
    ctx.beginPath();
    ctx.arc(half, half, half - rim / 2, 0, Math.PI * 2);
    ctx.stroke();

    const texture = Texture.from(canvas);
    this.circles.set(key, texture);
    return texture;
  }

  /** 依 CharacterData 的兩個 URL 取貼圖，沒有第二張就是單張 */
  async loadFor(
    primaryUrl: string,
    secondaryUrl?: string | null,
    circular?: boolean,
  ): Promise<Texture> {
    if (circular) {
      // 圓形只吃主圖：照片沒有「配一張簽名」這回事
      return this.loadCircle(primaryUrl);
    }
    if (secondaryUrl && secondaryUrl !== primaryUrl) {
      return this.loadComposite(primaryUrl, secondaryUrl);
    }
    return this.load(primaryUrl);
  }

  async release(url: string): Promise<void> {
    // 合成貼圖以主圖的 URL 為前綴，一併清掉，否則換圖之後舊的會留在記憶體
    for (const [key, texture] of this.composites) {
      if (key.includes(url)) {
        this.composites.delete(key);
        texture.destroy(true);
      }
    }

    const circle = this.circles.get(`circle:${url}`);
    if (circle) {
      this.circles.delete(`circle:${url}`);
      circle.destroy(true);
    }

    if (this.byUrl.delete(url)) {
      await Assets.unload(url);
    }
  }

  async destroy(): Promise<void> {
    for (const texture of this.composites.values()) {
      texture.destroy(true);
    }
    this.composites.clear();

    for (const texture of this.circles.values()) {
      texture.destroy(true);
    }
    this.circles.clear();

    const urls = [...this.byUrl.keys()];
    this.byUrl.clear();
    await Promise.allSettled(urls.map((url) => Assets.unload(url)));
  }
}
