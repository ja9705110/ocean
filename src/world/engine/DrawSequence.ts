import { gsap } from "gsap";
import type { Container, Sprite } from "pixi.js";
import type { CharacterSprite } from "./CharacterSprite";
import type { Point, Rect, WorldTemplate } from "@/world/types";

/**
 * 抽獎揭曉的動畫編排（規格第 11 節）：
 * 全體聚集 → 中獎者發光放大 → 其餘退散 → 鏡頭推近。
 *
 * 中獎者早已由資料庫決定，這裡純粹是演出。
 *
 * 效能（規格第 16 節第 6 點）：發光只對中獎者一人施加，
 * 且用 sprite 縮放與 alpha 疊加達成，不使用 PixiJS filter。
 */

export interface DrawSequenceHandle {
  /** 結束演出，所有角色回到常態行為 */
  finish(): void;
}

interface RunOptions {
  readonly template: WorldTemplate;
  readonly characters: readonly CharacterSprite[];
  readonly winnerId: string;
  readonly layer: Container;
  readonly bounds: Rect;
  /** 聚集完成、中獎者開始發光時呼叫，用於顯示姓名 */
  readonly onReveal: () => void;
  readonly onComplete: () => void;
}

/**
 * 播放整段演出。回傳的 handle 可提前結束（例如主持人切換到下一位）。
 * 演出期間所有參與角色的 entering 旗標為 true，常態行為暫停，
 * 位置完全交給時間軸控制。
 */
export function runDrawSequence(options: RunOptions): DrawSequenceHandle {
  const { template, characters, winnerId, layer, bounds, onReveal, onComplete } =
    options;

  // 中心偏上：下方要留給姓名文字，聚集的角色不該壓到那一區
  const center: Point = { x: bounds.width / 2, y: bounds.height * 0.38 };
  const winner = characters.find((c) => c.data.id === winnerId) ?? null;
  const others = characters.filter((c) => c.data.id !== winnerId);

  // 暫停常態行為：位置在演出期間由時間軸接管
  for (const character of characters) {
    character.entering = true;
  }

  const timeline = gsap.timeline({
    onComplete: () => {
      onComplete();
    },
  });

  // 1. 全體聚集
  const gatherSprites = others.map((c) => c.sprite);
  if (gatherSprites.length > 0) {
    timeline.add(template.gatherAnimation(gatherSprites, center), 0);
  }

  if (winner) {
    // 中獎者移到最上層，聚集動畫結束時停在正中央
    layer.setChildIndex(winner.sprite, layer.children.length - 1);

    timeline.to(
      winner.sprite.position,
      { x: center.x, y: center.y, duration: 1.8, ease: "power2.inOut" },
      0,
    );

    // 2. 其餘退散淡出，把視覺焦點讓給中獎者
    timeline.to(
      gatherSprites,
      { alpha: 0.12, duration: 0.9, ease: "power2.out" },
      1.7,
    );

    // 3. 中獎者放大發光。用縮放與 tint 取代 filter，避免 fps 崩掉
    const baseScale = winner.sprite.scale.x;
    timeline.to(
      winner.sprite,
      {
        alpha: 1,
        duration: 0.6,
        ease: "power2.out",
        onStart: onReveal,
      },
      1.9,
    );
    timeline.to(
      winner.sprite.scale,
      { x: baseScale * 2.6, y: baseScale * 2.6, duration: 1.4, ease: "back.out(1.4)" },
      1.9,
    );
    timeline.to(
      winner.sprite,
      { rotation: 0, duration: 1.4, ease: "power2.out" },
      1.9,
    );

    // 4. 揭曉後的持續呼吸，讓畫面不會定格死掉
    timeline.to(
      winner.sprite.scale,
      {
        x: baseScale * 2.75,
        y: baseScale * 2.75,
        duration: 1.6,
        ease: "sine.inOut",
        yoyo: true,
        repeat: -1,
      },
      3.4,
    );
  } else {
    // 中獎者的角色不在畫面上（極少數情況：剛好在對帳空窗期）
    timeline.call(onReveal, undefined, 1.9);
    timeline.to({}, { duration: 2.4 });
  }

  return {
    finish() {
      timeline.kill();
      for (const character of characters) {
        // 交還控制權：從 sprite 當前位置接手，避免瞬移
        character.finishEntrance();
        character.sprite.alpha = 1;
      }
      restoreScales(characters);
    },
  };
}

/** 演出結束後把縮放交回常態行為（下一幀 applySizing 會覆寫） */
function restoreScales(characters: readonly CharacterSprite[]): void {
  for (const character of characters) {
    const sprite: Sprite = character.sprite;
    gsap.killTweensOf(sprite);
    gsap.killTweensOf(sprite.scale);
    gsap.killTweensOf(sprite.position);
  }
}
