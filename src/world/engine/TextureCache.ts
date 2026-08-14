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

  /** 依 CharacterData 的兩個 URL 取貼圖，沒有第二張就是單張 */
  async loadFor(
    primaryUrl: string,
    secondaryUrl?: string | null,
  ): Promise<Texture> {
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

    if (this.byUrl.delete(url)) {
      await Assets.unload(url);
    }
  }

  async destroy(): Promise<void> {
    for (const texture of this.composites.values()) {
      texture.destroy(true);
    }
    this.composites.clear();

    const urls = [...this.byUrl.keys()];
    this.byUrl.clear();
    await Promise.allSettled(urls.map((url) => Assets.unload(url)));
  }
}
