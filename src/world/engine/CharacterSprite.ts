import { Sprite } from "pixi.js";
import type { Texture } from "pixi.js";
import type {
  CharacterData,
  CharacterMotionState,
  LayoutBand,
  WorldFrameContext,
  WorldTemplate,
} from "@/world/types";

/**
 * 世界裡的單一角色：Pixi sprite ＋ 運動狀態。
 *
 * 角色的「怎麼動」完全委託給模板的 CharacterBehavior，
 * 這個類別只負責把狀態套用到 sprite、處理邊界迴繞與生命週期。
 */

/** 角色基準尺寸（css px），會再乘上帶縮放與人數縮放 */
const BASE_SIZE = 120;

/** 人數自適應：人越多整體越小，350 人時約 0.72 倍（規格第 10 節） */
export function populationScale(count: number): number {
  return Math.max(0.72, Math.min(1, 1.04 - count * 0.001));
}

export class CharacterSprite {
  readonly data: CharacterData;
  readonly sprite: Sprite;
  readonly state: CharacterMotionState;
  /** 貼圖原始最長邊換算成 BASE_SIZE 的縮放係數 */
  private baseScale: number;
  /** 進場動畫播放中為 true，此時不套用 behavior */
  entering = true;

  constructor(
    data: CharacterData,
    texture: Texture,
    bandIndex: number,
    band: LayoutBand,
  ) {
    this.data = data;
    this.sprite = new Sprite(texture);
    this.sprite.anchor.set(0.5);

    const maxDim = Math.max(texture.width, texture.height, 1);
    this.baseScale = BASE_SIZE / maxDim;

    this.state = {
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      rotation: 0,
      scale: 1,
      alpha: band.alpha,
      phase: Math.random() * Math.PI * 2,
      bandIndex,
    };
  }

  /** 依帶與人數重算實際縮放（人數改變時由 renderer 呼叫） */
  applySizing(band: LayoutBand, popScale: number): void {
    const flip = this.state.vx < 0 ? -1 : 1;
    const scale = this.baseScale * band.scale * popScale * this.state.scale;
    this.sprite.scale.set(scale * flip, scale);
  }

  /** 每幀：委託 behavior 更新狀態，處理迴繞，套用到 sprite */
  update(
    template: WorldTemplate,
    ctx: WorldFrameContext,
    popScale: number,
  ): void {
    if (this.entering) {
      return;
    }

    template.characterBehavior.update(this.state, ctx);

    // 邊界迴繞：游出一側就從另一側回來，世界永遠是滿的
    const margin = BASE_SIZE * ctx.band.scale;
    if (this.state.x > ctx.bounds.width + margin) {
      this.state.x = -margin;
    } else if (this.state.x < -margin) {
      this.state.x = ctx.bounds.width + margin;
    }

    this.sprite.position.set(this.state.x, this.state.y);
    this.sprite.rotation = this.state.rotation;
    this.sprite.alpha = this.state.alpha;
    this.applySizing(ctx.band, popScale);
  }

  /** 進場動畫結束：從 sprite 的實際位置接手，交給 behavior */
  finishEntrance(): void {
    this.state.x = this.sprite.position.x;
    this.state.y = this.sprite.position.y;
    this.entering = false;
  }

  destroy(): void {
    // 貼圖由 TextureCache 統一管理，這裡只銷毀 sprite 本身
    this.sprite.destroy({ children: true, texture: false });
  }
}
