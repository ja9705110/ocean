"use client";

import { useEffect, useRef, useState } from "react";
import { OCEAN_CREATURES, renderCreatureLayer } from "@/lib/creatures/ocean";
import type { OceanCreature } from "@/lib/creatures/ocean";

/**
 * 「我覺得我是海洋中的…」
 *
 * 選一個生物當底稿，畫布上會先畫出牠的樣態，參與者再自己加工。
 * 也可以選擇完全空白自己畫——不強迫使用範本。
 */

/** 可選的生物配色 */
const CREATURE_COLORS: readonly string[] = [
  "#4fc3d9",
  "#2f5fd0",
  "#8e5fd0",
  "#f083b0",
  "#e8574c",
  "#f2963a",
  "#f4d03f",
  "#4caf6d",
  "#7ce0b8",
  "#f5f6f8",
];

interface CreaturePickerProps {
  readonly displayName: string;
  readonly onPick: (creature: OceanCreature | null, color: string) => void;
  readonly onBack: () => void;
}

function CreatureThumb({
  creature,
  color,
  selected,
}: {
  readonly creature: OceanCreature;
  readonly color: string;
  readonly selected: boolean;
}) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) {
      return;
    }
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const size = 88;
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);
    ctx.save();
    ctx.scale(size / 100, size / 100);
    creature.draw(ctx, selected ? color : "#5c6880");
    ctx.restore();
  }, [creature, color, selected]);

  return (
    <canvas
      ref={ref}
      style={{ width: 88, height: 88 }}
      className="pointer-events-none"
    />
  );
}

export function CreaturePicker({
  displayName,
  onPick,
  onBack,
}: CreaturePickerProps) {
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [color, setColor] = useState<string>(
    OCEAN_CREATURES[0]?.defaultColor ?? "#4fc3d9",
  );

  const selected =
    OCEAN_CREATURES.find((creature) => creature.key === selectedKey) ?? null;

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col px-6 py-12">
      <button
        type="button"
        onClick={onBack}
        className="self-start text-xs text-ink-600"
      >
        返回
      </button>

      <h2 className="mt-6 text-2xl leading-snug font-light text-ink-100">
        {displayName}，
        <br />
        你覺得你是海洋中的什麼？
      </h2>
      <p className="mt-3 text-sm text-ink-500">
        選一個當底稿，接下來可以自由加工。
      </p>

      <div className="mt-8 grid grid-cols-3 gap-2">
        {OCEAN_CREATURES.map((creature) => {
          const isSelected = creature.key === selectedKey;
          return (
            <button
              key={creature.key}
              type="button"
              onClick={() => {
                setSelectedKey(creature.key);
                setColor(creature.defaultColor);
              }}
              className={`flex flex-col items-center gap-1 rounded-lg border py-3 transition-colors duration-300 ease-world ${
                isSelected
                  ? "border-signal-500 bg-ink-800"
                  : "border-ink-800 bg-ink-900/50"
              }`}
            >
              <CreatureThumb
                creature={creature}
                color={color}
                selected={isSelected}
              />
              <span
                className={`text-xs ${
                  isSelected ? "text-ink-100" : "text-ink-500"
                }`}
              >
                {creature.name}
              </span>
            </button>
          );
        })}
      </div>

      {selected ? (
        <div className="mt-7">
          <p className="text-xs text-ink-400">選個顏色</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {CREATURE_COLORS.map((paletteColor) => (
              <button
                key={paletteColor}
                type="button"
                aria-label={`生物顏色 ${paletteColor}`}
                onClick={() => setColor(paletteColor)}
                className={`size-9 rounded-full border-2 transition-transform duration-300 ease-world ${
                  color === paletteColor
                    ? "scale-110 border-signal-400"
                    : "border-ink-700"
                }`}
                style={{ backgroundColor: paletteColor }}
              />
            ))}
          </div>
        </div>
      ) : null}

      <div className="mt-auto pt-10">
        <button
          type="button"
          disabled={!selected}
          onClick={() => selected && onPick(selected, color)}
          className="w-full rounded-lg bg-signal-500 py-3.5 text-base font-medium text-ink-950 transition-opacity duration-300 ease-world disabled:opacity-30"
        >
          {selected ? `就用${selected.name}開始畫` : "先選一個"}
        </button>
        <button
          type="button"
          onClick={() => onPick(null, color)}
          className="mt-3 w-full py-2 text-sm text-ink-500"
        >
          不用範本，我自己畫
        </button>
      </div>
    </main>
  );
}

export { renderCreatureLayer };
