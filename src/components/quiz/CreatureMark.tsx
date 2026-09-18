"use client";

import { useEffect, useRef } from "react";
import { findSymbol } from "@/lib/quiz/themes";

/**
 * 選項用的符號圖示。
 *
 * 直接畫在 canvas 上而不是輸出成圖檔：同一份向量定義在手機、大螢幕與
 * 主持人後台都用得上，換顏色只是換參數，而且投影到牆上也不會糊。
 */

interface CreatureMarkProps {
  /** 符號的 key。選項用主題裡的 creatureKey，隊伍用自己的生物。 */
  readonly creatureKey: string;
  readonly size: number;
  readonly color: string;
}

export function CreatureMark({ creatureKey, size, color }: CreatureMarkProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return;
    }

    // 投影機與高解析手機都要清晰，但超過兩倍就只是浪費記憶體
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(size * dpr);
    canvas.height = Math.round(size * dpr);

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);
    ctx.save();
    ctx.scale(size / 100, size / 100);
    findSymbol(creatureKey)?.draw(ctx, color);
    ctx.restore();
  }, [creatureKey, size, color]);

  return (
    <canvas
      ref={canvasRef}
      style={{ width: size, height: size }}
      className="block"
      aria-hidden
    />
  );
}
