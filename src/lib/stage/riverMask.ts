/**
 * 主視覺河道遮罩與流場（C4）。
 *
 * 目的：在一張固定不動的主視覺 PNG 上，只讓河道內部的光流動，
 * 而 logo、標題、日期、右下角的「25」即使同樣是金色也絕對不能一起發光。
 *
 * 遮罩是兩件事相乘：
 *
 * 1. 從圖片本身量出「哪裡是金色的水」。這一步不能省——手畫的範圍
 *    永遠會跟實際的圖差幾個像素，而縮放之後那幾個像素會變成幾十個，
 *    動畫就會溢出河道。用圖片自己當基準，任何解析度都對得齊。
 *
 * 2. 乘上手工指定的排除區。純顏色辨識分不出「金色的水」與「金色的字」，
 *    標題與那個「25」都會被當成河道跟著閃。排除區是手工框的，
 *    這正是規格要求「不能只使用顏色辨識」的原因。
 *
 * 流場則從遮罩自己推導：梯度的垂直方向就是河道的長軸方向。
 * 這樣光絲會沿著原圖河道的曲線走，而不是沿著我猜的一條線走。
 *
 * 這個檔案裡的函式全部是純運算（吃陣列、吐陣列），
 * 不碰 DOM，所以能被 npm run check:game 直接測到。
 */

/** 正規化座標（0~1）的矩形，相對於主視覺原圖 */
export interface MaskZone {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  /** 給人看的說明，只是註記用途 */
  readonly note: string;
}

/**
 * 手工框出的排除區，對應「流嚮」主視覺的排版。
 *
 * 座標是相對於整張 16:9 原圖的比例，所以換投影機、換解析度都成立。
 *
 * 左側整條都排除：那一欄從上到下依序是 logo、主標「流嚮」、標語、
 * 場地、日期、關鍵字列，全部是金色。原圖的河道在左下角確實有一點延伸，
 * 少掉那一角遠好過讓整個標題跟著閃。
 */
export const DEFAULT_EXCLUSIONS: readonly MaskZone[] = [
  { x: 0, y: 0, w: 0.375, h: 1, note: "左側：logo、主標、標語、場地、日期、關鍵字" },
  { x: 0.775, y: 0.6, w: 0.225, h: 0.4, note: "右下：25、匯聚同行、年份、英文會名" },
];

/**
 * 一個像素有多「像金色的水」，回傳 0~1。
 *
 * 用暖度（紅減藍）而不是亮度：深藍的水在亮度上也不低，
 * 但它的藍遠高於紅；金色反過來。這是兩者最乾淨的分界。
 */
export function goldness(r: number, g: number, b: number): number {
  const warm = r - b;
  const lum = r * 0.3 + g * 0.6 + b * 0.1;

  // 兩個條件都要成立才算：暖，而且亮。
  // 暖但暗的是深褐色的底噪，亮但不暖的是藍白色的水光。
  const warmth = clamp01((warm - 18) / 85);
  const bright = clamp01((lum - 40) / 95);
  return warmth * bright;
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/**
 * 從影像像素建立遮罩。
 *
 * pixels 是 RGBA 連續排列（getImageData 的格式）。
 * 回傳與 width×height 對應的 0~1 陣列。
 */
export function buildMask(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  exclusions: readonly MaskZone[] = DEFAULT_EXCLUSIONS,
): Float32Array {
  const mask = new Float32Array(width * height);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      mask[y * width + x] = goldness(
        pixels[i] ?? 0,
        pixels[i + 1] ?? 0,
        pixels[i + 2] ?? 0,
      );
    }
  }

  applyExclusions(mask, width, height, exclusions);
  return mask;
}

/**
 * 把排除區清成 0，邊緣帶一段漸變。
 *
 * 漸變是必要的：硬邊會在畫面上留下一條看得出來的直線，
 * 那比讓標題微微發光更醜。
 */
export function applyExclusions(
  mask: Float32Array,
  width: number,
  height: number,
  exclusions: readonly MaskZone[],
  featherRatio = 0.03,
): void {
  const feather = Math.max(1, Math.round(width * featherRatio));

  for (const zone of exclusions) {
    const x0 = zone.x * width;
    const y0 = zone.y * height;
    const x1 = (zone.x + zone.w) * width;
    const y1 = (zone.y + zone.h) * height;

    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        // 到矩形內部的距離：在裡面是 0，往外遞增
        const dx = Math.max(x0 - x, 0, x - x1);
        const dy = Math.max(y0 - y, 0, y - y1);
        const distance = Math.hypot(dx, dy);
        if (distance >= feather) {
          continue;
        }
        const keep = distance / feather;
        const index = y * width + x;
        const current = mask[index] ?? 0;
        mask[index] = current * keep;
      }
    }
  }
}

/**
 * 對遮罩做可分離的箱型模糊。
 *
 * 遮罩邊緣不模糊的話，光點會在河道邊界忽然出現與消失，
 * 看起來像有一層看不見的玻璃。
 */
export function blurMask(
  mask: Float32Array,
  width: number,
  height: number,
  radius: number,
): Float32Array {
  if (radius < 1) {
    return mask;
  }

  const horizontal = new Float32Array(mask.length);
  const window = radius * 2 + 1;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let sum = 0;
      for (let k = -radius; k <= radius; k += 1) {
        const sx = Math.min(width - 1, Math.max(0, x + k));
        sum += mask[y * width + sx] ?? 0;
      }
      horizontal[y * width + x] = sum / window;
    }
  }

  const out = new Float32Array(mask.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let sum = 0;
      for (let k = -radius; k <= radius; k += 1) {
        const sy = Math.min(height - 1, Math.max(0, y + k));
        sum += horizontal[sy * width + x] ?? 0;
      }
      out[y * width + x] = sum / window;
    }
  }

  return out;
}

/** 雙線性取樣。座標以格子為單位，超出範圍回傳 0。 */
export function sampleMask(
  mask: Float32Array,
  width: number,
  height: number,
  x: number,
  y: number,
): number {
  if (x < 0 || y < 0 || x > width - 1 || y > height - 1) {
    return 0;
  }

  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(width - 1, x0 + 1);
  const y1 = Math.min(height - 1, y0 + 1);
  const fx = x - x0;
  const fy = y - y0;

  const a = mask[y0 * width + x0] ?? 0;
  const b = mask[y0 * width + x1] ?? 0;
  const c = mask[y1 * width + x0] ?? 0;
  const d = mask[y1 * width + x1] ?? 0;

  return (
    a * (1 - fx) * (1 - fy) +
    b * fx * (1 - fy) +
    c * (1 - fx) * fy +
    d * fx * fy
  );
}

/**
 * 從遮罩推導流場：每一格存下該處的水流方向（單位向量）。
 *
 * 原理是梯度的垂直方向就是河道的長軸。河道是一條帶狀區域，
 * 遮罩值在帶子的橫向變化最快、沿著帶子幾乎不變，
 * 所以梯度指向橫向，轉九十度就是「順流」的方向。
 *
 * 轉九十度有兩個解（往上游或往下游），用 hint 決定取哪一個：
 * 與 hint 同向的那一個才是下游。這一個提示是必要的，
 * 影像本身分不出一條河在往哪邊流。
 */
export function flowField(
  mask: Float32Array,
  width: number,
  height: number,
  hint: { readonly x: number; readonly y: number },
): Float32Array {
  const field = new Float32Array(width * height * 2);
  const hintLength = Math.hypot(hint.x, hint.y) || 1;
  const hx = hint.x / hintLength;
  const hy = hint.y / hintLength;

  const at = (x: number, y: number): number => {
    const cx = Math.min(width - 1, Math.max(0, x));
    const cy = Math.min(height - 1, Math.max(0, y));
    return mask[cy * width + cx] ?? 0;
  };

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      // Sobel
      const gx =
        at(x + 1, y - 1) +
        2 * at(x + 1, y) +
        at(x + 1, y + 1) -
        at(x - 1, y - 1) -
        2 * at(x - 1, y) -
        at(x - 1, y + 1);
      const gy =
        at(x - 1, y + 1) +
        2 * at(x, y + 1) +
        at(x + 1, y + 1) -
        at(x - 1, y - 1) -
        2 * at(x, y - 1) -
        at(x + 1, y - 1);

      // 梯度轉九十度
      let tx = -gy;
      let ty = gx;
      const length = Math.hypot(tx, ty);

      if (length < 1e-4) {
        // 梯度太小（大片均勻的區域）：沒有方向可言，直接走提示方向
        tx = hx;
        ty = hy;
      } else {
        tx /= length;
        ty /= length;
        // 取與提示同向的那一個解
        if (tx * hx + ty * hy < 0) {
          tx = -tx;
          ty = -ty;
        }
      }

      const index = (y * width + x) * 2;
      field[index] = tx;
      field[index + 1] = ty;
    }
  }

  return field;
}

/** 取流場中某一點的方向，雙線性內插後正規化 */
export function sampleFlow(
  field: Float32Array,
  width: number,
  height: number,
  x: number,
  y: number,
): { readonly x: number; readonly y: number } {
  const cx = Math.min(width - 1, Math.max(0, x));
  const cy = Math.min(height - 1, Math.max(0, y));
  const x0 = Math.floor(cx);
  const y0 = Math.floor(cy);
  const x1 = Math.min(width - 1, x0 + 1);
  const y1 = Math.min(height - 1, y0 + 1);
  const fx = cx - x0;
  const fy = cy - y0;

  const pick = (px: number, py: number, offset: number): number =>
    field[(py * width + px) * 2 + offset] ?? 0;

  const mix = (offset: number): number =>
    pick(x0, y0, offset) * (1 - fx) * (1 - fy) +
    pick(x1, y0, offset) * fx * (1 - fy) +
    pick(x0, y1, offset) * (1 - fx) * fy +
    pick(x1, y1, offset) * fx * fy;

  const vx = mix(0);
  const vy = mix(1);
  const length = Math.hypot(vx, vy);
  if (length < 1e-4) {
    return { x: 0, y: 0 };
  }
  return { x: vx / length, y: vy / length };
}

/**
 * 挑出遮罩值夠高的格子，當作光點的出生地。
 *
 * 回傳的是格子索引，呼叫端再換算成畫面座標。
 * 依遮罩值加權：越亮的地方生越多光點，暗處零星幾顆——
 * 平均分佈的話，亮處不會亮，整片會糊成一樣的密度。
 */
export function seedCells(
  mask: Float32Array,
  threshold = 0.12,
): readonly number[] {
  const cells: number[] = [];
  for (let i = 0; i < mask.length; i += 1) {
    const value = mask[i] ?? 0;
    if (value < threshold) {
      continue;
    }
    // 遮罩值越高就重複放幾次，之後隨機抽的時候自然形成加權
    const weight = 1 + Math.round(value * 3);
    for (let k = 0; k < weight; k += 1) {
      cells.push(i);
    }
  }
  return cells;
}
