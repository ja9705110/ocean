"use client";

/**
 * 大螢幕背景圖的上傳前處理（C6）。
 *
 * 主視覺這種圖動輒好幾 MB，直接上傳會撞上 Storage 的單檔上限，
 * 而且大螢幕那台機器每次開場都要把整張圖抓下來——會場的 Wi-Fi
 * 通常沒有那麼寬裕。
 *
 * 這裡只改「解析度與編碼」，不改任何構圖：同一張圖、同樣的排版、
 * 同樣的文字位置，只是像素少一點。設計本身一個字都沒有動。
 *
 * 2560 寬是刻意的上限：投影機幾乎都在 1920 以下，
 * 4K 投影也只到 3840，而背景圖在 4K 上會被縮到畫面寬度，
 * 2560 已經超過任何投影機的實際取樣需求。再高只是浪費頻寬。
 */

/** 長邊上限。超過就等比縮小，沒超過就維持原尺寸。 */
const MAX_WIDTH = 2560;

/**
 * 目標檔案大小。
 *
 * 壓在 900KB 是為了留餘裕：Storage 的 assets bucket 上限本來是 1MB，
 * 剛好卡在邊緣的檔案會因為編碼器的浮動而時上時下。
 */
const TARGET_BYTES = 900_000;

/** 由高到低嘗試的品質階梯 */
const QUALITY_STEPS: readonly number[] = [0.92, 0.86, 0.8, 0.72, 0.64, 0.55];

export interface PreparedStageImage {
  readonly blob: Blob;
  readonly width: number;
  readonly height: number;
  /** 實際使用的副檔名 */
  readonly extension: "webp" | "jpg";
  /** 原始檔案大小，用來回報壓縮了多少 */
  readonly originalBytes: number;
}

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("這個檔案打不開，請確認是圖片檔。"));
    };
    image.src = url;
  });
}

function encode(
  canvas: HTMLCanvasElement,
  type: string,
  quality: number,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("圖片編碼失敗"))),
      type,
      quality,
    );
  });
}

/**
 * 把主持人選的圖處理成可以上傳的背景圖。
 *
 * 先降品質，不夠再降尺寸。降尺寸這一段是必要的：不支援 WebP 編碼的
 * 瀏覽器（多見於各家 App 內建瀏覽器）toBlob 會默默回傳 PNG，
 * 而 PNG 完全忽略 quality 參數——只靠品質階梯，大圖會一路超標。
 */
export async function prepareStageImage(
  file: File,
): Promise<PreparedStageImage> {
  const image = await loadImage(file);

  let width = image.naturalWidth || image.width;
  let height = image.naturalHeight || image.height;

  if (width <= 0 || height <= 0) {
    throw new Error("這張圖讀不到尺寸，換一個檔案試試。");
  }

  const scale = Math.min(1, MAX_WIDTH / width);
  width = Math.round(width * scale);
  height = Math.round(height * scale);

  let last: Blob | null = null;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;

    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("無法建立畫布");
    }
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(image, 0, 0, width, height);

    for (const quality of QUALITY_STEPS) {
      const blob = await encode(canvas, "image/webp", quality);
      last = blob;

      if (blob.size <= TARGET_BYTES) {
        return {
          blob,
          width,
          height,
          extension: blob.type === "image/webp" ? "webp" : "jpg",
          originalBytes: file.size,
        };
      }

      // PNG 不吃 quality，同一張圖再試更低品質也是白費
      if (blob.type !== "image/webp") {
        break;
      }
    }

    width = Math.max(640, Math.round(width * 0.75));
    height = Math.max(360, Math.round(height * 0.75));
  }

  if (!last) {
    throw new Error("圖片編碼失敗");
  }

  // 手段用盡仍超標：回傳最小的一份。畫質差一點遠好過整個傳不上去。
  return {
    blob: last,
    width,
    height,
    extension: last.type === "image/webp" ? "webp" : "jpg",
    originalBytes: file.size,
  };
}

/** 給主持人看的壓縮結果 */
export function describeStageImage(result: PreparedStageImage): string {
  const mb = (bytes: number) => (bytes / 1_048_576).toFixed(1);
  return `已上傳（${result.width}×${result.height}，${mb(result.originalBytes)}MB → ${mb(result.blob.size)}MB）`;
}
