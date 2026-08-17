/**
 * 主視覺素材的規格與檢查（C8）——純計算，沒有 DOM。
 *
 * 跟 visualLab.ts 分開是為了能直接在 Node 裡跑檢查
 * （npm run check:game）。那邊要開 canvas、讀像素，這裡不用，
 * 而「素材對不對」正是最需要被檢查的一段：素材錯了，
 * 後面所有東西都會偏，而且偏得很難看出來。
 *
 * 兩個關鍵決定都跟「不要用顏色辨識文字」有關：
 *
 * 1. 文字保護遮罩來自去背 PNG 的 Alpha 通道，不是金色偵測。
 *    河流與文字都是金色，用顏色分不開——淡金色的細字會被當成河道，
 *    或者為了保住文字而把河道一起切掉。Alpha 是設計師已經標好的答案，
 *    不必再猜。
 *
 * 2. 去背圖沒有 Alpha 時直接報錯，不做任何補救。
 *    「用白色去背」聽起來合理，但那張圖上有淡金色與淺灰色的字
 *    （FLOW TOGETHER、2001—2026），用亮度去背會把它們一起刪掉，
 *    而且刪掉的地方剛好是最不容易被發現的角落。
 */

/** 主視覺的原始尺寸 */
export const VISUAL_WIDTH = 1672;
export const VISUAL_HEIGHT = 941;

/** 遮罩解析度 */
export const LAB_MASK_WIDTH = 512;
export const LAB_MASK_HEIGHT = 288;

/** 判定為「不透明」的 Alpha 門檻 */
export const OPAQUE_ALPHA = 24;

/**
 * 判定「這張圖真的去背了」的透明比例門檻。
 *
 * 一張真正去背的主視覺，透明區域一定佔絕大部分——上面只有文字與 logo。
 * 低於三成幾乎可以確定是「白底存成 PNG」。
 */
export const ALPHA_RATIO_THRESHOLD = 0.3;

export interface ImageReport {
  readonly name: string;
  readonly width: number;
  readonly height: number;
  /** 這張圖有沒有真正的透明區域 */
  readonly hasAlpha: boolean;
  /** 透明（alpha 低於門檻）的像素比例 */
  readonly transparentRatio: number;
  readonly image: HTMLImageElement;
  /**
   * 這張圖的 object URL。
   *
   * 刻意不在讀完之後就 revokeObjectURL：預覽用的 <img src> 指的就是它，
   * 撤銷之後圖片會變成破圖。改由呼叫端在換圖時釋放。
   */
  readonly src: string;
}

export interface ValidationIssue {
  readonly level: "error" | "warning";
  readonly message: string;
}

/** 檢查兩張圖能不能拿來用 */
export function validatePair(
  full: ImageReport | null,
  overlay: ImageReport | null,
): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  const checkSize = (report: ImageReport, label: string): void => {
    if (report.width !== VISUAL_WIDTH || report.height !== VISUAL_HEIGHT) {
      issues.push({
        level: "warning",
        message: `${label}的尺寸是 ${report.width}×${report.height}，不是 ${VISUAL_WIDTH}×${VISUAL_HEIGHT}。等比例的話還是對得齊，比例不同就會錯位。`,
      });
    }
  };

  if (full) {
    checkSize(full, "完整版主視覺");
  }
  if (overlay) {
    checkSize(overlay, "去背主視覺");
  }

  if (full && overlay) {
    if (full.width !== overlay.width || full.height !== overlay.height) {
      issues.push({
        level: "error",
        message: `兩張圖的尺寸不一樣（${full.width}×${full.height} 對 ${overlay.width}×${overlay.height}）。座標對不起來，文字會偏離河道。`,
      });
    }

    const fullRatio = full.width / full.height;
    const overlayRatio = overlay.width / overlay.height;
    if (Math.abs(fullRatio - overlayRatio) > 0.001) {
      issues.push({
        level: "error",
        message: "兩張圖的長寬比不一樣，疊起來一定會錯位。",
      });
    }
  }

  if (overlay && !overlay.hasAlpha) {
    issues.push({
      level: "error",
      message: `這張去背圖沒有透明背景（透明像素只佔 ${(overlay.transparentRatio * 100).toFixed(1)}%）。請匯出成真正含 Alpha 的 PNG。不會自動用白色或亮度去背——那會把 FLOW TOGETHER 與 2001—2026 這類淡色的字一起刪掉。`,
    });
  }

  return issues;
}

/**
 * 把遮罩往外擴張。
 *
 * 用的是「取鄰域最大值」，不是模糊：模糊會讓保護區的邊緣變淡，
 * 而那正是最需要擋住的地方（字的邊緣有一圈發光）。
 */
export function dilateMask(
  mask: Float32Array,
  width: number,
  height: number,
  radius: number,
): Float32Array {
  if (radius < 1) {
    return mask;
  }

  const horizontal = new Float32Array(mask.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let max = 0;
      for (let k = -radius; k <= radius; k += 1) {
        const sx = Math.min(width - 1, Math.max(0, x + k));
        const value = mask[y * width + sx] ?? 0;
        if (value > max) {
          max = value;
        }
      }
      horizontal[y * width + x] = max;
    }
  }

  const out = new Float32Array(mask.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let max = 0;
      for (let k = -radius; k <= radius; k += 1) {
        const sy = Math.min(height - 1, Math.max(0, y + k));
        const value = horizontal[sy * width + x] ?? 0;
        if (value > max) {
          max = value;
        }
      }
      out[y * width + x] = max;
    }
  }

  return out;
}
