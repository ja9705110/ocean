"use client";

import { useEffect, useRef } from "react";
import { RIVER_STENCILS, drawStencil } from "@/lib/creatures/riverStencils";
import type { RiverStencil } from "@/lib/creatures/riverStencils";

/**
 * 彩繪的樣式選擇（C21）。
 *
 * 遞一張全白的畫布給人，最常聽到的回應是「我又不會畫畫」。
 * 給一張已經有輪廓的圖就不一樣了——那變成塗顏色，不是創作。
 *
 * 縮圖是當場畫出來的，不是圖檔。報到那幾分鐘場館 Wi-Fi 最擠，
 * 三十六張縮圖就是三十六次可能失敗的請求；用畫的一次都不用。
 */

/** 縮圖邊長（CSS 像素）。實際畫布會乘上裝置像素比。 */
const THUMB = 96;

interface StencilPickerProps {
  readonly onPick: (stencil: RiverStencil | null) => void;
  readonly onBack: () => void;
}

function Thumb({
  stencil,
  onPick,
}: {
  readonly stencil: RiverStencil;
  readonly onPick: () => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) {
      return;
    }
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    canvas.width = THUMB * dpr;
    canvas.height = THUMB * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.scale(THUMB / 100, THUMB / 100);
    // 縮圖比畫布小很多，線要粗一點才看得清楚形狀
    drawStencil(ctx, stencil, "#ffe0a3", 3.2);
  }, [stencil]);

  return (
    <button
      type="button"
      onClick={onPick}
      className="flex flex-col items-center rounded-xl border border-[#1d3a63] bg-[#061020] p-2 transition-colors duration-200 active:border-[#f2c063]"
    >
      <canvas
        ref={ref}
        style={{ width: THUMB, height: THUMB }}
        className="block"
      />
      <span className="mt-1 text-xs text-[#9fbde0]">{stencil.name}</span>
    </button>
  );
}

export function StencilPicker({ onPick, onBack }: StencilPickerProps) {
  return (
    <main className="mx-auto flex h-dvh max-w-md flex-col bg-[#050c1c] px-5 pt-5 pb-6">
      <div className="flex shrink-0 items-baseline justify-between">
        <p className="text-sm text-[#9fbde0]">挑一張來塗</p>
        <button type="button" onClick={onBack} className="text-xs text-[#4a6c9a]">
          返回
        </button>
      </div>
      <p className="mt-1 shrink-0 text-xs leading-relaxed text-[#5b7fae]">
        全部都是河的意象。挑好之後線稿會出現在畫布上，你只要上色、
        加自己的東西就好。
      </p>

      <div className="mt-4 min-h-0 flex-1 overflow-y-auto">
        <div className="grid grid-cols-3 gap-2 pb-4">
          {/* 想自己畫的人不該被逼著挑一張，所以空白排在第一個 */}
          <button
            type="button"
            onClick={() => onPick(null)}
            className="flex flex-col items-center justify-center rounded-xl border border-dashed border-[#2a4a78] bg-[#061020] p-2 transition-colors duration-200 active:border-[#f2c063]"
            style={{ minHeight: THUMB + 28 }}
          >
            <span className="text-sm text-[#9fbde0]">空白</span>
            <span className="mt-1 text-xs text-[#5b7fae]">自己畫</span>
          </button>

          {RIVER_STENCILS.map((stencil) => (
            <Thumb
              key={stencil.key}
              stencil={stencil}
              onPick={() => onPick(stencil)}
            />
          ))}
        </div>
      </div>
    </main>
  );
}
