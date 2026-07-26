"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";

/**
 * 全螢幕繪圖畫布（規格第 9 節）。
 *
 * 工具刻意極簡：3 種筆刷粗細、10 色、橡皮擦、復原、清空。
 * 不做圖層、不做填色。
 *
 * 實作要點：
 * - 筆畫以向量（點序列）保存，復原＝移除最後一筆後全部重畫，
 *   匯出＝在離螢幕畫布以原生解析度重播，品質不受螢幕縮放影響。
 * - 畫布保持透明背景，橡皮擦用 destination-out 挖洞，
 *   匯出的圖直接是透明背景（規格第 9 節第 1 點）。
 */

interface StrokePoint {
  readonly x: number;
  readonly y: number;
}

interface Stroke {
  readonly color: string;
  readonly size: number;
  readonly isEraser: boolean;
  readonly points: StrokePoint[];
}

export interface DrawingCanvasHandle {
  /** 匯出目前畫面：回傳原生解析度的透明背景畫布；一筆都沒有時回傳 null */
  exportCanvas(): HTMLCanvasElement | null;
}

const PALETTE: readonly string[] = [
  "#1c1e26",
  "#f5f6f8",
  "#e8574c",
  "#f2963a",
  "#f4d03f",
  "#4caf6d",
  "#4fc3d9",
  "#2f5fd0",
  "#8e5fd0",
  "#f083b0",
];

const BRUSH_SIZES: readonly number[] = [4, 10, 22];

function drawStroke(ctx: CanvasRenderingContext2D, stroke: Stroke): void {
  const first = stroke.points[0];
  if (!first) {
    return;
  }

  ctx.save();
  ctx.globalCompositeOperation = stroke.isEraser
    ? "destination-out"
    : "source-over";
  ctx.strokeStyle = stroke.color;
  ctx.fillStyle = stroke.color;
  ctx.lineWidth = stroke.size;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  if (stroke.points.length === 1) {
    // 點一下也要留下痕跡
    ctx.beginPath();
    ctx.arc(first.x, first.y, stroke.size / 2, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.beginPath();
    ctx.moveTo(first.x, first.y);
    for (const point of stroke.points.slice(1)) {
      ctx.lineTo(point.x, point.y);
    }
    ctx.stroke();
  }

  ctx.restore();
}

export const DrawingCanvas = forwardRef<DrawingCanvasHandle>(
  function DrawingCanvas(_props, ref) {
    const containerRef = useRef<HTMLDivElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const strokesRef = useRef<Stroke[]>([]);
    const activeStrokeRef = useRef<Stroke | null>(null);
    const dprRef = useRef(1);

    const [color, setColor] = useState<string>(PALETTE[7] ?? "#2f5fd0");
    const [size, setSize] = useState<number>(BRUSH_SIZES[1] ?? 10);
    const [isEraser, setIsEraser] = useState(false);
    const [strokeCount, setStrokeCount] = useState(0);

    /** 以 CSS 座標系全量重畫（context 已被 scale 成 dpr） */
    const redraw = useCallback(() => {
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext("2d");
      if (!canvas || !ctx) {
        return;
      }

      ctx.clearRect(
        0,
        0,
        canvas.width / dprRef.current,
        canvas.height / dprRef.current,
      );

      for (const stroke of strokesRef.current) {
        drawStroke(ctx, stroke);
      }
    }, []);

    // 依容器尺寸與 devicePixelRatio 設定畫布解析度，改變時全量重畫
    useEffect(() => {
      const container = containerRef.current;
      const canvas = canvasRef.current;
      if (!container || !canvas) {
        return;
      }

      const applySize = () => {
        const rect = container.getBoundingClientRect();
        const dpr = Math.min(window.devicePixelRatio || 1, 3);
        dprRef.current = dpr;

        canvas.width = Math.max(1, Math.round(rect.width * dpr));
        canvas.height = Math.max(1, Math.round(rect.height * dpr));
        canvas.style.width = `${rect.width}px`;
        canvas.style.height = `${rect.height}px`;

        const ctx = canvas.getContext("2d");
        ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
        redraw();
      };

      applySize();
      const observer = new ResizeObserver(applySize);
      observer.observe(container);
      return () => observer.disconnect();
    }, [redraw]);

    useImperativeHandle(ref, () => ({
      exportCanvas() {
        const canvas = canvasRef.current;
        if (!canvas || strokesRef.current.length === 0) {
          return null;
        }

        // 以原生解析度重播全部筆畫，輸出透明背景畫布
        const output = document.createElement("canvas");
        output.width = canvas.width;
        output.height = canvas.height;
        const ctx = output.getContext("2d");
        if (!ctx) {
          return null;
        }

        ctx.setTransform(dprRef.current, 0, 0, dprRef.current, 0, 0);
        for (const stroke of strokesRef.current) {
          drawStroke(ctx, stroke);
        }

        return output;
      },
    }));

    const pointFromEvent = useCallback(
      (event: React.PointerEvent<HTMLCanvasElement>): StrokePoint => {
        const rect = event.currentTarget.getBoundingClientRect();
        return { x: event.clientX - rect.left, y: event.clientY - rect.top };
      },
      [],
    );

    const handlePointerDown = useCallback(
      (event: React.PointerEvent<HTMLCanvasElement>) => {
        if (!event.isPrimary) {
          return;
        }

        event.currentTarget.setPointerCapture(event.pointerId);

        const stroke: Stroke = {
          color,
          size,
          isEraser,
          points: [pointFromEvent(event)],
        };
        activeStrokeRef.current = stroke;
        strokesRef.current.push(stroke);

        const ctx = event.currentTarget.getContext("2d");
        if (ctx) {
          drawStroke(ctx, stroke);
        }
      },
      [color, size, isEraser, pointFromEvent],
    );

    const handlePointerMove = useCallback(
      (event: React.PointerEvent<HTMLCanvasElement>) => {
        const stroke = activeStrokeRef.current;
        if (!stroke) {
          return;
        }

        const previous = stroke.points[stroke.points.length - 1];
        const point = pointFromEvent(event);

        // 距離太近的取樣直接丟棄，控制點數與檔案大小
        if (
          previous &&
          Math.hypot(point.x - previous.x, point.y - previous.y) < 1.5
        ) {
          return;
        }

        stroke.points.push(point);

        // 只畫最新一小段，避免每次 move 都全量重畫
        const ctx = event.currentTarget.getContext("2d");
        if (ctx && previous) {
          ctx.save();
          ctx.globalCompositeOperation = stroke.isEraser
            ? "destination-out"
            : "source-over";
          ctx.strokeStyle = stroke.color;
          ctx.lineWidth = stroke.size;
          ctx.lineCap = "round";
          ctx.beginPath();
          ctx.moveTo(previous.x, previous.y);
          ctx.lineTo(point.x, point.y);
          ctx.stroke();
          ctx.restore();
        }
      },
      [pointFromEvent],
    );

    const handlePointerEnd = useCallback(() => {
      if (activeStrokeRef.current) {
        activeStrokeRef.current = null;
        setStrokeCount(strokesRef.current.length);
      }
    }, []);

    const handleUndo = useCallback(() => {
      strokesRef.current.pop();
      setStrokeCount(strokesRef.current.length);
      redraw();
    }, [redraw]);

    const handleClear = useCallback(() => {
      strokesRef.current = [];
      setStrokeCount(0);
      redraw();
    }, [redraw]);

    return (
      <div className="flex h-full min-h-0 flex-col">
        {/* 畫布區 */}
        <div
          ref={containerRef}
          className="relative min-h-0 flex-1 overflow-hidden rounded-lg bg-ink-800"
        >
          <canvas
            ref={canvasRef}
            className="absolute inset-0 touch-none"
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerEnd}
            onPointerCancel={handlePointerEnd}
          />
          {strokeCount === 0 ? (
            <p className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-ink-500">
              在這裡畫出代表你的角色
            </p>
          ) : null}
        </div>

        {/* 工具列 */}
        <div className="mt-3 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex gap-2">
              {BRUSH_SIZES.map((brushSize) => (
                <button
                  key={brushSize}
                  type="button"
                  aria-label={`筆刷 ${brushSize}`}
                  onClick={() => {
                    setSize(brushSize);
                    setIsEraser(false);
                  }}
                  className={`flex size-10 items-center justify-center rounded-full border transition-colors duration-300 ease-world ${
                    !isEraser && size === brushSize
                      ? "border-signal-500 bg-ink-700"
                      : "border-ink-700 bg-ink-900"
                  }`}
                >
                  <span
                    className="rounded-full bg-ink-200"
                    style={{
                      width: Math.max(4, brushSize * 0.7),
                      height: Math.max(4, brushSize * 0.7),
                    }}
                  />
                </button>
              ))}
              <button
                type="button"
                onClick={() => setIsEraser(true)}
                className={`h-10 rounded-full border px-4 text-xs transition-colors duration-300 ease-world ${
                  isEraser
                    ? "border-signal-500 bg-ink-700 text-ink-100"
                    : "border-ink-700 bg-ink-900 text-ink-300"
                }`}
              >
                橡皮擦
              </button>
            </div>

            <div className="flex gap-2">
              <button
                type="button"
                onClick={handleUndo}
                disabled={strokeCount === 0}
                className="h-10 rounded-full border border-ink-700 bg-ink-900 px-4 text-xs text-ink-300 transition-colors duration-300 ease-world disabled:opacity-40"
              >
                復原
              </button>
              <button
                type="button"
                onClick={handleClear}
                disabled={strokeCount === 0}
                className="h-10 rounded-full border border-ink-700 bg-ink-900 px-4 text-xs text-ink-300 transition-colors duration-300 ease-world disabled:opacity-40"
              >
                清空
              </button>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            {PALETTE.map((paletteColor) => (
              <button
                key={paletteColor}
                type="button"
                aria-label={`顏色 ${paletteColor}`}
                onClick={() => {
                  setColor(paletteColor);
                  setIsEraser(false);
                }}
                className={`size-9 rounded-full border-2 transition-transform duration-300 ease-world ${
                  !isEraser && color === paletteColor
                    ? "scale-110 border-signal-400"
                    : "border-ink-700"
                }`}
                style={{ backgroundColor: paletteColor }}
              />
            ))}
          </div>
        </div>
      </div>
    );
  },
);
