"use client";

import { getSupabaseBrowserClient } from "@/lib/supabase/client";

/**
 * 題目配圖的處理與上傳（Q1）。
 *
 * 主持人多半是直接從手機相簿或 Google 拉圖，動輒好幾 MB。
 * assets 儲存桶的單檔上限是 1 MB，直接丟上去會被擋下來，
 * 而且大螢幕載入時也會卡住。所以一律先在瀏覽器裡縮小再上傳。
 *
 * 品質階梯之後還有縮小尺寸的退路：部分 App 內建瀏覽器的 toBlob
 * 不支援 webp，會默默回傳 PNG，而 PNG 根本不理會 quality 參數——
 * 只降品質在那些裝置上完全沒有效果（角色圖那邊踩過同一個坑）。
 */

/** 大螢幕最寬也就是投影機的解析度，超過只是浪費 */
const MAX_EDGE = 1280;
const MAX_BYTES = 700_000;
const QUALITY_STEPS = [0.85, 0.72, 0.6, 0.5, 0.4];

async function loadImage(file: File): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("IMAGE_DECODE_FAILED"));
      image.src = url;
    });
    return image;
  } finally {
    // decode 完成後就不需要這個 URL 了，留著會累積佔用記憶體
    URL.revokeObjectURL(url);
  }
}

function drawTo(
  source: CanvasImageSource,
  width: number,
  height: number,
): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  }
  return canvas;
}

function toBlob(
  canvas: HTMLCanvasElement,
  quality: number,
): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), "image/webp", quality);
  });
}

/** 壓到上限之內。回傳的 Blob 型別可能是 webp 也可能是 png。 */
async function encodeWithinLimit(canvas: HTMLCanvasElement): Promise<Blob> {
  let current = canvas;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    for (const quality of QUALITY_STEPS) {
      const blob = await toBlob(current, quality);
      if (!blob) {
        break;
      }
      if (blob.size <= MAX_BYTES) {
        return blob;
      }
      // PNG 不吃 quality，同一張圖再試更低品質也是白費
      if (blob.type !== "image/webp") {
        break;
      }
    }
    current = drawTo(current, current.width * 0.72, current.height * 0.72);
  }

  const last = await toBlob(current, 0.4);
  if (!last) {
    throw new Error("IMAGE_ENCODE_FAILED");
  }
  return last;
}

/**
 * 縮圖並上傳，回傳公開網址。
 *
 * 路徑是 {eventId}/quiz-{時間戳}.{副檔名}：assets 的寫入政策要求
 * 第一層資料夾必須是主持人自己的活動 id，而且只能有一層。
 */
export async function uploadQuizImage(
  eventId: string,
  file: File,
): Promise<string> {
  const image = await loadImage(file);
  const scale = Math.min(1, MAX_EDGE / Math.max(image.width, image.height));
  const canvas = drawTo(image, image.width * scale, image.height * scale);
  const blob = await encodeWithinLimit(canvas);

  const extension = blob.type === "image/webp" ? "webp" : "png";
  const path = `${eventId}/quiz-${Date.now()}.${extension}`;

  const supabase = getSupabaseBrowserClient();
  const { error } = await supabase.storage
    .from("assets")
    .upload(path, blob, { contentType: blob.type, upsert: false });

  if (error) {
    throw new Error(error.message);
  }

  const { data } = supabase.storage.from("assets").getPublicUrl(path);
  return data.publicUrl;
}
