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
 * 簽名板。
 *
 * 為什麼不沿用 DrawingCanvas：畫角色需要十種顏色、三種筆刷、橡皮擦、
 * 照片圖層；簽名只需要一支筆。多餘的工具在報到台是負擔——
 * 兩百個人排隊，每多一個要思考的按鈕就多兩百次猶豫。
 *
 * 為什麼底色是深藍、筆是金色：簽完之後這個簽名會直接出現在大螢幕的
 * 河道上，而河道是深藍底金色光流。手機上簽的樣子就是牆上的樣子，
 * 不會發生「在白紙上簽了黑字、投出來卻看不見」。
 *
 * 筆畫以點序列保存（向量），因此：
 * - 復原＝丟掉最後一筆重畫
 * - 匯出＝在原生解析度重播，跟螢幕大小無關
 * - 匯出的畫布是透明背景，直接餵給角色圖片管線
 */

interface SignaturePoint {
  readonly x: number;
  readonly y: number;
}

type Stroke = SignaturePoint[];

export interface SignaturePadHandle {
  /** 匯出簽名：透明背景、原生解析度；一筆都沒簽時回傳 null */
  exportCanvas(): HTMLCanvasElement | null;
  clear(): void;
  undo(): void;
  /** 目前有幾筆 */
  strokeCount(): number;
}

export interface SignaturePadProps {
  /** 筆畫變動時通知外層（用來啟用／停用「簽好了」按鈕） */
  readonly onStrokeCountChange?: (count: number) => void;
  /**
   * 這塊板子被外層用 CSS 轉了 90 度（橫向簽名）。
   *
   * 轉過之後 getBoundingClientRect 給的是「轉完之後」的外接矩形，
   * 拿它直接減 clientX/clientY 會得到完全錯位的座標——手指在左上，
   * 筆畫卻畫在右上。所以要在這裡把手指座標轉回畫布自己的方向。
   */
  readonly rotated?: boolean;
}

/** 簽名墨色：主視覺的暖金色，投到深藍河道上最清楚 */
const INK = "#ffe0a3";
/**
 * 筆寬相對於簽名板短邊的比例，並夾在一個範圍內。
 *
 * 取短邊而不是高度：直立的手機上簽名板是又高又窄的，
 * 用高度算出來的筆會粗得像麥克筆，簽出來的字全部糊在一起。
 * 上下限則是為了讓平板與小手機簽出來的粗細相近。
 */
const STROKE_RATIO = 0.014;
const MIN_STROKE = 3;
const MAX_STROKE = 7;

/** 取樣過密只會讓筆畫變重，這個距離以下的點直接丟掉 */
const MIN_SAMPLE_DISTANCE = 1.2;

/**
 * 以中點二次曲線把折線畫成平滑曲線。
 *
 * 直接 lineTo 會讓簽名出現一節一節的稜角——那是簽名最容易被看出
 * 「是電子板簽的」的地方。中點法只需要相鄰兩點，可以邊簽邊畫，
 * 不必等整筆結束。
 */
function tracePath(ctx: CanvasRenderingContext2D, points: Stroke): void {
  const first = points[0];
  if (!first) {
    return;
  }

  if (points.length === 1) {
    ctx.beginPath();
    ctx.arc(first.x, first.y, ctx.lineWidth / 2, 0, Math.PI * 2);
    ctx.fillStyle = ctx.strokeStyle as string;
    ctx.fill();
    return;
  }

  ctx.beginPath();
  ctx.moveTo(first.x, first.y);

  for (let i = 1; i < points.length - 1; i += 1) {
    const current = points[i];
    const next = points[i + 1];
    if (!current || !next) {
      break;
    }
    ctx.quadraticCurveTo(
      current.x,
      current.y,
      (current.x + next.x) / 2,
      (current.y + next.y) / 2,
    );
  }

  const last = points[points.length - 1];
  if (last) {
    ctx.lineTo(last.x, last.y);
  }
  ctx.stroke();
}

export const SignaturePad = forwardRef<SignaturePadHandle, SignaturePadProps>(
  function SignaturePad({ onStrokeCountChange, rotated = false }, ref) {
    const containerRef = useRef<HTMLDivElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const strokesRef = useRef<Stroke[]>([]);
    const activeRef = useRef<Stroke | null>(null);
    const dprRef = useRef(1);
    const lineWidthRef = useRef(6);

    const [count, setCount] = useState(0);

    // onStrokeCountChange 每次 render 都是新的函式，放進 ref 才不會
    // 讓每一筆都重建繪圖用的 callback
    const notifyRef = useRef(onStrokeCountChange);
    useEffect(() => {
      notifyRef.current = onStrokeCountChange;
    });

    const setCounts = useCallback((next: number) => {
      setCount(next);
      notifyRef.current?.(next);
    }, []);

    const redraw = useCallback(() => {
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext("2d");
      if (!canvas || !ctx) {
        return;
      }

      const dpr = dprRef.current;
      ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr);
      ctx.strokeStyle = INK;
      ctx.lineWidth = lineWidthRef.current;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";

      for (const stroke of strokesRef.current) {
        tracePath(ctx, stroke);
      }
    }, []);

    useEffect(() => {
      const container = containerRef.current;
      const canvas = canvasRef.current;
      if (!container || !canvas) {
        return;
      }

      const applySize = () => {
        // 用 offsetWidth/offsetHeight 而不是 getBoundingClientRect：
        // 橫向簽名時整塊板子被 CSS 轉了 90 度，rect 給的是轉完之後的
        // 外接矩形（寬高對調），照它配置畫布會得到一塊比例完全相反的板子。
        // offset* 是版面尺寸，不受 transform 影響。
        const width = container.offsetWidth;
        const height = container.offsetHeight;
        const dpr = Math.min(window.devicePixelRatio || 1, 3);
        dprRef.current = dpr;
        lineWidthRef.current = Math.min(
          MAX_STROKE,
          Math.max(MIN_STROKE, Math.min(width, height) * STROKE_RATIO),
        );

        canvas.width = Math.max(1, Math.round(width * dpr));
        canvas.height = Math.max(1, Math.round(height * dpr));
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;
        canvas.getContext("2d")?.setTransform(dpr, 0, 0, dpr, 0, 0);

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

        const output = document.createElement("canvas");
        output.width = canvas.width;
        output.height = canvas.height;

        const ctx = output.getContext("2d");
        if (!ctx) {
          return null;
        }

        ctx.setTransform(dprRef.current, 0, 0, dprRef.current, 0, 0);
        ctx.strokeStyle = INK;
        ctx.lineWidth = lineWidthRef.current;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";

        for (const stroke of strokesRef.current) {
          tracePath(ctx, stroke);
        }

        return output;
      },
      clear() {
        strokesRef.current = [];
        setCounts(0);
        redraw();
      },
      undo() {
        strokesRef.current.pop();
        setCounts(strokesRef.current.length);
        redraw();
      },
      strokeCount() {
        return strokesRef.current.length;
      },
    }));

    const pointFrom = useCallback(
      (event: React.PointerEvent<HTMLCanvasElement>): SignaturePoint => {
        const rect = event.currentTarget.getBoundingClientRect();

        if (!rotated) {
          return { x: event.clientX - rect.left, y: event.clientY - rect.top };
        }

        /*
          外層用的是 `rotate(90deg) translateY(-100%)`，原點在左上。
          畫布上的 (x, y) 會落到螢幕的 (H - y, x)，其中 H 是畫布自己的
          高度、也就是轉完之後外接矩形的寬。反過來解就是下面兩行。

          這段跟 SignatureSheet 的 CSS 是一組的，改一邊另一邊一定要跟著改。
        */
        return {
          x: event.clientY - rect.top,
          y: event.currentTarget.offsetHeight - (event.clientX - rect.left),
        };
      },
      [rotated],
    );

    const handleDown = useCallback(
      (event: React.PointerEvent<HTMLCanvasElement>) => {
        if (!event.isPrimary) {
          return;
        }
        event.currentTarget.setPointerCapture(event.pointerId);

        const stroke: Stroke = [pointFrom(event)];
        activeRef.current = stroke;
        strokesRef.current.push(stroke);
        redraw();
      },
      [pointFrom, redraw],
    );

    const handleMove = useCallback(
      (event: React.PointerEvent<HTMLCanvasElement>) => {
        const stroke = activeRef.current;
        if (!stroke) {
          return;
        }

        const point = pointFrom(event);
        const previous = stroke[stroke.length - 1];
        if (
          previous &&
          Math.hypot(point.x - previous.x, point.y - previous.y) <
            MIN_SAMPLE_DISTANCE
        ) {
          return;
        }

        stroke.push(point);

        // 只重畫這一筆的最後一小段。全量重畫在筆畫多時會掉幀，
        // 簽名跟不上手指是最明顯的體感問題
        const ctx = event.currentTarget.getContext("2d");
        if (ctx && stroke.length >= 3) {
          const a = stroke[stroke.length - 3];
          const b = stroke[stroke.length - 2];
          const c = stroke[stroke.length - 1];
          if (a && b && c) {
            ctx.strokeStyle = INK;
            ctx.lineWidth = lineWidthRef.current;
            ctx.lineCap = "round";
            ctx.lineJoin = "round";
            ctx.beginPath();
            ctx.moveTo((a.x + b.x) / 2, (a.y + b.y) / 2);
            ctx.quadraticCurveTo(b.x, b.y, (b.x + c.x) / 2, (b.y + c.y) / 2);
            ctx.stroke();
          }
        }
      },
      [pointFrom],
    );

    const handleEnd = useCallback(() => {
      if (activeRef.current) {
        activeRef.current = null;
        setCounts(strokesRef.current.length);
        // 收筆時整筆重畫一次，讓中間的即時段與最終曲線一致
        redraw();
      }
    }, [redraw, setCounts]);

    return (
      <div
        ref={containerRef}
        className="relative h-full w-full overflow-hidden rounded-xl border border-[#1d3a63] bg-[#061020]"
      >
        <canvas
          ref={canvasRef}
          className="absolute inset-0 touch-none"
          onPointerDown={handleDown}
          onPointerMove={handleMove}
          onPointerUp={handleEnd}
          onPointerCancel={handleEnd}
        />
        {/* 簽名線：給手一個落筆的位置，跟紙本簽到簿一樣 */}
        <div className="pointer-events-none absolute right-8 bottom-[30%] left-8 border-b border-dashed border-[#2a4a78]" />
        {count === 0 ? (
          <p className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-[#5b7fae]">
            在這裡簽下你的名字
          </p>
        ) : null}
      </div>
    );
  },
);
