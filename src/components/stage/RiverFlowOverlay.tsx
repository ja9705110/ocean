"use client";

import { useEffect, useRef } from "react";
import {
  MASK_HEIGHT,
  MASK_WIDTH,
  loadRiverFlow,
} from "@/lib/stage/riverFlowSource";
import { sampleFlow, sampleMask } from "@/lib/stage/riverMask";

/**
 * 主視覺河道的流動層（C4）。
 *
 * 規格是明確的：底圖那張 PNG 永遠靜止，不對它套任何位移、變形或濾鏡；
 * 流動發生在上面一層透明畫布裡，而且只在河道範圍內。
 *
 * 為什麼用 Canvas 2D 而不是再開一個 PixiJS：
 * 這一頁已經有一個 Pixi Application 在跑角色了。第二個 Application
 * 就是第二個 WebGL context，投影用的筆電上那是實實在在的成本，
 * 而這一層要做的事（幾百個加色的短線與光斑、一次遮罩合成）
 * Canvas 2D 綽綽有餘。
 *
 * 座標系是關鍵。底圖以 object-contain 擺放，畫面不是 16:9 時上下或左右
 * 會留黑邊；動畫必須畫在跟底圖完全相同的那個矩形裡，否則縮放時
 * 動畫會偏離河道。這裡的做法是把畫布本身設成那個矩形的大小與位置，
 * 內部再用一套固定的 16:9 座標，遮罩與光點共用同一套。
 */

/** 光點數量。上限考慮的是投影用筆電，不是開發機。 */
const SPARK_COUNT = 620;
/** 水面反光的光斑數量 */
const SHEEN_COUNT = 7;

interface Spark {
  /** 遮罩座標系裡的位置 */
  x: number;
  y: number;
  /** 前一幀的位置，用來畫出短短的一段光絲 */
  px: number;
  py: number;
  /** 每秒前進幾個遮罩格 */
  speed: number;
  size: number;
  brightness: number;
  /** 閃爍的相位差 */
  phase: number;
  /** 目前壽命 0~1，到 1 就重生 */
  life: number;
  lifeSpeed: number;
  /** true 是金色的光粒，false 是藍色的水紋 */
  warm: boolean;
}

interface Sheen {
  x: number;
  y: number;
  speed: number;
  radius: number;
  phase: number;
}

export interface RiverFlowOverlayProps {
  /** 主視覺原圖的網址。必須與底圖是同一張。 */
  readonly imageUrl: string;
  /**
   * 整層的不透明度。規格要求控制在 0.25~0.45 之間，
   * 太高金色會過曝變白。
   */
  readonly intensity: number;
  /** 除錯：把遮罩範圍畫出來，用來確認有沒有蓋到文字 */
  readonly debug?: boolean;
}

export function RiverFlowOverlay({
  imageUrl,
  intensity,
  debug = false,
}: RiverFlowOverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  /** 目前的不透明度與除錯開關放進 ref，改變時不必重建整個動畫 */
  const intensityRef = useRef(intensity);
  const debugRef = useRef(debug);

  useEffect(() => {
    intensityRef.current = intensity;
    debugRef.current = debug;
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || imageUrl === "") {
      return;
    }

    let disposed = false;
    let frame = 0;

    const start = async () => {
      // 遮罩與流場只算一次，簽名那一層用的是同一份——
      // 兩邊各算一份的話，只要有一邊的參數被改了，
      // 簽名就會沿著跟光流不一樣的路徑走。
      const flow = await loadRiverFlow(imageUrl).catch(() => null);
      if (!flow || disposed || flow.seeds.length === 0) {
        return;
      }

      const { mask, field, seeds, maskCanvas } = flow;

      // ---- 光點 ----
      const respawn = (spark: Spark, atStart: boolean): void => {
        const cell = seeds[Math.floor(Math.random() * seeds.length)] ?? 0;
        // 在格子內隨機抖一下，否則所有光點都會落在格子中心，形成網格感
        spark.x = (cell % MASK_WIDTH) + Math.random();
        spark.y = Math.floor(cell / MASK_WIDTH) + Math.random();
        spark.px = spark.x;
        spark.py = spark.y;
        spark.life = atStart ? Math.random() : 0;
      };

      const sparks: Spark[] = [];
      for (let i = 0; i < SPARK_COUNT; i += 1) {
        // 少量藍色的水紋光點，對應規格裡「深藍水紋可有非常輕微的流動」
        const warm = Math.random() > 0.18;
        const spark: Spark = {
          x: 0,
          y: 0,
          px: 0,
          py: 0,
          speed: warm ? rand(5, 16) : rand(3, 8),
          size: warm ? rand(0.5, 1.9) : rand(0.6, 1.6),
          brightness: warm ? rand(0.35, 1) : rand(0.12, 0.32),
          phase: Math.random() * Math.PI * 2,
          life: 0,
          lifeSpeed: rand(0.07, 0.2),
          warm,
        };
        respawn(spark, true);
        sparks.push(spark);
      }

      const sheens: Sheen[] = [];
      for (let i = 0; i < SHEEN_COUNT; i += 1) {
        const cell = seeds[Math.floor(Math.random() * seeds.length)] ?? 0;
        sheens.push({
          x: cell % MASK_WIDTH,
          y: Math.floor(cell / MASK_WIDTH),
          speed: rand(1.5, 4),
          radius: rand(26, 62),
          phase: Math.random() * Math.PI * 2,
        });
      }

      // ---- 畫布尺寸：跟著底圖的 object-contain 矩形 ----
      const layer = document.createElement("canvas");
      const layerCtx = layer.getContext("2d");
      if (!layerCtx) {
        return;
      }

      let scale = 1;
      let dpr = 1;

      const resize = (): void => {
        const parent = canvas.parentElement;
        if (!parent) {
          return;
        }
        // 畫框由外層的容器決定，這一層只負責填滿它。
        // 底層、流動層、去背 PNG 三者共用同一個容器，
        // 所以縮放時不可能錯位——這是規格裡最容易出錯的一條。
        const rect = parent.getBoundingClientRect();
        dpr = Math.min(window.devicePixelRatio || 1, 2);
        canvas.width = Math.max(1, Math.round(rect.width * dpr));
        canvas.height = Math.max(1, Math.round(rect.height * dpr));

        layer.width = canvas.width;
        layer.height = canvas.height;

        // 遮罩座標 → 畫布像素
        scale = canvas.width / MASK_WIDTH;
      };

      resize();
      const observer = new ResizeObserver(resize);
      if (canvas.parentElement) {
        observer.observe(canvas.parentElement);
      }

      // ---- 每幀 ----
      const visible = canvas.getContext("2d");
      if (!visible) {
        observer.disconnect();
        return;
      }

      let lastMs = performance.now();
      let elapsed = 0;

      const tick = (nowMs: number): void => {
        if (disposed) {
          return;
        }
        frame = requestAnimationFrame(tick);

        // 分頁在背景時不畫。投影機那台機器常常同時開著別的東西。
        if (document.visibilityState !== "visible") {
          lastMs = nowMs;
          return;
        }

        // 夾住 delta：切回分頁時的那一大跳會讓所有光點瞬間衝出河道
        const deltaSeconds = Math.min(0.05, (nowMs - lastMs) / 1000);
        lastMs = nowMs;
        elapsed += deltaSeconds;

        layerCtx.setTransform(1, 0, 0, 1, 0, 0);
        layerCtx.clearRect(0, 0, layer.width, layer.height);
        layerCtx.globalCompositeOperation = "lighter";

        // 水面反光：慢慢沿著河道漂移的柔和光斑
        for (const sheen of sheens) {
          const flow = sampleFlow(field, MASK_WIDTH, MASK_HEIGHT, sheen.x, sheen.y);
          sheen.x += flow.x * sheen.speed * deltaSeconds;
          sheen.y += flow.y * sheen.speed * deltaSeconds;

          if (sampleMask(mask, MASK_WIDTH, MASK_HEIGHT, sheen.x, sheen.y) < 0.05) {
            const cell = seeds[Math.floor(Math.random() * seeds.length)] ?? 0;
            sheen.x = cell % MASK_WIDTH;
            sheen.y = Math.floor(cell / MASK_WIDTH);
          }

          const pulse = 0.5 + 0.5 * Math.sin(elapsed * 0.55 + sheen.phase);
          const radius = sheen.radius * scale;
          const cx = sheen.x * scale;
          const cy = sheen.y * scale;

          const gradient = layerCtx.createRadialGradient(cx, cy, 0, cx, cy, radius);
          gradient.addColorStop(0, `rgba(255,235,190,${0.16 * pulse})`);
          gradient.addColorStop(0.5, `rgba(242,192,99,${0.07 * pulse})`);
          gradient.addColorStop(1, "rgba(242,192,99,0)");
          layerCtx.fillStyle = gradient;
          layerCtx.beginPath();
          layerCtx.arc(cx, cy, radius, 0, Math.PI * 2);
          layerCtx.fill();
        }

        // 光粒：沿著流場前進，畫成從上一個位置到現在位置的一小段，
        // 那一小段就是規格要的「光絲」
        layerCtx.lineCap = "round";
        for (const spark of sparks) {
          spark.px = spark.x;
          spark.py = spark.y;

          const flow = sampleFlow(field, MASK_WIDTH, MASK_HEIGHT, spark.x, spark.y);
          spark.x += flow.x * spark.speed * deltaSeconds;
          spark.y += flow.y * spark.speed * deltaSeconds;
          spark.life += spark.lifeSpeed * deltaSeconds;

          const inside = sampleMask(mask, MASK_WIDTH, MASK_HEIGHT, spark.x, spark.y);
          if (spark.life >= 1 || inside < 0.04) {
            respawn(spark, false);
            continue;
          }

          // 頭尾淡入淡出，加上各自不同步的閃爍
          const fade = Math.min(1, spark.life / 0.15, (1 - spark.life) / 0.25);
          const twinkle = 0.6 + 0.4 * Math.sin(elapsed * 2.1 + spark.phase);
          const alpha = spark.brightness * fade * twinkle * Math.min(1, inside * 2);

          if (alpha <= 0.01) {
            continue;
          }

          layerCtx.strokeStyle = spark.warm
            ? `rgba(255,226,163,${alpha})`
            : `rgba(150,196,255,${alpha})`;
          layerCtx.lineWidth = spark.size * scale;
          layerCtx.beginPath();
          layerCtx.moveTo(spark.px * scale, spark.py * scale);
          layerCtx.lineTo(spark.x * scale, spark.y * scale);
          layerCtx.stroke();
        }

        // 裁進河道：這一步讓所有光效只出現在遮罩允許的地方，
        // logo、標題、日期、右下角的「25」一律不受影響
        layerCtx.globalCompositeOperation = "destination-in";
        layerCtx.drawImage(maskCanvas, 0, 0, layer.width, layer.height);

        // 疊到看得見的畫布上
        visible.setTransform(1, 0, 0, 1, 0, 0);
        visible.clearRect(0, 0, canvas.width, canvas.height);
        visible.globalCompositeOperation = "source-over";
        visible.globalAlpha = intensityRef.current;
        visible.drawImage(layer, 0, 0);
        visible.globalAlpha = 1;

        if (debugRef.current) {
          // 除錯：把遮罩鋪成綠色，一眼看得出流動範圍有沒有蓋到 logo 或文字。
          // 先畫綠底、再用遮罩裁形狀，最後整塊疊上去。
          layerCtx.globalCompositeOperation = "source-over";
          layerCtx.fillStyle = "#00ff88";
          layerCtx.fillRect(0, 0, layer.width, layer.height);
          layerCtx.globalCompositeOperation = "destination-in";
          layerCtx.drawImage(maskCanvas, 0, 0, layer.width, layer.height);

          visible.globalCompositeOperation = "source-over";
          visible.globalAlpha = 0.55;
          visible.drawImage(layer, 0, 0);
          visible.globalAlpha = 1;
        }
      };

      frame = requestAnimationFrame(tick);

      cleanup = () => {
        observer.disconnect();
        cancelAnimationFrame(frame);
      };
    };

    let cleanup: (() => void) | null = null;
    void start();

    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      cleanup?.();
    };
  }, [imageUrl]);

  if (imageUrl === "") {
    return null;
  }

  return (
    <canvas
      ref={canvasRef}
      // mix-blend-screen：規格要求用 screen 或 additive 疊光。
      // 亮部相加、暗部不動，金色不會被推成白色。
      className="pointer-events-none absolute inset-0 size-full mix-blend-screen"
      aria-hidden
    />
  );
}

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}
