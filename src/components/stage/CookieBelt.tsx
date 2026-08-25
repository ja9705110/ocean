"use client";

import { useEffect, useRef } from "react";
import {
  buildRiverGeometry,
  measureRiverLength,
  sampleRiver,
  type CookieDisplay,
  type RiverShape,
} from "@/lib/stage/riverShape";
import {
  beltSpeed,
  cookieSlots,
  planCookieBelt,
  type CookieBelt as Belt,
} from "@/lib/stage/cookieBelt";

/**
 * 餅乾輸送帶（C14）。
 *
 * 大家彩繪的餅乾照片密鋪在整條河道裡，跟著水流一直走。
 *
 * 為什麼是 canvas 而不是 Pixi：這一層要吃的是「一批從網路載進來的照片」，
 * 而 Pixi 那一側的世界模板刻意不認識任何資料來源。畫在自己的 canvas 上
 * 就不必為了這個活動段落把資料管線接進渲染核心。
 *
 * 河道的取樣函式跟 Pixi 那邊是同一份（riverShape.ts），
 * 所以兩層貼的是同一條河，不會飄掉。
 */

export interface CookieBeltProps {
  /** 照片網址，順序就是上傳順序 */
  readonly photos: readonly string[];
  readonly shape: RiverShape;
  readonly display: CookieDisplay;
}

/** 畫面基準寬度。格子大小是以這個寬度為準訂的，實際畫面會等比例縮放。 */
const BASE_WIDTH = 1600;

export function CookieBelt({ photos, shape, display }: CookieBeltProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  /**
   * 每一幀都要讀最新的設定，但不能因此重建整個動畫迴圈。
   *
   * 重建的話輸送帶會從頭開始跑，主持人每拉一次滑桿整條河就跳一次。
   */
  const stateRef = useRef({ photos, shape, display });
  useEffect(() => {
    stateRef.current = { photos, shape, display };
  }, [photos, shape, display]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    let disposed = false;
    let frame = 0;
    /** 輸送帶走了多遠（像素）。一直累加，繞回來的事交給 cookieSlots。 */
    let scroll = 0;
    let lastMs = performance.now();

    /**
     * 已經載好的照片。
     *
     * 用 Map 而不是陣列：照片是陸續載進來的，而畫面不能等最後一張
     * ——現場是一邊拍一邊上傳，等所有人拍完才顯示的話那一段就沒東西看。
     * 沒載好的格子就先跳過，載好了自己會出現。
     */
    const images = new Map<string, HTMLImageElement>();
    const failed = new Set<string>();

    const ensureImage = (url: string): HTMLImageElement | null => {
      const existing = images.get(url);
      if (existing) {
        return existing.complete && existing.naturalWidth > 0 ? existing : null;
      }
      if (failed.has(url)) {
        return null;
      }
      const image = new Image();
      image.crossOrigin = "anonymous";
      image.onerror = () => {
        failed.add(url);
        images.delete(url);
      };
      image.src = url;
      images.set(url, image);
      return null;
    };

    const draw = (): void => {
      if (disposed) {
        return;
      }
      frame = requestAnimationFrame(draw);

      const now = performance.now();
      const deltaSeconds = Math.min(0.1, (now - lastMs) / 1000);
      lastMs = now;

      const { photos: list, shape: currentShape, display: currentDisplay } =
        stateRef.current;

      const parent = canvas.parentElement;
      const ctx = canvas.getContext("2d");
      if (!parent || !ctx) {
        return;
      }

      const rect = parent.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const width = Math.max(1, Math.round(rect.width * dpr));
      const height = Math.max(1, Math.round(rect.height * dpr));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }

      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, width, height);

      if (list.length === 0 || !currentDisplay.enabled) {
        return;
      }

      // 格子大小是以 1600 寬的畫面為基準訂的，其他解析度等比例縮放，
      // 否則同一組設定在 4K 投影機上會變成一堆小點
      const scale = width / BASE_WIDTH;

      const geometry = buildRiverGeometry(currentShape);
      const pathLength = measureRiverLength(geometry.points, width, height);
      const belt: Belt = planCookieBelt({
        pathLength,
        halfWidth: currentDisplay.spread * scale * currentShape.width,
        tileWidth: currentDisplay.tileWidth * scale,
        photoCount: list.length,
      });

      scroll += beltSpeed(pathLength, currentDisplay.loopSeconds) * deltaSeconds;

      const slots = cookieSlots(belt, scroll, list.length);
      const halfW = belt.tileWidth / 2;
      const halfH = belt.tileHeight / 2;
      const margin = Math.max(belt.tileWidth, belt.tileHeight);

      for (const slot of slots) {
        const url = list[slot.photoIndex];
        if (!url) {
          continue;
        }
        const image = ensureImage(url);
        if (!image) {
          continue;
        }

        const point = sampleRiver(geometry.points, slot.t, width, height);
        const nx = Math.sin(point.angle);
        const ny = -Math.cos(point.angle);
        const offset =
          slot.lateral * currentDisplay.spread * scale * currentShape.width;
        const x = point.x + nx * offset;
        const y = point.y + ny * offset;

        // 畫面外的直接跳過。三百多格裡有一半以上在畫面外，
        // 少畫那一半就是少一半的成本。
        if (
          x < -margin ||
          y < -margin ||
          x > width + margin ||
          y > height + margin
        ) {
          continue;
        }

        ctx.save();
        ctx.translate(x, y);
        // 轉成跟水流同方向：餅乾是貼著河排的，不是貼著螢幕排的
        ctx.rotate(point.angle + Math.PI / 2);
        ctx.drawImage(image, -halfW, -halfH, belt.tileWidth, belt.tileHeight);
        ctx.restore();
      }
    };

    frame = requestAnimationFrame(draw);

    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
    };
  }, []);

  if (!display.enabled) {
    return null;
  }

  return (
    <canvas
      ref={canvasRef}
      className="pointer-events-none absolute inset-0 size-full"
      aria-hidden
    />
  );
}
