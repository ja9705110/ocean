"use client";

import { useEffect, useRef } from "react";
import { DEFAULT_EXCLUSIONS } from "@/lib/stage/riverMask";

/**
 * 河流底層（C7）。
 *
 * 這一層畫的是「參考圖，但文字區被抹掉」：河道、藍色水紋、金色光絲、
 * 支流、明暗分布全部保留原樣，logo 與所有文字則被抹平成周圍的深藍。
 * 文字由最上層的去背 PNG 供應，所以同一段文字不會出現兩次。
 *
 * 為什麼是「抹掉」而不是「重新描一條河」：
 *
 * 你要驗收的是「河流的走向、大小、寬度、位置跟原圖一不一樣」。
 * 我用眼睛量座標再描一條，一定會有誤差，而那個誤差正好就是你要看的東西。
 * 直接用參考圖的像素當底，這幾件事是由建構方式保證的，不是靠我描得準。
 *
 * 抹字的手法：取文字區「旁邊那一條水域」往內拉伸。
 *
 * 一開始用的是「整張圖縮到極小再放大」的平均法，結果補出來的方塊
 * 比周圍亮一截——因為平均值把整條金色河道也算進去了，
 * 而文字區周圍其實是很暗的深藍。
 *
 * 改成取相鄰的一條窄帶之後，垂直方向的漸層被保留下來，
 * 補的顏色就是那個位置本來的顏色。
 *
 * 那一條窄帶還要先垂直壓縮成一根「顏色柱」再拉開：直接橫向拉伸的話，
 * 帶子裡只要掃到一點河道，拉開十倍就變成一條刺眼的橫紋。
 * 壓成顏色柱之後只剩下由上而下的明暗變化，那才是我們要的底色。
 *
 * 這一層是靜止的，只在尺寸改變時重畫一次。
 */

/** 取樣帶的寬度，相對於畫布寬度。太窄會抓到雜訊，太寬會抓到河道。 */
const SAMPLE_STRIP = 0.035;

/** 顏色柱的高度。夠低才能把河道抹成一段漸層，夠高才留得住上下的明暗。 */
const COLUMN_STEPS = 48;

/** 文字區邊界的羽化寬度，相對於畫布寬度 */
const FEATHER = 0.035;

export interface RiverBaseProps {
  /** 參考圖（原尺寸完整版主視覺）的網址 */
  readonly referenceUrl: string;
}

export function RiverBase({ referenceUrl }: RiverBaseProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || referenceUrl === "") {
      return;
    }

    let disposed = false;
    let observer: ResizeObserver | null = null;

    const start = async () => {
      const image = await loadImage(referenceUrl).catch(() => null);
      if (!image || disposed) {
        return;
      }

      const draw = (): void => {
        const parent = canvas.parentElement;
        const ctx = canvas.getContext("2d");
        if (!parent || !ctx) {
          return;
        }

        const rect = parent.getBoundingClientRect();
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const width = Math.max(1, Math.round(rect.width * dpr));
        const height = Math.max(1, Math.round(rect.height * dpr));

        canvas.width = width;
        canvas.height = height;

        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, width, height);
        ctx.imageSmoothingQuality = "high";

        // 參考圖鋪滿整個畫布。畫布本身就是等比例的 16:9 框，
        // 所以這裡是單純的等比縮放，不會變形。
        ctx.drawImage(image, 0, 0, width, height);

        // 取樣要從「還沒被動過的那一份」拿，否則抹了第一塊之後
        // 第二塊會取到已經被抹過的顏色
        const snapshot = document.createElement("canvas");
        snapshot.width = width;
        snapshot.height = height;
        snapshot.getContext("2d")?.drawImage(image, 0, 0, width, height);

        /** 把一條窄帶壓成 1×N 的顏色柱，再拉開蓋滿文字區 */
        const column = document.createElement("canvas");
        column.width = 1;
        column.height = COLUMN_STEPS;
        const columnCtx = column.getContext("2d");

        // 把文字區換成「旁邊那一條水域」，帶羽化邊界
        const feather = width * FEATHER;
        const strip = width * SAMPLE_STRIP;

        for (const zone of DEFAULT_EXCLUSIONS) {
          const x = zone.x * width;
          const y = zone.y * height;
          const w = zone.w * width;
          const h = zone.h * height;

          // 取樣帶擺在文字區「畫布內側」的那一邊：
          // 靠左的區塊往右取樣，靠右的區塊往左取樣。
          const fromLeftEdge = zone.x <= 0.001;
          const sourceX = fromLeftEdge
            ? Math.min(width - strip, x + w)
            : Math.max(0, x - strip);

          ctx.save();
          ctx.beginPath();
          ctx.rect(x, y, w, h);
          ctx.clip();

          // 先壓成顏色柱（橫向的細節全部被平均掉），再拉開蓋滿文字區。
          // 剩下的只有由上而下的明暗變化，也就是那個位置本來的底色。
          if (columnCtx) {
            columnCtx.clearRect(0, 0, 1, COLUMN_STEPS);
            columnCtx.imageSmoothingQuality = "high";
            columnCtx.drawImage(
              snapshot,
              sourceX,
              y,
              strip,
              h,
              0,
              0,
              1,
              COLUMN_STEPS,
            );
            ctx.drawImage(column, 0, 0, 1, COLUMN_STEPS, x, y, w, h);
          }

          // 羽化：沿著文字區在畫布內側的那條邊，慢慢還原成原圖。
          // 沒有這一步，抹掉的地方會有一條看得出來的直線。
          const edgeX = fromLeftEdge ? x + w - feather : x;
          const gradient = ctx.createLinearGradient(edgeX, 0, edgeX + feather, 0);
          gradient.addColorStop(0, fromLeftEdge ? "rgba(0,0,0,0)" : "rgba(0,0,0,1)");
          gradient.addColorStop(1, fromLeftEdge ? "rgba(0,0,0,1)" : "rgba(0,0,0,0)");

          ctx.globalCompositeOperation = "destination-out";
          ctx.fillStyle = gradient;
          ctx.fillRect(edgeX, y, feather, h);

          // 上緣也羽化（右下角那一塊的上方是河道，硬切會很明顯）
          if (zone.y > 0.001) {
            const vertical = ctx.createLinearGradient(0, y, 0, y + feather);
            vertical.addColorStop(0, "rgba(0,0,0,1)");
            vertical.addColorStop(1, "rgba(0,0,0,0)");
            ctx.fillStyle = vertical;
            ctx.fillRect(x, y, w, feather);
          }

          ctx.restore();
        }

        // 被羽化挖掉的地方要把原圖補回來，否則那一圈會變透明
        ctx.save();
        ctx.globalCompositeOperation = "destination-over";
        ctx.drawImage(image, 0, 0, width, height);
        ctx.restore();
      };

      draw();
      observer = new ResizeObserver(draw);
      if (canvas.parentElement) {
        observer.observe(canvas.parentElement);
      }
    };

    void start();

    return () => {
      disposed = true;
      observer?.disconnect();
    };
  }, [referenceUrl]);

  if (referenceUrl === "") {
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

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`參考圖載入失敗：${url}`));
    image.src = url;
  });
}
