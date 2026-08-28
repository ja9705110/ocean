"use client";

import { SignaturePad } from "@/components/checkin/SignaturePad";
import type { SignaturePadHandle } from "@/components/checkin/SignaturePad";
import type { RefObject } from "react";

/**
 * 橫向簽名（C18）。
 *
 * 直立的手機上，簽名板是一條又高又窄的長條。中文名字是橫著寫的，
 * 三個字寫下來手要一直往右伸，最後一個字通常擠在邊上——
 * 那不是本人平常簽出來的樣子。
 *
 * 解法是把整塊板子轉九十度，讓使用者把手機打橫拿。轉的是畫面不是
 * 手機：現場很多人開著旋轉鎖定，等系統自己轉是等不到的。
 *
 * 轉過來之後畫布的方向就已經是「正的」了——使用者橫著拿手機看到的
 * 上方，就是畫布的上方。所以簽完直接匯出就是正的，不需要再轉一次。
 *
 * 這裡的 CSS 跟 SignaturePad 裡的座標換算是一組的：
 *
 *   rotate(90deg) translateY(-100%)，原點左上
 *   → 畫布上的 (x, y) 落在螢幕的 (H - y, x)，H 是畫布的高
 *
 * 改這裡的 transform，那邊的 pointFrom 一定要跟著改，
 * 否則手指在左上、筆畫會出現在右上。
 */

interface SignatureSheetProps {
  readonly padRef: RefObject<SignaturePadHandle | null>;
  readonly name: string;
  readonly strokeCount: number;
  readonly onStrokeCountChange: (count: number) => void;
  /** 收起橫向模式，回到原本的直立畫面 */
  readonly onDone: () => void;
}

export function SignatureSheet({
  padRef,
  name,
  strokeCount,
  onStrokeCountChange,
  onDone,
}: SignatureSheetProps) {
  return (
    <div className="fixed inset-0 z-50 overflow-hidden bg-[#050c1c]">
      <div
        className="absolute top-0 left-0 flex flex-col px-5 py-4"
        style={{
          width: "100vh",
          height: "100vw",
          transform: "rotate(90deg) translateY(-100%)",
          transformOrigin: "top left",
        }}
      >
        <div className="flex shrink-0 items-baseline justify-between">
          <p className="text-sm text-[#9fbde0]">{name}，請簽名</p>
          <div className="flex items-baseline gap-5">
            <button
              type="button"
              onClick={() => padRef.current?.undo()}
              disabled={strokeCount === 0}
              className="text-xs text-[#7fa0c8] disabled:opacity-40"
            >
              復原
            </button>
            <button
              type="button"
              onClick={() => padRef.current?.clear()}
              disabled={strokeCount === 0}
              className="text-xs text-[#7fa0c8] disabled:opacity-40"
            >
              清空
            </button>
          </div>
        </div>

        <div className="mt-3 min-h-0 w-full flex-1">
          {/*
            rotated 讓 SignaturePad 把手指座標轉回畫布的方向。
            沒有它的話手指在左上，筆畫會畫在右上。
          */}
          <SignaturePad
            ref={padRef}
            rotated
            onStrokeCountChange={onStrokeCountChange}
          />
        </div>

        <button
          type="button"
          onClick={onDone}
          className="mt-3 shrink-0 rounded-lg bg-[#f2c063] py-3 text-base font-medium text-[#08152b] transition-opacity duration-300 disabled:opacity-30"
          disabled={strokeCount === 0}
        >
          確認，收起來
        </button>
      </div>
    </div>
  );
}
