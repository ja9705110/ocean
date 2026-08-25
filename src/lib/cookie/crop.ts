"use client";

import { COOKIE_ASPECT } from "@/lib/stage/cookieBelt";

/**
 * 餅乾照片的裁切（C14）。
 *
 * 為什麼一定要有這一步：拍出來的照片幾乎不可能直接用。實際拍到的樣子是
 * 一張裡兩塊餅乾、餅乾是斜的、背景佔掉一半以上。這三件事任何一件
 * 都會讓馬賽克變成一片牛皮紙拼貼。
 *
 * 為什麼是「拍完再裁」而不是「相機上疊一個對準框」：
 * 現場的人是從 LINE 掃 QR 進來的，而 LINE 與 FB 的內建瀏覽器常常擋掉
 * 網頁直接開相機（getUserMedia）。用系統相機拍、拍完在網頁裡裁，
 * 每一個瀏覽器都能用，而且已經拍好的照片也能挑。
 *
 * 自動先框好再讓人確認：兩百多個人排隊，能少一個動作就是少一次卡關。
 */

/** 裁切框：以「照片本身的像素」為單位 */
export interface CropBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** 輸出的邊長（像素）。投影到牆上一格大約一百多像素，這個尺寸綽綽有餘。 */
const OUTPUT_WIDTH = 420;

/**
 * 猜一個裁切框。
 *
 * 餅乾是暖色的（薑餅底＋糖霜），背景多半是牛皮紙、桌面或盤子。
 * 用「跟畫面整體比起來偏暖、偏亮」找出餅乾大致的位置——
 * 不需要準，只要比「一律放正中央」好就有價值，剩下的讓人自己拖。
 *
 * 找不到就回傳置中的最大框。寧可給一個保守的答案，
 * 也不要因為抓錯而把人的餅乾切掉一半。
 */
export function guessCookieBox(
  image: HTMLImageElement,
  probeSize = 96,
): CropBox {
  const fallback = centeredBox(image.naturalWidth, image.naturalHeight);

  const canvas = document.createElement("canvas");
  const ratio = image.naturalWidth / image.naturalHeight;
  const pw = ratio >= 1 ? probeSize : Math.max(8, Math.round(probeSize * ratio));
  const ph = ratio >= 1 ? Math.max(8, Math.round(probeSize / ratio)) : probeSize;
  canvas.width = pw;
  canvas.height = ph;

  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    return fallback;
  }
  ctx.drawImage(image, 0, 0, pw, ph);

  let data: Uint8ClampedArray;
  try {
    data = ctx.getImageData(0, 0, pw, ph).data;
  } catch {
    // 跨來源的圖會讓畫布被污染。猜不到就用置中的框。
    return fallback;
  }

  // 先算整張的平均，再找「比平均更暖更亮」的像素。
  // 用相對值而不是固定門檻：現場的燈光每一桌都不一樣。
  let sumWarm = 0;
  let sumLuma = 0;
  const total = pw * ph;
  const warmth = new Float32Array(total);
  const luma = new Float32Array(total);

  for (let i = 0; i < total; i += 1) {
    const r = data[i * 4] ?? 0;
    const g = data[i * 4 + 1] ?? 0;
    const b = data[i * 4 + 2] ?? 0;
    warmth[i] = r - b;
    luma[i] = (r + g + b) / 3;
    sumWarm += warmth[i]!;
    sumLuma += luma[i]!;
  }

  const avgWarm = sumWarm / total;
  const avgLuma = sumLuma / total;

  let minX = pw;
  let minY = ph;
  let maxX = -1;
  let maxY = -1;
  let hits = 0;

  for (let y = 0; y < ph; y += 1) {
    for (let x = 0; x < pw; x += 1) {
      const i = y * pw + x;
      if (warmth[i]! > avgWarm + 6 && luma[i]! > avgLuma * 0.85) {
        hits += 1;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }

  // 命中太少（沒找到）或太多（整張都是暖色，等於沒有資訊）都不採用
  if (hits < total * 0.04 || hits > total * 0.85 || maxX < 0) {
    return fallback;
  }

  const sx = image.naturalWidth / pw;
  const sy = image.naturalHeight / ph;
  // 往外放一點，免得把糖霜的邊緣切掉
  const pad = 0.06;
  const boxW = (maxX - minX + 1) * sx * (1 + pad * 2);
  const boxH = (maxY - minY + 1) * sy * (1 + pad * 2);
  const cx = ((minX + maxX + 1) / 2) * sx;
  const cy = ((minY + maxY + 1) / 2) * sy;

  return fitAspect(cx, cy, boxW, boxH, image.naturalWidth, image.naturalHeight);
}

/** 置中的最大框 */
export function centeredBox(imageW: number, imageH: number): CropBox {
  return fitAspect(imageW / 2, imageH / 2, imageW, imageH, imageW, imageH);
}

/**
 * 把一個框調成餅乾的長寬比，並且留在照片裡面。
 *
 * 調整的方式是「取兩邊的較大者」——寧可框大一點多帶一些背景，
 * 也不要為了對比例把餅乾切掉。切掉的部分救不回來。
 */
export function fitAspect(
  cx: number,
  cy: number,
  wantW: number,
  wantH: number,
  imageW: number,
  imageH: number,
): CropBox {
  let width = Math.max(wantW, wantH * COOKIE_ASPECT);
  let height = width / COOKIE_ASPECT;

  // 超過照片就整個縮回來
  const shrink = Math.min(1, imageW / width, imageH / height);
  width *= shrink;
  height *= shrink;

  const x = Math.min(Math.max(0, cx - width / 2), imageW - width);
  const y = Math.min(Math.max(0, cy - height / 2), imageH - height);

  return { x, y, width, height };
}

export interface CroppedCookie {
  readonly blob: Blob;
  readonly extension: string;
  readonly width: number;
  readonly height: number;
}

/**
 * 把框裡的內容裁出來並壓縮。
 *
 * 壓縮是必要的：現在的手機一張照片動輒五六 MB，兩百多個人同時上傳的話
 * 會場的 Wi-Fi 會直接躺平。裁出來只有 420 像素寬，那已經遠超過
 * 投影到牆上一格所需要的解析度。
 */
export async function cropCookie(
  image: HTMLImageElement,
  box: CropBox,
): Promise<CroppedCookie> {
  const width = OUTPUT_WIDTH;
  const height = Math.round(OUTPUT_WIDTH / COOKIE_ASPECT);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("無法建立畫布");
  }
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(
    image,
    box.x,
    box.y,
    box.width,
    box.height,
    0,
    0,
    width,
    height,
  );

  const encode = (type: string, quality: number) =>
    new Promise<Blob | null>((resolve) =>
      canvas.toBlob((blob) => resolve(blob), type, quality),
    );

  // 先試 WebP。有些 App 內建瀏覽器不支援 WebP 編碼，會默默回傳 PNG，
  // 那種情況改用 JPEG——PNG 完全忽略品質參數，照片存成 PNG 會非常大。
  const webp = await encode("image/webp", 0.86);
  if (webp && webp.type === "image/webp") {
    return { blob: webp, extension: "webp", width, height };
  }

  const jpeg = await encode("image/jpeg", 0.86);
  if (jpeg) {
    return { blob: jpeg, extension: "jpg", width, height };
  }

  throw new Error("圖片編碼失敗");
}
