"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * 雙手握持區。
 *
 * 兩隻拇指都壓在下面兩塊上，感應器才會啟動。這不是介面裝飾——
 * 三百多人同時做划槳動作，沒有這道機制手機一定會飛出去。
 * 放開任何一手就立刻停止計分，玩家會自己學會抓緊。
 *
 * 這裡只負責「有沒有握住」，怎麼判斷划槳交給呼叫端：
 * 晃動偵測用的是加速度，跟這兩塊的座標無關。
 */

export type Grip = "released" | "one-hand" | "held";

export const GRIP_HINT: Record<Grip, string> = {
  released: "兩隻拇指分別壓住下面兩塊",
  "one-hand": "另一隻拇指也要放上來",
  held: "",
};

interface GripPadsProps {
  readonly onGripChange: (grip: Grip) => void;
  /** 0~1，讓兩塊隨著划速一起亮起來，握得越用力划得越快越明顯 */
  readonly intensity: number;
  readonly leftLabel?: string;
  readonly rightLabel?: string;
}

export function GripPads({
  onGripChange,
  intensity,
  leftLabel = "左手",
  rightLabel = "右手",
}: GripPadsProps) {
  const [grip, setGrip] = useState<Grip>("released");
  const pointers = useRef<{ left: number | null; right: number | null }>({
    left: null,
    right: null,
  });

  const onGripChangeRef = useRef(onGripChange);
  useEffect(() => {
    onGripChangeRef.current = onGripChange;
  });

  const sync = useCallback(() => {
    const { left, right } = pointers.current;
    const count = (left === null ? 0 : 1) + (right === null ? 0 : 1);
    const next: Grip =
      count === 2 ? "held" : count === 1 ? "one-hand" : "released";
    setGrip((current) => (current === next ? current : next));
    onGripChangeRef.current(next);
  }, []);

  const down = useCallback(
    (side: "left" | "right") => (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      pointers.current[side] = e.pointerId;
      sync();
    },
    [sync],
  );

  const up = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      for (const side of ["left", "right"] as const) {
        if (pointers.current[side] === e.pointerId) {
          pointers.current[side] = null;
        }
      }
      sync();
    },
    [sync],
  );

  const glow = grip === "held" ? 0.12 + intensity * 0.5 : 0;

  return (
    <div className="relative h-full px-4 pb-6">
      <div className="flex h-full gap-4">
        <Pad
          label={leftLabel}
          glow={glow}
          onPointerDown={down("left")}
          onPointerUp={up}
          onPointerCancel={up}
        />
        <Pad
          label={rightLabel}
          glow={glow}
          onPointerDown={down("right")}
          onPointerUp={up}
          onPointerCancel={up}
        />
      </div>

      {grip !== "held" ? (
        <div className="pointer-events-none absolute inset-x-4 top-1/2 -translate-y-1/2 rounded-2xl bg-ink-950/85 px-6 py-5 text-center">
          <p className="text-sm text-ink-100">{GRIP_HINT[grip]}</p>
          <p className="mt-2 text-xs leading-relaxed text-ink-400">
            按住之後整支手機跟著身體做划船的動作
            <br />
            放開就會停下來
          </p>
        </div>
      ) : null}
    </div>
  );
}

interface PadProps {
  readonly label: string;
  readonly glow: number;
  readonly onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void;
  readonly onPointerUp: (e: React.PointerEvent<HTMLDivElement>) => void;
  readonly onPointerCancel: (e: React.PointerEvent<HTMLDivElement>) => void;
}

function Pad({ label, glow, ...handlers }: PadProps) {
  return (
    <div
      {...handlers}
      className="relative flex flex-1 touch-none items-center justify-center overflow-hidden rounded-3xl border border-ink-700 bg-ink-900 transition-colors duration-200"
      style={{
        backgroundColor: `color-mix(in srgb, var(--color-signal-900) ${Math.round(glow * 100)}%, var(--color-ink-900))`,
      }}
    >
      <span className="text-xs tracking-[0.3em] text-ink-500">{label}</span>
    </div>
  );
}
