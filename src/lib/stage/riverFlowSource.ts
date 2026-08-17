"use client";

import {
  DEFAULT_EXCLUSIONS,
  type MaskZone,
  blurMask,
  buildMask,
  flowField,
  sampleFlow,
  sampleMask,
  seedCells,
} from "@/lib/stage/riverMask";

/**
 * 主視覺河道的遮罩與流場，計算一次、兩邊共用（C5）。
 *
 * 「兩邊」是指流動層（RiverFlowOverlay，Canvas 2D）與簽名
 * （WorldRenderer 裡的角色）。兩邊各算一次的話會有兩個問題：
 * 讀圖與掃描要跑兩次，而且只要有一邊的參數不小心改了，
 * 簽名就會沿著跟光流不一樣的路徑走——那正是最難察覺的那種錯。
 *
 * 快取以圖片網址為鍵。主持人換圖時網址會變（上傳路徑帶時間戳），
 * 所以不會拿到舊的遮罩。
 */

/** 遮罩解析度。柔化過的遮罩不需要更高，這個尺寸夠用也算得快。 */
export const MASK_WIDTH = 480;
export const MASK_HEIGHT = 270;

/** 遮罩邊緣的柔化半徑（以遮罩格子計） */
const MASK_BLUR = 4;

/**
 * 下游方向的提示。
 *
 * 影像本身分不出一條河往哪邊流，必須告訴它。
 * 「流嚮」主視覺的河道是從右上進來、往左下流出去。
 */
export const DOWNSTREAM = { x: -0.62, y: 0.78 };

export interface RiverFlow {
  /** 0~1 的遮罩，長度為 MASK_WIDTH * MASK_HEIGHT */
  readonly mask: Float32Array;
  /** 每格兩個數字的單位向量場 */
  readonly field: Float32Array;
  /** 可以當出生地的格子索引，已依遮罩值加權 */
  readonly seeds: readonly number[];
  /** 遮罩圖層，合成時用來裁形狀 */
  readonly maskCanvas: HTMLCanvasElement;
}

const cache = new Map<string, Promise<RiverFlow>>();

/** 取得（必要時計算）某張主視覺的河道遮罩與流場 */
export function loadRiverFlow(imageUrl: string): Promise<RiverFlow> {
  const cached = cache.get(imageUrl);
  if (cached) {
    return cached;
  }

  const task = compute(imageUrl).catch((error: unknown) => {
    // 失敗不要留在快取裡，否則之後每次都拿到同一個失敗
    cache.delete(imageUrl);
    throw error;
  });
  cache.set(imageUrl, task);
  return task;
}

async function compute(imageUrl: string): Promise<RiverFlow> {
  const image = await loadImage(imageUrl);

  const probe = document.createElement("canvas");
  probe.width = MASK_WIDTH;
  probe.height = MASK_HEIGHT;
  const probeCtx = probe.getContext("2d", { willReadFrequently: true });
  if (!probeCtx) {
    throw new Error("無法建立畫布");
  }

  probeCtx.drawImage(image, 0, 0, MASK_WIDTH, MASK_HEIGHT);
  const pixels = probeCtx.getImageData(0, 0, MASK_WIDTH, MASK_HEIGHT).data;

  const raw = buildMask(pixels, MASK_WIDTH, MASK_HEIGHT, DEFAULT_EXCLUSIONS);
  const mask = blurMask(raw, MASK_WIDTH, MASK_HEIGHT, MASK_BLUR);
  const field = flowField(mask, MASK_WIDTH, MASK_HEIGHT, DOWNSTREAM);
  const seeds = seedCells(mask);

  const maskCanvas = document.createElement("canvas");
  maskCanvas.width = MASK_WIDTH;
  maskCanvas.height = MASK_HEIGHT;
  const maskCtx = maskCanvas.getContext("2d");
  if (!maskCtx) {
    throw new Error("無法建立畫布");
  }

  const maskImage = maskCtx.createImageData(MASK_WIDTH, MASK_HEIGHT);
  for (let i = 0; i < mask.length; i += 1) {
    // 柔化過的遮罩峰值大約只有 0.5，直接拿來當透明度會把光效壓掉一半。
    // 放大之後河道內部是滿的，只有邊緣還留著漸變。
    const value = Math.min(1, (mask[i] ?? 0) * 2.4);
    maskImage.data[i * 4] = 255;
    maskImage.data[i * 4 + 1] = 255;
    maskImage.data[i * 4 + 2] = 255;
    maskImage.data[i * 4 + 3] = Math.round(value * 255);
  }
  maskCtx.putImageData(maskImage, 0, 0);

  return { mask, field, seeds, maskCanvas };
}

/**
 * 把畫面座標換算成遮罩座標。
 *
 * 兩邊都是同一個置中的 16:9 矩形，所以是單純的線性縮放。
 * 這個換算是「簽名不會偏離河道」的全部依據，因此必須只有這一份。
 */
export function toMaskSpace(
  x: number,
  y: number,
  width: number,
  height: number,
): { readonly x: number; readonly y: number } {
  return {
    x: (x / Math.max(1, width)) * MASK_WIDTH,
    y: (y / Math.max(1, height)) * MASK_HEIGHT,
  };
}

/** 把遮罩座標換算回畫面座標 */
export function toScreenSpace(
  x: number,
  y: number,
  width: number,
  height: number,
): { readonly x: number; readonly y: number } {
  return {
    x: (x / MASK_WIDTH) * width,
    y: (y / MASK_HEIGHT) * height,
  };
}

/** 在河道裡隨機挑一個出生點，回傳畫面座標 */
export function randomSeedPoint(
  flow: RiverFlow,
  width: number,
  height: number,
): { readonly x: number; readonly y: number } {
  const cell =
    flow.seeds[Math.floor(Math.random() * flow.seeds.length)] ?? 0;
  // 格子內隨機抖一下，否則所有東西都會落在格子中心，形成網格感
  return toScreenSpace(
    (cell % MASK_WIDTH) + Math.random(),
    Math.floor(cell / MASK_WIDTH) + Math.random(),
    width,
    height,
  );
}

/** 畫面座標上的水流方向 */
export function flowAt(
  flow: RiverFlow,
  x: number,
  y: number,
  width: number,
  height: number,
): { readonly x: number; readonly y: number } {
  const point = toMaskSpace(x, y, width, height);
  return sampleFlow(flow.field, MASK_WIDTH, MASK_HEIGHT, point.x, point.y);
}

/**
 * 這個畫面座標是不是落在手工排除區裡（logo、左側文字、右下角的 25）。
 *
 * 光流層靠遮罩就夠了，但簽名是一整張圖、比河道寬得多：
 * 中心點還在河上，圖的邊緣已經蓋到標題了。下游又正好從標題那一側流出去，
 * 所以簽名需要這一條額外的規則，光靠遮罩擋不住。
 *
 * margin 是額外的安全距離（畫面寬度的比例），讓簽名在還沒碰到文字前就先淡出。
 */
export function inExcludedZone(
  x: number,
  y: number,
  width: number,
  height: number,
  margin = 0.03,
): boolean {
  const nx = x / Math.max(1, width);
  const ny = y / Math.max(1, height);

  return (DEFAULT_EXCLUSIONS as readonly MaskZone[]).some(
    (zone) =>
      nx >= zone.x - margin &&
      nx <= zone.x + zone.w + margin &&
      ny >= zone.y - margin &&
      ny <= zone.y + zone.h + margin,
  );
}

/** 畫面座標上的遮罩值，0 表示不在河道裡 */
export function maskAt(
  flow: RiverFlow,
  x: number,
  y: number,
  width: number,
  height: number,
): number {
  const point = toMaskSpace(x, y, width, height);
  return sampleMask(flow.mask, MASK_WIDTH, MASK_HEIGHT, point.x, point.y);
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    // 要用 getImageData 量遮罩，跨網域的圖沒有這一行會污染畫布
    image.crossOrigin = "anonymous";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`背景圖載入失敗：${url}`));
    image.src = url;
  });
}
