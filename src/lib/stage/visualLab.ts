"use client";

import { blurMask, goldness } from "@/lib/stage/riverMask";
import {
  ALPHA_RATIO_THRESHOLD,
  LAB_MASK_HEIGHT,
  LAB_MASK_WIDTH,
  OPAQUE_ALPHA,
  dilateMask,
  type ImageReport,
} from "@/lib/stage/visualAssets";

/**
 * 主視覺測試台需要 DOM 的那一半（C8）：讀檔、讀像素、建遮罩。
 *
 * 規格與檢查在 visualAssets.ts，那邊沒有 DOM，可以直接被檢查腳本呼叫。
 */

export {
  ALPHA_RATIO_THRESHOLD,
  LAB_MASK_HEIGHT,
  LAB_MASK_WIDTH,
  VISUAL_HEIGHT,
  VISUAL_WIDTH,
  dilateMask,
  validatePair,
  type ImageReport,
  type ValidationIssue,
} from "@/lib/stage/visualAssets";

export async function analyzeImage(file: File): Promise<ImageReport> {
  const src = URL.createObjectURL(file);
  const image = await loadImage(src).catch((error: unknown) => {
    URL.revokeObjectURL(src);
    throw error instanceof Error
      ? new Error(`${file.name} 打不開，請確認是圖片檔。`)
      : new Error("圖片讀取失敗");
  });
  const width = image.naturalWidth;
  const height = image.naturalHeight;

  // 只抽樣一小張來判斷透明度：整張 1672×941 掃一次沒有必要，
  // 而「有沒有透明區域」在縮圖上一樣看得出來
  const probe = document.createElement("canvas");
  probe.width = LAB_MASK_WIDTH;
  probe.height = LAB_MASK_HEIGHT;
  const ctx = probe.getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    throw new Error("無法建立畫布");
  }
  ctx.clearRect(0, 0, LAB_MASK_WIDTH, LAB_MASK_HEIGHT);
  ctx.drawImage(image, 0, 0, LAB_MASK_WIDTH, LAB_MASK_HEIGHT);
  const data = ctx.getImageData(0, 0, LAB_MASK_WIDTH, LAB_MASK_HEIGHT).data;

  let transparent = 0;
  const total = LAB_MASK_WIDTH * LAB_MASK_HEIGHT;
  for (let i = 0; i < total; i += 1) {
    if ((data[i * 4 + 3] ?? 255) < OPAQUE_ALPHA) {
      transparent += 1;
    }
  }

  const transparentRatio = transparent / total;

  return {
    name: file.name,
    width,
    height,
    hasAlpha: transparentRatio > ALPHA_RATIO_THRESHOLD,
    transparentRatio,
    image,
    src,
  };
}

/** 換掉一張圖時要釋放舊的 object URL，否則整頁會一直吃著記憶體 */
export function releaseImage(report: ImageReport | null): void {
  if (report) {
    URL.revokeObjectURL(report.src);
  }
}

export interface LabMasks {
  /** 允許動畫的區域：金色河道，且不在文字上 */
  readonly flow: Float32Array;
  /** 文字保護區（去背 PNG 的不透明處，已擴張） */
  readonly text: Float32Array;
  /** 完整版主視覺的像素，動畫的顏色從這裡取樣 */
  readonly source: Uint8ClampedArray;
}

/**
 * 建立遮罩。
 *
 * 流動遮罩 = 完整版的金色河道 × (1 − 文字保護區)。
 *
 * 文字保護區要「擴張」幾格：字的周圍有一圈發光與抗鋸齒，
 * 只擋住不透明的像素，光絲會貼著筆畫邊緣爬過去，看起來像文字在滲光。
 */
export function buildLabMasks(
  full: HTMLImageElement,
  overlay: HTMLImageElement,
  dilate = 3,
): LabMasks {
  const W = LAB_MASK_WIDTH;
  const H = LAB_MASK_HEIGHT;

  const read = (image: HTMLImageElement): Uint8ClampedArray => {
    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) {
      throw new Error("無法建立畫布");
    }
    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(image, 0, 0, W, H);
    return ctx.getImageData(0, 0, W, H).data;
  };

  const source = read(full);
  const overlayPixels = read(overlay);

  // 文字：去背圖上不透明的地方
  const rawText = new Float32Array(W * H);
  for (let i = 0; i < W * H; i += 1) {
    rawText[i] = (overlayPixels[i * 4 + 3] ?? 0) >= OPAQUE_ALPHA ? 1 : 0;
  }

  const text = dilateMask(rawText, W, H, dilate);

  // 河道：完整版上的金色，扣掉文字保護區
  const flow = new Float32Array(W * H);
  for (let i = 0; i < W * H; i += 1) {
    const gold = goldness(
      source[i * 4] ?? 0,
      source[i * 4 + 1] ?? 0,
      source[i * 4 + 2] ?? 0,
    );
    flow[i] = gold * (1 - (text[i] ?? 0));
  }

  return { flow: blurMask(flow, W, H, 3), text, source };
}

/** 取樣完整版主視覺的顏色，動畫的光絲用它上色 */
export function sampleSourceColor(
  source: Uint8ClampedArray,
  x: number,
  y: number,
): { readonly r: number; readonly g: number; readonly b: number } {
  const cx = Math.min(LAB_MASK_WIDTH - 1, Math.max(0, Math.round(x)));
  const cy = Math.min(LAB_MASK_HEIGHT - 1, Math.max(0, Math.round(y)));
  const i = (cy * LAB_MASK_WIDTH + cx) * 4;
  return {
    r: source[i] ?? 0,
    g: source[i + 1] ?? 0,
    b: source[i + 2] ?? 0,
  };
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("圖片讀取失敗"));
    image.src = url;
  });
}
