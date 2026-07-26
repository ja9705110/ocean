import { Assets } from "pixi.js";
import type { Texture } from "pixi.js";

/**
 * 角色貼圖的統一持有者。
 *
 * 大螢幕整晚不關機（規格第 16 節第 7 點），貼圖的載入與釋放
 * 必須集中管理：角色移除時經由這裡釋放，world 銷毀時全部清空，
 * 不允許散落在各處的 Texture 參照。
 */
export class TextureCache {
  private readonly byUrl = new Map<string, Texture>();

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

  async release(url: string): Promise<void> {
    if (this.byUrl.delete(url)) {
      await Assets.unload(url);
    }
  }

  async destroy(): Promise<void> {
    const urls = [...this.byUrl.keys()];
    this.byUrl.clear();
    await Promise.allSettled(urls.map((url) => Assets.unload(url)));
  }
}
