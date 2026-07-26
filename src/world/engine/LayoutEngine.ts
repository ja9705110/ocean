import type { CharacterSprite } from "./CharacterSprite";
import type { Rect } from "@/world/types";

/**
 * 佈局引擎：同帶角色的軟性避讓（規格第 10 節）。
 *
 * - 只跟「同一帶」的鄰居互推：不同帶在視覺上是不同景深，重疊是正常的
 * - 空間網格做鄰居查詢，每幀重建（350 筆插入成本遠低於 O(n²) 兩兩比對）
 * - 軟性：距離小於期望間距時以線性衰減的力互相輕推，不是硬碰撞，
 *   推力刻意小，讓角色仍然是「游動中自然錯開」而不是彈開
 */

/** 每幀最大推移量相對於期望間距的比例，避免抖動 */
const PUSH_STRENGTH = 0.35;

export class LayoutEngine {
  /** 網格索引：key = 帶索引與格座標的複合鍵，value = characters 陣列索引 */
  private readonly grid = new Map<number, number[]>();

  /**
   * 對全體角色施加同帶避讓。
   * list 由呼叫端傳入以避免每幀配置新陣列；進場中的角色跳過。
   */
  apply(
    list: readonly CharacterSprite[],
    bounds: Rect,
    radiusOf: (character: CharacterSprite) => number,
    deltaSeconds: number,
  ): void {
    // 格子尺寸取當前最大角色直徑，保證鄰居必在相鄰九格內
    let maxRadius = 1;
    for (const character of list) {
      const radius = radiusOf(character);
      if (radius > maxRadius) {
        maxRadius = radius;
      }
    }
    const cellSize = maxRadius * 2;
    const columns = Math.max(1, Math.ceil(bounds.width / cellSize));

    this.grid.clear();

    // 建格
    for (let i = 0; i < list.length; i += 1) {
      const character = list[i];
      if (!character || character.entering) {
        continue;
      }
      const key = this.cellKey(character, cellSize, columns);
      const bucket = this.grid.get(key);
      if (bucket) {
        bucket.push(i);
      } else {
        this.grid.set(key, [i]);
      }
    }

    // 對每隻角色查相鄰九格的同帶鄰居
    const pushScale = Math.min(1, deltaSeconds * 60) * PUSH_STRENGTH;

    for (let i = 0; i < list.length; i += 1) {
      const a = list[i];
      if (!a || a.entering) {
        continue;
      }

      const radiusA = radiusOf(a);
      const gx = Math.floor(a.state.x / cellSize);
      const gy = Math.floor(a.state.y / cellSize);

      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const key = this.composeKey(a.state.bandIndex, gx + dx, gy + dy, columns);
          const bucket = this.grid.get(key);
          if (!bucket) {
            continue;
          }

          for (const j of bucket) {
            // 每對只處理一次（i < j），力對稱地施加在兩邊
            if (j <= i) {
              continue;
            }
            const b = list[j];
            if (!b) {
              continue;
            }

            const desired = (radiusA + radiusOf(b)) * 0.9;
            let diffX = a.state.x - b.state.x;
            let diffY = a.state.y - b.state.y;
            const distSq = diffX * diffX + diffY * diffY;

            if (distSq >= desired * desired) {
              continue;
            }

            let dist = Math.sqrt(distSq);
            if (dist < 0.01) {
              // 完全重疊時給一個隨機方向，避免除以零
              diffX = Math.random() - 0.5;
              diffY = Math.random() - 0.5;
              dist = Math.hypot(diffX, diffY);
            }

            const overlap = (desired - dist) / desired;
            const push = (overlap * desired * pushScale) / 2 / dist;

            a.state.x += diffX * push;
            a.state.y += diffY * push;
            b.state.x -= diffX * push;
            b.state.y -= diffY * push;
          }
        }
      }
    }
  }

  private cellKey(
    character: CharacterSprite,
    cellSize: number,
    columns: number,
  ): number {
    return this.composeKey(
      character.state.bandIndex,
      Math.floor(character.state.x / cellSize),
      Math.floor(character.state.y / cellSize),
      columns,
    );
  }

  private composeKey(
    bandIndex: number,
    gx: number,
    gy: number,
    columns: number,
  ): number {
    // gx 可能因迴繞落在畫面外一格，+2 平移保持非負
    return (bandIndex * 4096 + gy + 2) * (columns + 4) + gx + 2;
  }
}
