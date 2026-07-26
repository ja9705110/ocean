"use client";

/**
 * 個人照片前處理：置中方形裁切 → 縮到 512 → 柔邊圓形遮罩。
 *
 * 圓形而不是原始方形，是為了讓照片貼進世界時像一顆「頭像泡泡」，
 * 參與者再從泡泡向外畫出延伸（鰭、觸手、裝飾），
 * 而不是一塊格格不入的矩形照片。
 */

const PHOTO_SIZE = 512;
/** 柔邊起點（半徑比例）：之外開始淡出到透明 */
const SOFT_EDGE_START = 0.92;

async function decodeToBitmap(file: File): Promise<ImageBitmap | null> {
  try {
    // imageOrientation: from-image 讓手機直拍的 EXIF 方向被正確套用
    return await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    return null;
  }
}

function decodeViaImg(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("PHOTO_DECODE_FAILED"));
    };
    img.src = url;
  });
}

/**
 * 將照片檔處理成柔邊圓形的畫布圖層。
 * 解不開的檔案（非圖片、損毀）拋出 PHOTO_DECODE_FAILED。
 */
export async function preparePhotoLayer(file: File): Promise<HTMLCanvasElement> {
  const bitmap = await decodeToBitmap(file);
  const source = bitmap ?? (await decodeViaImg(file));

  const sourceWidth = bitmap ? bitmap.width : (source as HTMLImageElement).naturalWidth;
  const sourceHeight = bitmap ? bitmap.height : (source as HTMLImageElement).naturalHeight;

  if (sourceWidth < 1 || sourceHeight < 1) {
    throw new Error("PHOTO_DECODE_FAILED");
  }

  const canvas = document.createElement("canvas");
  canvas.width = PHOTO_SIZE;
  canvas.height = PHOTO_SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("PHOTO_DECODE_FAILED");
  }

  // 置中方形裁切後鋪滿目標畫布
  const cropSide = Math.min(sourceWidth, sourceHeight);
  const cropX = (sourceWidth - cropSide) / 2;
  const cropY = (sourceHeight - cropSide) / 2;

  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(
    source,
    cropX,
    cropY,
    cropSide,
    cropSide,
    0,
    0,
    PHOTO_SIZE,
    PHOTO_SIZE,
  );

  // 柔邊圓形遮罩：以放射漸層做 destination-in，邊緣自然淡出
  const half = PHOTO_SIZE / 2;
  const mask = ctx.createRadialGradient(half, half, 0, half, half, half);
  mask.addColorStop(0, "rgba(0,0,0,1)");
  mask.addColorStop(SOFT_EDGE_START, "rgba(0,0,0,1)");
  mask.addColorStop(1, "rgba(0,0,0,0)");

  ctx.globalCompositeOperation = "destination-in";
  ctx.fillStyle = mask;
  ctx.fillRect(0, 0, PHOTO_SIZE, PHOTO_SIZE);
  ctx.globalCompositeOperation = "source-over";

  bitmap?.close();
  return canvas;
}
