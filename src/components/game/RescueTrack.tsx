"use client";

import { useEffect, useRef } from "react";
import { drawCat } from "@/lib/creatures/cat";
import { findCreature, OCEAN_CREATURES } from "@/lib/creatures/ocean";

/**
 * 救援航道（手機端預覽）。
 *
 * 大螢幕上每一隊都有一條這樣的航道，海洋生物從左邊游向右邊的貓。
 * 手機上放一條自己的，是為了讓玩家在划的當下就看到「我划得越快牠游得越快」——
 * 那個因果關係要在第一秒就成立，遊戲才會讓人想繼續。
 *
 * 這裡用 Canvas2D 而不是 PixiJS：手機上只有一隻生物在動，
 * 為了這個載入整套渲染引擎不划算，也會排擠到感應器的效能。
 */

interface RescueTrackProps {
  /** 海洋生物的 key；找不到就用第一個 */
  readonly creatureKey: string;
  readonly color: string;
  /** 0~1，航道上的位置 */
  readonly progress: number;
  /** 0~1，划速強度，用來決定擺尾與水花的劇烈程度 */
  readonly intensity: number;
}

const HEIGHT = 96;

export function RescueTrack({
  creatureKey,
  color,
  progress,
  intensity,
}: RescueTrackProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // 每幀都會讀，走 ref 而不是相依陣列，動畫迴圈才不必因為數字變了就重建
  const stateRef = useRef({ progress, intensity });
  useEffect(() => {
    stateRef.current = { progress, intensity };
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return;
    }

    const creature = findCreature(creatureKey) ?? OCEAN_CREATURES[0];
    let raf = 0;
    let width = 0;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    const resize = () => {
      width = canvas.clientWidth;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(HEIGHT * dpr);
    };

    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);

    const frame = (t: number) => {
      raf = requestAnimationFrame(frame);
      const { progress: p, intensity: power } = stateRef.current;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, HEIGHT);

      // 水線
      ctx.strokeStyle = "rgba(120, 150, 180, 0.22)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = 0; x <= width; x += 4) {
        const y =
          HEIGHT * 0.74 +
          Math.sin(x * 0.05 + t * 0.004) * (1.5 + power * 2.5);
        if (x === 0) {
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }
      }
      ctx.stroke();

      // 終點的貓
      const catSize = 46;
      ctx.save();
      ctx.translate(width - catSize - 4, HEIGHT - catSize - 6);
      ctx.scale(catSize / 100, catSize / 100);
      drawCat(ctx);
      ctx.restore();

      // 海洋生物
      const travel = 8 + (width - catSize - 44) * Math.min(Math.max(p, 0), 1);
      const size = 40;
      const bob = Math.sin(t * 0.006 * (0.6 + power * 2)) * (2 + power * 4);

      ctx.save();
      ctx.translate(travel, HEIGHT * 0.5 + bob - size / 2);
      ctx.scale(size / 100, size / 100);
      if (creature) {
        creature.draw(ctx, color);
      }
      ctx.restore();

      // 水花：划得越快尾流越明顯
      if (power > 0.05) {
        ctx.fillStyle = `rgba(160, 210, 230, ${0.1 + power * 0.35})`;
        for (let i = 0; i < 3; i += 1) {
          const offset = ((t * 0.06 * (0.5 + power) + i * 14) % 34) + 2;
          ctx.beginPath();
          ctx.arc(
            travel - offset,
            HEIGHT * 0.5 + bob + 10 + i * 3,
            1.4 + power * 1.8,
            0,
            Math.PI * 2,
          );
          ctx.fill();
        }
      }
    };

    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
    };
  }, [creatureKey, color]);

  return (
    <canvas
      ref={canvasRef}
      className="block w-full"
      style={{ height: HEIGHT }}
      aria-hidden
    />
  );
}
