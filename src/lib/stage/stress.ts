"use client";

import type { CharacterData } from "@/world/types";

/**
 * 壓力測試模式（M5）：在本機生成 N 隻獨一無二的假角色。
 *
 * 每隻都是獨立的 256px 貼圖（data URL），刻意不共用——
 * 真實活動中 350 位參與者的圖各不相同，GPU 記憶體壓力必須照實模擬。
 * 使用方式：/stage/{code}?stress=350
 */

const COLORS = [
  "#e8574c", "#f2963a", "#f4d03f", "#4caf6d", "#4fc3d9",
  "#2f5fd0", "#8e5fd0", "#f083b0", "#f5f6f8", "#7ce0b8",
  "#ffb066", "#66c7ff", "#d98ef0", "#fff2a8",
];

function drawFish(ctx: CanvasRenderingContext2D, seed: number): void {
  const color = COLORS[seed % COLORS.length] ?? "#4fc3d9";
  const bodyH = 34 + (seed % 5) * 7;
  const bodyW = 60 + (seed % 4) * 6;

  ctx.lineCap = "round";
  ctx.strokeStyle = color;
  ctx.lineWidth = 12 + (seed % 3) * 3;

  ctx.beginPath();
  ctx.ellipse(118, 128, bodyW, bodyH, 0, 0, Math.PI * 2);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(118 + bodyW, 128);
  ctx.lineTo(230, 100 + (seed % 6) * 4);
  ctx.moveTo(118 + bodyW, 128);
  ctx.lineTo(230, 158);
  ctx.stroke();

  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.arc(118 - bodyW * 0.55, 116, 11, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#101625";
  ctx.beginPath();
  ctx.arc(118 - bodyW * 0.52, 116, 5, 0, Math.PI * 2);
  ctx.fill();

  if (seed % 2 === 0) {
    ctx.lineWidth = 7;
    ctx.beginPath();
    ctx.moveTo(100, 128 - bodyH * 0.7);
    ctx.lineTo(106, 128 + bodyH * 0.7);
    ctx.moveTo(130, 128 - bodyH * 0.7);
    ctx.lineTo(136, 128 + bodyH * 0.7);
    ctx.stroke();
  }
}

export function generateStressCharacters(count: number): CharacterData[] {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return [];
  }

  const characters: CharacterData[] = [];
  const base = Date.now();

  for (let i = 0; i < count; i += 1) {
    ctx.clearRect(0, 0, 256, 256);
    drawFish(ctx, i);
    characters.push({
      id: `stress-${i}`,
      displayName: `壓測${i}`,
      characterName: null,
      imageUrl: canvas.toDataURL("image/png"),
      joinedAt: new Date(base - (count - i) * 1000).toISOString(),
    });
  }

  return characters;
}
