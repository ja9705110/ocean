"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { flowField, sampleFlow, sampleMask } from "@/lib/stage/riverMask";
import {
  LAB_MASK_HEIGHT,
  LAB_MASK_WIDTH,
  VISUAL_HEIGHT,
  VISUAL_WIDTH,
  analyzeImage,
  buildLabMasks,
  releaseImage,
  sampleSourceColor,
  validatePair,
} from "@/lib/stage/visualLab";
import type { ImageReport, LabMasks } from "@/lib/stage/visualLab";

/**
 * 主視覺測試台（C8）。
 *
 * 兩個檔案欄位、一份檢查報告、一個三層預覽。目的只有一個：
 * 讓河道的走向、大小、寬度、位置能夠被驗收，而且是用真正的原始圖檔，
 * 不是用對話裡的縮圖。
 *
 * 圖片完全不上傳，只在瀏覽器裡處理（URL.createObjectURL）。
 * 確認之後再上傳到後台，那時才會進 Storage。
 *
 * 三層：
 * 1. 固定不動的原始河流像素（就是完整版主視覺本身，不位移、不變形）
 * 2. 從原始像素取樣上色的光絲與光點，沿著河道切線前進
 * 3. 真正透明的主視覺文字 PNG
 *
 * 動畫只作用在第二層。
 */

/** 下游方向的提示：影像本身分不出一條河往哪邊流 */
const DOWNSTREAM = { x: -0.62, y: 0.78 };

const SPARK_COUNT = 700;
const SHEEN_COUNT = 8;

interface Spark {
  x: number;
  y: number;
  px: number;
  py: number;
  speed: number;
  size: number;
  brightness: number;
  phase: number;
  life: number;
  lifeSpeed: number;
}

interface Sheen {
  x: number;
  y: number;
  speed: number;
  radius: number;
  phase: number;
}

export function VisualLab() {
  const [full, setFull] = useState<ImageReport | null>(null);
  const [overlay, setOverlay] = useState<ImageReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [intensity, setIntensity] = useState(0.4);
  const [showMask, setShowMask] = useState(false);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const intensityRef = useRef(intensity);
  const showMaskRef = useRef(showMask);

  useEffect(() => {
    intensityRef.current = intensity;
    showMaskRef.current = showMask;
  });

  const pick = useCallback(
    async (file: File | undefined, which: "full" | "overlay") => {
      if (!file) {
        return;
      }
      setError(null);
      try {
        const report = await analyzeImage(file);
        // 換圖時釋放舊的 object URL，否則每選一次就多吃一張圖的記憶體
        if (which === "full") {
          setFull((previous) => {
            releaseImage(previous);
            return report;
          });
        } else {
          setOverlay((previous) => {
            releaseImage(previous);
            return report;
          });
        }
      } catch (pickError) {
        setError(
          pickError instanceof Error ? pickError.message : String(pickError),
        );
      }
    },
    [],
  );

  // 檢查結果是從兩張圖直接算出來的，不需要另外用 state 保存——
  // 放進 effect 再 setState 只會多一次 render，也違反 React 的規則
  const issues = validatePair(full, overlay);
  const fatal = issues.some((issue) => issue.level === "error");
  const ready = full !== null && overlay !== null && !fatal;

  // ---- 動畫 ----
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !ready || !full || !overlay) {
      return;
    }

    let masks: LabMasks;
    try {
      masks = buildLabMasks(full.image, overlay.image);
    } catch {
      return;
    }

    const field = flowField(masks.flow, LAB_MASK_WIDTH, LAB_MASK_HEIGHT, DOWNSTREAM);

    // 出生地：河道裡遮罩值夠高的格子，依亮度加權
    const seeds: number[] = [];
    for (let i = 0; i < masks.flow.length; i += 1) {
      const value = masks.flow[i] ?? 0;
      if (value < 0.1) {
        continue;
      }
      for (let k = 0; k < 1 + Math.round(value * 3); k += 1) {
        seeds.push(i);
      }
    }
    if (seeds.length === 0) {
      return;
    }

    // 遮罩貼圖：合成時把光效裁進河道
    const maskCanvas = document.createElement("canvas");
    maskCanvas.width = LAB_MASK_WIDTH;
    maskCanvas.height = LAB_MASK_HEIGHT;
    const maskCtx = maskCanvas.getContext("2d");
    if (!maskCtx) {
      return;
    }
    const maskImage = maskCtx.createImageData(LAB_MASK_WIDTH, LAB_MASK_HEIGHT);
    for (let i = 0; i < masks.flow.length; i += 1) {
      const value = Math.min(1, (masks.flow[i] ?? 0) * 2.4);
      maskImage.data[i * 4] = 255;
      maskImage.data[i * 4 + 1] = 255;
      maskImage.data[i * 4 + 2] = 255;
      maskImage.data[i * 4 + 3] = Math.round(value * 255);
    }
    maskCtx.putImageData(maskImage, 0, 0);

    // 檢查用：文字保護區塗紅、可流動區塗綠
    const debugCanvas = document.createElement("canvas");
    debugCanvas.width = LAB_MASK_WIDTH;
    debugCanvas.height = LAB_MASK_HEIGHT;
    const debugCtx = debugCanvas.getContext("2d");
    if (debugCtx) {
      const debugImage = debugCtx.createImageData(LAB_MASK_WIDTH, LAB_MASK_HEIGHT);
      for (let i = 0; i < masks.flow.length; i += 1) {
        const isText = (masks.text[i] ?? 0) > 0.5;
        const flowValue = Math.min(1, (masks.flow[i] ?? 0) * 2.4);
        debugImage.data[i * 4] = isText ? 255 : 0;
        debugImage.data[i * 4 + 1] = isText ? 40 : 255;
        debugImage.data[i * 4 + 2] = isText ? 60 : 130;
        debugImage.data[i * 4 + 3] = isText
          ? 150
          : Math.round(flowValue * 200);
      }
      debugCtx.putImageData(debugImage, 0, 0);
    }

    const respawn = (spark: Spark, atStart: boolean): void => {
      const cell = seeds[Math.floor(Math.random() * seeds.length)] ?? 0;
      spark.x = (cell % LAB_MASK_WIDTH) + Math.random();
      spark.y = Math.floor(cell / LAB_MASK_WIDTH) + Math.random();
      spark.px = spark.x;
      spark.py = spark.y;
      spark.life = atStart ? Math.random() : 0;
    };

    const sparks: Spark[] = [];
    for (let i = 0; i < SPARK_COUNT; i += 1) {
      const spark: Spark = {
        x: 0,
        y: 0,
        px: 0,
        py: 0,
        // 速度差刻意拉開：一致的速度看起來像輸送帶，不像水
        speed: rand(4, 14),
        size: rand(0.5, 2),
        brightness: rand(0.3, 1),
        phase: Math.random() * Math.PI * 2,
        life: 0,
        lifeSpeed: rand(0.05, 0.14),
      };
      respawn(spark, true);
      sparks.push(spark);
    }

    const sheens: Sheen[] = [];
    for (let i = 0; i < SHEEN_COUNT; i += 1) {
      const cell = seeds[Math.floor(Math.random() * seeds.length)] ?? 0;
      sheens.push({
        x: cell % LAB_MASK_WIDTH,
        y: Math.floor(cell / LAB_MASK_WIDTH),
        speed: rand(1.2, 3.4),
        radius: rand(24, 60),
        phase: Math.random() * Math.PI * 2,
      });
    }

    const layer = document.createElement("canvas");
    const layerCtx = layer.getContext("2d");
    const visible = canvas.getContext("2d");
    if (!layerCtx || !visible) {
      return;
    }

    let scale = 1;

    const resize = (): void => {
      const parent = canvas.parentElement;
      if (!parent) {
        return;
      }
      const rect = parent.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, Math.round(rect.width * dpr));
      canvas.height = Math.max(1, Math.round(rect.height * dpr));
      layer.width = canvas.width;
      layer.height = canvas.height;
      scale = canvas.width / LAB_MASK_WIDTH;
    };

    resize();
    const observer = new ResizeObserver(resize);
    if (canvas.parentElement) {
      observer.observe(canvas.parentElement);
    }

    let frame = 0;
    let lastMs = performance.now();
    let elapsed = 0;

    const tick = (nowMs: number): void => {
      frame = requestAnimationFrame(tick);
      if (document.visibilityState !== "visible") {
        lastMs = nowMs;
        return;
      }

      const deltaSeconds = Math.min(0.05, (nowMs - lastMs) / 1000);
      lastMs = nowMs;
      elapsed += deltaSeconds;

      layerCtx.setTransform(1, 0, 0, 1, 0, 0);
      layerCtx.clearRect(0, 0, layer.width, layer.height);
      layerCtx.globalCompositeOperation = "lighter";

      // 水面反光
      for (const sheen of sheens) {
        const flow = sampleFlow(field, LAB_MASK_WIDTH, LAB_MASK_HEIGHT, sheen.x, sheen.y);
        sheen.x += flow.x * sheen.speed * deltaSeconds;
        sheen.y += flow.y * sheen.speed * deltaSeconds;

        if (sampleMask(masks.flow, LAB_MASK_WIDTH, LAB_MASK_HEIGHT, sheen.x, sheen.y) < 0.05) {
          const cell = seeds[Math.floor(Math.random() * seeds.length)] ?? 0;
          sheen.x = cell % LAB_MASK_WIDTH;
          sheen.y = Math.floor(cell / LAB_MASK_WIDTH);
        }

        const pulse = 0.5 + 0.5 * Math.sin(elapsed * 0.5 + sheen.phase);
        const radius = sheen.radius * scale;
        const cx = sheen.x * scale;
        const cy = sheen.y * scale;
        const color = sampleSourceColor(masks.source, sheen.x, sheen.y);

        const gradient = layerCtx.createRadialGradient(cx, cy, 0, cx, cy, radius);
        gradient.addColorStop(0, `rgba(${color.r},${color.g},${color.b},${0.2 * pulse})`);
        gradient.addColorStop(1, `rgba(${color.r},${color.g},${color.b},0)`);
        layerCtx.fillStyle = gradient;
        layerCtx.beginPath();
        layerCtx.arc(cx, cy, radius, 0, Math.PI * 2);
        layerCtx.fill();
      }

      // 光絲：顏色從原圖取樣，所以流動的光跟底下的河是同一個色調
      layerCtx.lineCap = "round";
      for (const spark of sparks) {
        spark.px = spark.x;
        spark.py = spark.y;

        const flow = sampleFlow(field, LAB_MASK_WIDTH, LAB_MASK_HEIGHT, spark.x, spark.y);
        spark.x += flow.x * spark.speed * deltaSeconds;
        spark.y += flow.y * spark.speed * deltaSeconds;
        spark.life += spark.lifeSpeed * deltaSeconds;

        const inside = sampleMask(masks.flow, LAB_MASK_WIDTH, LAB_MASK_HEIGHT, spark.x, spark.y);
        if (spark.life >= 1 || inside < 0.04) {
          respawn(spark, false);
          continue;
        }

        const fade = Math.min(1, spark.life / 0.15, (1 - spark.life) / 0.25);
        const twinkle = 0.65 + 0.35 * Math.sin(elapsed * 1.8 + spark.phase);
        const alpha = spark.brightness * fade * twinkle * Math.min(1, inside * 2);
        if (alpha <= 0.01) {
          continue;
        }

        const color = sampleSourceColor(masks.source, spark.x, spark.y);
        // 取樣到的顏色偏暗時稍微提亮，否則暗處的光絲看不見
        const boost = 1.35;
        layerCtx.strokeStyle = `rgba(${Math.min(255, color.r * boost) | 0},${Math.min(255, color.g * boost) | 0},${Math.min(255, color.b * boost) | 0},${alpha})`;
        layerCtx.lineWidth = spark.size * scale;
        layerCtx.beginPath();
        layerCtx.moveTo(spark.px * scale, spark.py * scale);
        layerCtx.lineTo(spark.x * scale, spark.y * scale);
        layerCtx.stroke();
      }

      // 裁進河道
      layerCtx.globalCompositeOperation = "destination-in";
      layerCtx.drawImage(maskCanvas, 0, 0, layer.width, layer.height);

      visible.setTransform(1, 0, 0, 1, 0, 0);
      visible.clearRect(0, 0, canvas.width, canvas.height);

      if (showMaskRef.current) {
        visible.globalAlpha = 1;
        visible.drawImage(debugCanvas, 0, 0, canvas.width, canvas.height);
        return;
      }

      visible.globalAlpha = intensityRef.current;
      visible.drawImage(layer, 0, 0);
      visible.globalAlpha = 1;
    };

    frame = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [ready, full, overlay]);

  return (
    <main className="mx-auto max-w-6xl px-8 py-12">
      <h1 className="text-2xl font-light text-ink-100">主視覺測試台</h1>
      <p className="mt-3 text-sm leading-relaxed text-ink-400">
        從電腦選兩張圖，直接在這一頁看結果。圖片不會上傳，只在瀏覽器裡處理。
        確認河道對了之後，再到後台上傳同樣的兩張圖。
      </p>

      <div className="mt-8 grid gap-5 sm:grid-cols-2">
        <FilePicker
          label="1. 完整版主視覺"
          hint={`${VISUAL_WIDTH}×${VISUAL_HEIGHT}，含河流。河道的位置與寬度從這張量。`}
          report={full}
          onPick={(file) => void pick(file, "full")}
        />
        <FilePicker
          label="2. 去背主視覺 PNG"
          hint="只有 logo 與文字，背景必須是真正的透明。文字保護遮罩從它的 Alpha 來。"
          report={overlay}
          onPick={(file) => void pick(file, "overlay")}
        />
      </div>

      {error ? (
        <p className="mt-6 rounded-lg border border-alert-500/40 bg-ink-900 px-5 py-4 text-sm text-alert-500">
          {error}
        </p>
      ) : null}

      {issues.length > 0 ? (
        <ul className="mt-6 space-y-3">
          {issues.map((issue) => (
            <li
              key={issue.message}
              className={`rounded-lg border px-5 py-4 text-sm leading-relaxed ${
                issue.level === "error"
                  ? "border-alert-500/40 bg-alert-500/5 text-alert-500"
                  : "border-ink-700 bg-ink-900 text-ink-300"
              }`}
            >
              <strong className="mr-2">
                {issue.level === "error" ? "錯誤" : "提醒"}
              </strong>
              {issue.message}
            </li>
          ))}
        </ul>
      ) : null}

      {ready ? (
        <>
          <div className="mt-8 flex flex-wrap items-center gap-6">
            <label className="flex items-center gap-3 text-sm text-ink-300">
              光絲強度
              <input
                type="range"
                min={0.2}
                max={0.6}
                step={0.01}
                value={intensity}
                onChange={(e) => setIntensity(Number(e.target.value))}
                className="w-48 accent-signal-500"
              />
              <span className="w-12 font-mono text-xs text-signal-400 tabular-nums">
                {Math.round(intensity * 100)}%
              </span>
            </label>

            <label className="flex items-center gap-3 text-sm text-ink-300">
              <input
                type="checkbox"
                checked={showMask}
                onChange={(e) => setShowMask(e.target.checked)}
                className="accent-signal-500"
              />
              顯示遮罩（綠＝會流動，紅＝文字保護區）
            </label>
          </div>

          {/*
            三層預覽。比例取自完整版主視覺本身，三層都是這個容器的
            absolute 子元素，共用同一套座標。
          */}
          <div
            className="relative mt-6 w-full overflow-hidden rounded-lg bg-[#02040c]"
            style={{ aspectRatio: `${full.width} / ${full.height}` }}
          >
            {/* 第一層：固定不動的原始河流像素 */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={full.src}
              alt=""
              className="absolute inset-0 size-full object-contain"
            />

            {/* 第二層：沿著河道流動的光。只有這一層在動。 */}
            <canvas
              ref={canvasRef}
              className="pointer-events-none absolute inset-0 size-full mix-blend-screen"
              aria-hidden
            />

            {/* 第三層：真正透明的主視覺文字 PNG，原樣覆蓋 */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={overlay.src}
              alt=""
              className="pointer-events-none absolute inset-0 size-full object-contain"
            />
          </div>

          <p className="mt-5 text-xs leading-relaxed text-ink-500">
            第一層是你的完整版主視覺，完全靜止，沒有位移也沒有變形。
            第二層的光絲顏色是從第一層的像素取樣來的，所以色調一定跟河一致。
            第三層是你的去背 PNG，原樣覆蓋，顏色、位置、大小、透明度都沒有動。
            <br />
            光點是持續重生的，沒有循環點，所以不會有「循環時跳一下」的問題。
          </p>
        </>
      ) : null}
    </main>
  );
}

interface FilePickerProps {
  readonly label: string;
  readonly hint: string;
  readonly report: ImageReport | null;
  readonly onPick: (file: File | undefined) => void;
}

function FilePicker({ label, hint, report, onPick }: FilePickerProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div className="rounded-lg border border-ink-800 bg-ink-900/50 p-6">
      <p className="text-sm text-ink-200">{label}</p>
      <p className="mt-2 text-xs leading-relaxed text-ink-500">{hint}</p>

      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/webp"
        className="hidden"
        onChange={(e) => onPick(e.target.files?.[0])}
      />
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        className="mt-4 rounded-lg border border-ink-700 px-5 py-2.5 text-sm text-ink-200"
      >
        {report ? "換一張" : "選擇檔案"}
      </button>

      {report ? (
        <dl className="mt-4 space-y-1 text-xs text-ink-500">
          <div className="flex gap-2">
            <dt>檔名</dt>
            <dd className="truncate text-ink-300">{report.name}</dd>
          </div>
          <div className="flex gap-2">
            <dt>尺寸</dt>
            <dd className="text-ink-300">
              {report.width}×{report.height}
              {report.width === VISUAL_WIDTH && report.height === VISUAL_HEIGHT
                ? "（符合）"
                : ""}
            </dd>
          </div>
          <div className="flex gap-2">
            <dt>透明區域</dt>
            <dd className={report.hasAlpha ? "text-signal-400" : "text-ink-300"}>
              {(report.transparentRatio * 100).toFixed(1)}%
              {report.hasAlpha ? "（有 Alpha）" : ""}
            </dd>
          </div>
        </dl>
      ) : null}
    </div>
  );
}

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}
