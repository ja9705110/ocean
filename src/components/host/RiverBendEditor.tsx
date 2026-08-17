"use client";

import { useCallback, useRef } from "react";
import {
  MAX_BENDS,
  MAX_BEND_V,
  RIVER_CENTER,
  RIVER_SPAN,
  buildRiverGeometry,
  buildRiverPath,
  type RiverBend,
  type RiverShape,
} from "@/lib/stage/riverShape";

/**
 * 轉彎編輯器：直接把河道畫出來，拖點就改形狀。
 *
 * 為什麼不是「彎曲程度」一根滑桿：一根滑桿只能讓同一條 S 彎得多一點
 * 或少一點，改不了「要有幾個彎、往哪邊彎」。這裡一個點就是一個轉彎，
 * 拖到哪邊就往哪邊彎，加一個點就多一個彎。
 *
 * 預覽畫的是「延伸後」的河道，而且畫框外還留了一大圈：
 * 頭尾一定要看得到是穿出畫面的，不然改完形狀還是不知道現場會不會
 * 在畫面裡看到收尾。
 */

/** 畫面在預覽裡的尺寸（16:9），單位是 SVG 座標 */
const SCREEN_W = 16;
const SCREEN_H = 9;
/** 畫框外要留多少，才看得到河從哪裡進來、往哪裡出去 */
const PAD_X = 7;
const PAD_Y = 4;

const HANDLE_R = 0.42;

interface RiverBendEditorProps {
  readonly shape: RiverShape;
  /** 拖曳過程中每一步都會叫（只更新畫面） */
  readonly onChange: (bends: readonly RiverBend[]) => void;
  /** 放開手才叫一次（寫回資料庫） */
  readonly onCommit: () => void;
  readonly disabled?: boolean;
}

/** 正規化座標 → SVG 座標 */
function toSvg(point: { readonly x: number; readonly y: number }) {
  return { x: point.x * SCREEN_W, y: point.y * SCREEN_H };
}

function pathOf(points: readonly { x: number; y: number }[]): string {
  if (points.length === 0) {
    return "";
  }
  // Catmull-Rom 轉成三次貝茲，跟大螢幕上那條是同一條曲線
  const p = points.map(toSvg);
  const at = (i: number) => p[Math.min(Math.max(i, 0), p.length - 1)]!;

  let d = `M ${at(0).x} ${at(0).y}`;
  for (let i = 0; i < p.length - 1; i += 1) {
    const p0 = at(i - 1);
    const p1 = at(i);
    const p2 = at(i + 1);
    const p3 = at(i + 2);
    d += ` C ${p1.x + (p2.x - p0.x) / 6} ${p1.y + (p2.y - p0.y) / 6}`;
    d += ` ${p2.x - (p3.x - p1.x) / 6} ${p2.y - (p3.y - p1.y) / 6}`;
    d += ` ${p2.x} ${p2.y}`;
  }
  return d;
}

export function RiverBendEditor({
  shape,
  onChange,
  onCommit,
  disabled = false,
}: RiverBendEditorProps) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const draggingRef = useRef<number | null>(null);

  const geometry = buildRiverGeometry(shape);
  const body = buildRiverPath(shape);

  // 基準線：轉彎的 u 與 v 是相對於這一條算的
  const radians = (shape.angle * Math.PI) / 180;
  const along = { x: Math.cos(radians), y: Math.sin(radians) };
  const across = { x: -along.y, y: along.x };
  const span = RIVER_SPAN * shape.length;
  const cx = RIVER_CENTER.x + shape.offsetX;
  const cy = RIVER_CENTER.y + shape.offsetY;

  const baseline = [
    { x: cx - along.x * span * 0.5, y: cy - along.y * span * 0.5 },
    { x: cx + along.x * span * 0.5, y: cy + along.y * span * 0.5 },
  ];

  /** 滑鼠位置 → 這個點的 (u, v) */
  const toBend = useCallback(
    (clientX: number, clientY: number): RiverBend | null => {
      const svg = svgRef.current;
      if (!svg) {
        return null;
      }
      const rect = svg.getBoundingClientRect();
      const viewW = SCREEN_W + PAD_X * 2;
      const viewH = SCREEN_H + PAD_Y * 2;
      // SVG 座標
      const sx = ((clientX - rect.left) / rect.width) * viewW - PAD_X;
      const sy = ((clientY - rect.top) / rect.height) * viewH - PAD_Y;
      // 回到正規化座標
      const nx = sx / SCREEN_W;
      const ny = sy / SCREEN_H;

      const dx = nx - cx;
      const dy = ny - cy;
      const forward = dx * along.x + dy * along.y;
      const lateral = dx * across.x + dy * across.y;

      return {
        u: Math.min(0.97, Math.max(0.03, forward / span + 0.5)),
        // v 存的是「還沒乘上長度」的值，跟 buildRiverPath 對稱
        v: Math.min(
          MAX_BEND_V,
          Math.max(-MAX_BEND_V, lateral / Math.max(0.01, shape.length)),
        ),
      };
    },
    [along.x, along.y, across.x, across.y, cx, cy, span, shape.length],
  );

  const handleMove = useCallback(
    (event: React.PointerEvent<SVGSVGElement>) => {
      const index = draggingRef.current;
      if (index === null || disabled) {
        return;
      }
      const bend = toBend(event.clientX, event.clientY);
      if (!bend) {
        return;
      }
      const next = shape.bends.map((existing, i) =>
        i === index ? bend : existing,
      );
      onChange(next);
    },
    [disabled, onChange, shape.bends, toBend],
  );

  const endDrag = useCallback(() => {
    if (draggingRef.current !== null) {
      draggingRef.current = null;
      onCommit();
    }
  }, [onCommit]);

  const addBend = useCallback(() => {
    if (shape.bends.length >= MAX_BENDS) {
      return;
    }
    // 插在最大的空隙中間：使用者按「加一個轉彎」時想要的是
    // 「這條河多一個彎」，不是「在某一端擠出一個彎」
    const sorted = [...shape.bends].sort((a, b) => a.u - b.u);
    const edges = [0, ...sorted.map((b) => b.u), 1];
    let bestGap = -1;
    let bestAt = 0.5;
    for (let i = 0; i < edges.length - 1; i += 1) {
      const gap = edges[i + 1]! - edges[i]!;
      if (gap > bestGap) {
        bestGap = gap;
        bestAt = (edges[i]! + edges[i + 1]!) / 2;
      }
    }
    // 方向跟前一個相反，加出來的是蛇行而不是愈滑愈遠
    const previous = sorted.filter((b) => b.u < bestAt).pop();
    const v = previous && previous.v > 0 ? -0.13 : 0.13;
    onChange([...sorted, { u: bestAt, v }].sort((a, b) => a.u - b.u));
    onCommit();
  }, [onChange, onCommit, shape.bends]);

  const removeBend = useCallback(
    (index: number) => {
      onChange(shape.bends.filter((_, i) => i !== index));
      onCommit();
    },
    [onChange, onCommit, shape.bends],
  );

  const viewBox = `${-PAD_X} ${-PAD_Y} ${SCREEN_W + PAD_X * 2} ${SCREEN_H + PAD_Y * 2}`;

  return (
    <div>
      <svg
        ref={svgRef}
        viewBox={viewBox}
        className="w-full touch-none rounded-lg border border-ink-800 bg-ink-950"
        style={{ aspectRatio: `${SCREEN_W + PAD_X * 2} / ${SCREEN_H + PAD_Y * 2}` }}
        onPointerMove={handleMove}
        onPointerUp={endDrag}
        onPointerLeave={endDrag}
        onPointerCancel={endDrag}
      >
        {/* 畫框外先鋪一層暗色，畫面裡面才是亮的——一眼看出哪裡是螢幕 */}
        <rect
          x={-PAD_X}
          y={-PAD_Y}
          width={SCREEN_W + PAD_X * 2}
          height={SCREEN_H + PAD_Y * 2}
          className="fill-ink-950"
        />
        <rect
          x={0}
          y={0}
          width={SCREEN_W}
          height={SCREEN_H}
          className="fill-ink-900 stroke-ink-700"
          strokeWidth={0.08}
        />
        <text
          x={0.35}
          y={0.95}
          className="fill-ink-600"
          style={{ fontSize: "0.62px" }}
        >
          大螢幕範圍
        </text>

        {/* 基準線：沒有轉彎時河就是這條 */}
        <line
          x1={toSvg(baseline[0]!).x}
          y1={toSvg(baseline[0]!).y}
          x2={toSvg(baseline[1]!).x}
          y2={toSvg(baseline[1]!).y}
          className="stroke-ink-700"
          strokeWidth={0.06}
          strokeDasharray="0.4 0.4"
        />

        {/* 延伸後的完整河道。畫框外那兩段就是「流進來、流出去」的部分 */}
        <path
          d={pathOf(geometry.points)}
          fill="none"
          className="stroke-signal-500"
          strokeWidth={0.5}
          strokeOpacity={0.28}
          strokeLinecap="round"
        />
        <path
          d={pathOf(body)}
          fill="none"
          className="stroke-signal-400"
          strokeWidth={0.16}
          strokeLinecap="round"
        />

        {/* 流向：主體下游端的箭頭 */}
        {(() => {
          const last = body[body.length - 1];
          const prev = body[body.length - 2];
          if (!last || !prev) {
            return null;
          }
          const a = toSvg(prev);
          const b = toSvg(last);
          const angle = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
          return (
            <g transform={`translate(${b.x} ${b.y}) rotate(${angle})`}>
              <path
                d="M 0 0 L -0.9 -0.45 L -0.9 0.45 Z"
                className="fill-signal-400"
              />
            </g>
          );
        })()}

        {/* 轉彎的把手 */}
        {shape.bends.map((bend, index) => {
          const forward = (bend.u - 0.5) * span;
          const lateral = bend.v * shape.length;
          const point = toSvg({
            x: cx + along.x * forward + across.x * lateral,
            y: cy + along.y * forward + across.y * lateral,
          });
          return (
            <g key={`${index}-${bend.u.toFixed(3)}`}>
              <circle
                cx={point.x}
                cy={point.y}
                r={HANDLE_R}
                className="fill-ink-950 stroke-signal-400"
                strokeWidth={0.14}
                style={{ cursor: disabled ? "default" : "grab" }}
                onPointerDown={(event) => {
                  if (disabled) {
                    return;
                  }
                  event.currentTarget.ownerSVGElement?.setPointerCapture(
                    event.pointerId,
                  );
                  draggingRef.current = index;
                }}
                onDoubleClick={() => {
                  if (!disabled) {
                    removeBend(index);
                  }
                }}
              />
              <text
                x={point.x}
                y={point.y + 0.22}
                textAnchor="middle"
                className="pointer-events-none fill-signal-400"
                style={{ fontSize: "0.55px" }}
              >
                {index + 1}
              </text>
            </g>
          );
        })}
      </svg>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={disabled || shape.bends.length >= MAX_BENDS}
          onClick={addBend}
          className="rounded-lg border border-ink-700 px-4 py-2 text-xs text-ink-200 disabled:opacity-40"
        >
          加一個轉彎
        </button>
        <button
          type="button"
          disabled={disabled || shape.bends.length === 0}
          onClick={() => removeBend(shape.bends.length - 1)}
          className="rounded-lg border border-ink-700 px-4 py-2 text-xs text-ink-200 disabled:opacity-40"
        >
          拿掉最後一個
        </button>
        <button
          type="button"
          disabled={disabled || shape.bends.length === 0}
          onClick={() => {
            onChange([]);
            onCommit();
          }}
          className="px-3 py-2 text-xs text-ink-500 disabled:opacity-40"
        >
          拉成直線
        </button>
        <span className="text-xs text-ink-500">
          目前 {shape.bends.length} 個轉彎（最多 {MAX_BENDS} 個）
        </span>
      </div>

      <p className="mt-3 text-xs leading-relaxed text-ink-500">
        直接拖圖上的圓點就會改變河道：往上下拖是換轉彎的方向與幅度，
        沿著河拖是換轉彎的位置。連點兩下可以刪掉那個轉彎。
        <br />
        亮框是大螢幕看得到的範圍，框外那兩段是河流進來與流出去的部分，
        現場不會看到河的頭尾收在畫面裡。
      </p>
    </div>
  );
}
