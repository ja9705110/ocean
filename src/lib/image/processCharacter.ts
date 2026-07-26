"use client";

/**
 * 角色圖片管線（規格第 9 節）：
 * 透明背景 → 自動裁邊 → 縮放 → 編碼 WebP（PNG fallback）。
 *
 * 產出兩種尺寸：
 * - 512px：手機端顯示自己的角色
 * - 256px：大螢幕用。350 張 512px 的貼圖解壓後約 350MB VRAM，
 *   會拖垮中階筆電；256px 約 87MB，安全（規格第 10 節效能目標）。
 */

export interface ProcessedCharacter {
  /** 512px 版本 */
  readonly primary: Blob;
  /** 256px 版本，路徑加上 @256 後綴 */
  readonly small: Blob;
  /** 實際編碼格式的副檔名。Safari 不支援 WebP 編碼時會靜默退回 PNG */
  readonly extension: "webp" | "png";
}

const PRIMARY_SIZE = 512;
const SMALL_SIZE = 256;

/**
 * 各尺寸的位元組上限。
 *
 * 純線條畫在 quality 0.85 下只有幾 KB，但含照片的角色動輒 200KB 以上，
 * 會超過 Storage bucket 的單檔限制而整個送不出去。
 * 因此改為逐步降品質，直到符合上限為止。
 */
const PRIMARY_MAX_BYTES = 150_000;
const SMALL_MAX_BYTES = 60_000;

/** 由高到低嘗試的品質階梯 */
const QUALITY_STEPS: readonly number[] = [0.85, 0.72, 0.6, 0.5, 0.4, 0.3];

/** 視為「有畫過」的最低 alpha 值，過濾抗鋸齒殘影 */
const ALPHA_THRESHOLD = 8;

interface TrimBounds {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** 找出非透明像素的包圍盒；整張全透明時回傳 null */
function findTrimBounds(source: HTMLCanvasElement): TrimBounds | null {
  const ctx = source.getContext("2d");
  if (!ctx) {
    return null;
  }

  const { width, height } = source;
  const data = ctx.getImageData(0, 0, width, height).data;

  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const alpha = data[(y * width + x) * 4 + 3] ?? 0;
      if (alpha > ALPHA_THRESHOLD) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX < 0) {
    return null;
  }

  // 邊緣留 4% 呼吸空間，角色貼進世界時不會被裁到筆畫末端
  const margin = Math.round(Math.max(maxX - minX, maxY - minY) * 0.04) + 2;
  const left = Math.max(0, minX - margin);
  const top = Math.max(0, minY - margin);
  const right = Math.min(width - 1, maxX + margin);
  const bottom = Math.min(height - 1, maxY + margin);

  return { left, top, width: right - left + 1, height: bottom - top + 1 };
}

function scaleInto(
  source: HTMLCanvasElement,
  bounds: TrimBounds,
  maxSide: number,
): HTMLCanvasElement {
  const scale = Math.min(1, maxSide / Math.max(bounds.width, bounds.height));
  const targetWidth = Math.max(1, Math.round(bounds.width * scale));
  const targetHeight = Math.max(1, Math.round(bounds.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = targetWidth;
  canvas.height = targetHeight;

  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("無法建立畫布");
  }

  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(
    source,
    bounds.left,
    bounds.top,
    bounds.width,
    bounds.height,
    0,
    0,
    targetWidth,
    targetHeight,
  );

  return canvas;
}

function encodeOnce(
  canvas: HTMLCanvasElement,
  quality: number,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) {
          resolve(blob);
        } else {
          reject(new Error("圖片編碼失敗"));
        }
      },
      "image/webp",
      quality,
    );
  });
}

/** 依比例縮小一張畫布 */
function downscale(source: HTMLCanvasElement, factor: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(source.width * factor));
  canvas.height = Math.max(1, Math.round(source.height * factor));

  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("圖片編碼失敗");
  }
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/**
 * 編碼到符合大小上限。
 *
 * 先降品質，不夠再降尺寸。降尺寸這一段是必要的：不支援 WebP 編碼的
 * 瀏覽器（多見於各家 App 內建瀏覽器）toBlob 會默默回傳 PNG，
 * 而 PNG 完全忽略 quality 參數——只靠品質階梯，含照片的角色會
 * 一路超標到上傳失敗。
 *
 * 全部手段用盡仍超標時回傳最小的一份：畫質差遠好過送不出去。
 */
async function encodeWithinLimit(
  source: HTMLCanvasElement,
  maxBytes: number,
): Promise<Blob> {
  let canvas = source;
  let last: Blob | null = null;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    for (const quality of QUALITY_STEPS) {
      const blob = await encodeOnce(canvas, quality);
      last = blob;
      if (blob.size <= maxBytes) {
        return blob;
      }
      // PNG 不吃 quality，同一張圖再試更低品質也是白費
      if (blob.type !== "image/webp") {
        break;
      }
    }
    canvas = downscale(canvas, 0.72);
  }

  if (!last) {
    throw new Error("圖片編碼失敗");
  }
  return last;
}

/**
 * 將繪圖畫布處理成可上傳的角色圖片。
 * 畫布必須是透明背景（繪圖元件不得填白底）。
 * 整張全透明時拋出錯誤，呼叫端應提示使用者先畫點東西。
 */
export async function processCharacter(
  source: HTMLCanvasElement,
): Promise<ProcessedCharacter> {
  const bounds = findTrimBounds(source);

  if (!bounds) {
    throw new Error("EMPTY_DRAWING");
  }

  const primaryCanvas = scaleInto(source, bounds, PRIMARY_SIZE);
  const smallCanvas = scaleInto(source, bounds, SMALL_SIZE);

  const primary = await encodeWithinLimit(primaryCanvas, PRIMARY_MAX_BYTES);
  const small = await encodeWithinLimit(smallCanvas, SMALL_MAX_BYTES);

  // Safari 不支援 WebP 編碼時 toBlob 不會報錯，而是靜默回傳 PNG，
  // 因此副檔名必須依實際 MIME 型別決定，不能假設要求的格式
  const extension = primary.type === "image/webp" ? "webp" : "png";

  return { primary, small, extension };
}
