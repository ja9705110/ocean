/**
 * 彩繪的預設樣式（C21）。
 *
 * 報到台前面排著隊，遞過來一張全白的畫布只會讓人愣住——
 * 「我又不會畫畫」是現場最常聽到的一句。給一張已經有輪廓的圖就不一樣了，
 * 那變成塗顏色，不是創作，每個人都做得到。
 *
 * 全部是河的意象：河裡的、河邊的、水面上的、天上的。
 * 這些線條最後會流進大螢幕那條河，所以主題要對得上。
 *
 * 為什麼用程式畫而不是放三十幾張圖檔：
 *
 *   向量在任何解析度都清晰，手機到投影機都同一份。
 *   不必下載——報到那幾分鐘場館 Wi-Fi 最擠，多三十幾個檔案就是多三十幾次
 *   可能失敗的請求。
 *   線稿的顏色要跟著主視覺調，改的是一個參數不是重畫三十幾張。
 *
 * 每個樣式都在 100x100 的正規化座標系裡，跟 ocean.ts／river.ts 同一個約定，
 * 所以縮圖、畫布底層、匯出都共用同一份定義。
 *
 * 形狀用資料描述而不是各寫一支 draw()：三十幾支手寫的繪圖函式沒有人
 * 讀得完，也很難保證線寬與風格一致。這裡每個樣式就是幾個基本形狀，
 * 加一個新的只要多幾行資料。
 */

/** 一個基本形狀。座標都在 0–100 之間。 */
export type Stencil =
  | { readonly k: "circle"; readonly x: number; readonly y: number; readonly r: number }
  | {
      readonly k: "ellipse";
      readonly x: number;
      readonly y: number;
      readonly rx: number;
      readonly ry: number;
      /** 弧度 */
      readonly rot?: number;
    }
  /** 折線。close 為 true 時收口成封閉形狀。 */
  | {
      readonly k: "poly";
      readonly p: readonly (readonly [number, number])[];
      readonly close?: boolean;
    }
  /** 通過所有點的平滑曲線（中點二次曲線，跟簽名板同一套） */
  | {
      readonly k: "curve";
      readonly p: readonly (readonly [number, number])[];
      readonly close?: boolean;
    }
  /** 圓弧。角度用度，0 度在三點鐘方向，順時針增加。 */
  | {
      readonly k: "arc";
      readonly x: number;
      readonly y: number;
      readonly r: number;
      readonly a0: number;
      readonly a1: number;
    };

export interface RiverStencil {
  readonly key: string;
  readonly name: string;
  readonly shapes: readonly Stencil[];
}

const C = (x: number, y: number, r: number): Stencil => ({ k: "circle", x, y, r });
const E = (
  x: number,
  y: number,
  rx: number,
  ry: number,
  rot?: number,
): Stencil => ({ k: "ellipse", x, y, rx, ry, rot });
const P = (
  p: readonly (readonly [number, number])[],
  close = false,
): Stencil => ({ k: "poly", p, close });
const V = (
  p: readonly (readonly [number, number])[],
  close = false,
): Stencil => ({ k: "curve", p, close });
const A = (
  x: number,
  y: number,
  r: number,
  a0: number,
  a1: number,
): Stencil => ({ k: "arc", x, y, r, a0, a1 });

/** 幾個樣式共用的水波，放在畫面下緣 */
const WAVES: readonly Stencil[] = [
  V([
    [8, 84],
    [22, 79],
    [36, 84],
    [50, 79],
    [64, 84],
    [78, 79],
    [92, 84],
  ]),
  V([
    [8, 93],
    [22, 88],
    [36, 93],
    [50, 88],
    [64, 93],
    [78, 88],
    [92, 93],
  ]),
];

/**
 * 三十六個樣式。
 *
 * 排序不是隨便的：越前面越好認、越好塗。現場多數人會拿第一排那幾個，
 * 所以魚、荷葉、水滴這種「一眼知道要塗哪裡」的排在最前面，
 * 線條多的（橋、水車）往後放。
 */
export const RIVER_STENCILS: readonly RiverStencil[] = [
  {
    key: "koi",
    name: "鯉魚",
    shapes: [
      E(46, 50, 30, 18),
      P([
        [76, 50],
        [95, 34],
        [95, 66],
      ], true),
      V([
        [40, 32],
        [52, 22],
        [60, 33],
      ]),
      C(30, 45, 3.5),
      A(34, 58, 12, 200, 340),
    ],
  },
  {
    key: "lotus-leaf",
    name: "荷葉",
    shapes: [
      C(50, 48, 33),
      P([[50, 48], [50, 15]]),
      P([[50, 48], [79, 32]]),
      P([[50, 48], [79, 64]]),
      P([[50, 48], [50, 81]]),
      P([[50, 48], [21, 64]]),
      P([[50, 48], [21, 32]]),
      P([[50, 81], [50, 95]]),
    ],
  },
  {
    key: "droplet",
    name: "水滴",
    shapes: [
      // 尖端用兩條直線交出來。整圈都用曲線的話頂點會被抹圓，
      // 變成一顆蛋——水滴之所以是水滴，全靠那個尖
      A(50, 58, 26, 0, 180),
      P([[24, 58], [50, 10], [76, 58]]),
      A(38, 66, 10, 110, 250),
    ],
  },
  {
    key: "frog",
    name: "青蛙",
    shapes: [
      E(50, 60, 28, 22),
      C(36, 36, 11),
      C(64, 36, 11),
      C(36, 36, 4),
      C(64, 36, 4),
      A(50, 58, 15, 20, 160),
      V([[24, 74], [16, 84], [26, 88]]),
      V([[76, 74], [84, 84], [74, 88]]),
    ],
  },
  {
    key: "dragonfly",
    name: "蜻蜓",
    shapes: [
      E(50, 58, 5, 30),
      C(50, 22, 8),
      E(30, 40, 18, 7, -0.5),
      E(70, 40, 18, 7, 0.5),
      E(30, 56, 15, 6, -0.3),
      E(70, 56, 15, 6, 0.3),
    ],
  },
  {
    key: "duck",
    name: "水鴨",
    shapes: [
      E(52, 60, 28, 18),
      C(32, 38, 13),
      P([
        [20, 36],
        [8, 40],
        [20, 44],
      ], true),
      C(30, 34, 3),
      A(58, 58, 16, 200, 340),
      ...WAVES.slice(1),
    ],
  },
  {
    key: "lotus",
    name: "蓮花",
    shapes: [
      V([[50, 20], [60, 50], [50, 62], [40, 50]], true),
      V([[26, 30], [48, 52], [44, 64], [28, 54]], true),
      V([[74, 30], [52, 52], [56, 64], [72, 54]], true),
      V([[12, 48], [42, 60], [42, 70], [18, 62]], true),
      V([[88, 48], [58, 60], [58, 70], [82, 62]], true),
      A(50, 66, 22, 20, 160),
    ],
  },
  {
    key: "ripple",
    name: "漣漪",
    shapes: [C(50, 52, 12), C(50, 52, 22), C(50, 52, 32), C(50, 52, 42)],
  },
  {
    key: "paper-boat",
    name: "紙船",
    shapes: [
      P([
        [12, 56],
        [88, 56],
        [70, 82],
        [30, 82],
      ], true),
      P([
        [30, 56],
        [50, 20],
        [70, 56],
      ], true),
      P([[50, 20], [50, 56]]),
      ...WAVES.slice(1),
    ],
  },
  {
    key: "reed",
    name: "蘆葦",
    shapes: [
      P([[30, 92], [34, 30]]),
      E(34, 22, 6, 12),
      P([[52, 92], [50, 40]]),
      E(50, 32, 5, 10),
      P([[70, 92], [66, 48]]),
      E(66, 40, 4.5, 9),
      ...WAVES.slice(1),
    ],
  },
  {
    key: "pebble",
    name: "溪石",
    shapes: [
      V([[12, 74], [18, 58], [33, 54], [45, 63], [43, 76]], true),
      V([[47, 76], [56, 60], [71, 59], [80, 69], [78, 78]], true),
      V([[80, 78], [85, 69], [94, 73], [92, 80]], true),
      ...WAVES.slice(1),
    ],
  },
  {
    key: "shell",
    name: "貝殼",
    shapes: [
      V([[50, 84], [14, 46], [50, 20], [86, 46]], true),
      P([[50, 84], [50, 22]]),
      P([[50, 84], [30, 30]]),
      P([[50, 84], [70, 30]]),
      P([[50, 84], [18, 44]]),
      P([[50, 84], [82, 44]]),
    ],
  },
  {
    key: "shrimp",
    name: "小蝦",
    shapes: [
      V([[72, 28], [46, 30], [28, 48], [34, 70], [58, 80]]),
      P([[58, 80], [80, 88], [72, 66]], true),
      A(40, 40, 14, 300, 60),
      A(34, 56, 14, 320, 80),
      P([[72, 28], [88, 16]]),
      P([[72, 28], [86, 30]]),
      C(66, 34, 2.6),
    ],
  },
  {
    key: "crab",
    name: "螃蟹",
    shapes: [
      E(50, 56, 26, 18),
      C(41, 52, 3),
      C(59, 52, 3),
      A(50, 58, 12, 20, 160),
      V([[26, 46], [14, 34], [6, 40]]),
      V([[74, 46], [86, 34], [94, 40]]),
      P([[30, 70], [20, 82]]),
      P([[44, 74], [40, 88]]),
      P([[56, 74], [60, 88]]),
      P([[70, 70], [80, 82]]),
    ],
  },
  {
    key: "turtle",
    name: "烏龜",
    shapes: [
      A(50, 62, 30, 180, 360),
      P([[20, 62], [80, 62]]),
      A(50, 62, 15, 180, 360),
      P([[35, 62], [39, 44]]),
      P([[50, 62], [50, 32]]),
      P([[65, 62], [61, 44]]),
      C(88, 52, 8),
      C(90, 50, 2.4),
      P([[26, 62], [18, 76]]),
      P([[70, 62], [78, 76]]),
      P([[20, 60], [10, 66]]),
    ],
  },
  {
    key: "snail",
    name: "蝸牛",
    shapes: [
      C(56, 46, 26),
      C(56, 46, 17),
      C(56, 46, 8),
      V([[30, 62], [22, 76], [46, 80], [78, 78]]),
      P([[26, 66], [16, 50]]),
      P([[34, 62], [30, 46]]),
      C(16, 48, 2.4),
      C(30, 44, 2.4),
    ],
  },
  {
    key: "firefly",
    name: "螢火蟲",
    shapes: [
      E(50, 56, 11, 18),
      C(50, 34, 8),
      E(34, 44, 14, 6, -0.4),
      E(66, 44, 14, 6, 0.4),
      C(50, 70, 5),
      C(50, 70, 12),
      C(50, 70, 19),
    ],
  },
  {
    key: "fish-school",
    name: "魚群",
    shapes: [
      E(30, 32, 14, 8),
      P([[16, 32], [6, 26], [6, 38]], true),
      E(66, 46, 14, 8),
      P([[52, 46], [42, 40], [42, 52]], true),
      E(38, 66, 14, 8),
      P([[24, 66], [14, 60], [14, 72]], true),
      E(72, 78, 12, 7),
      P([[60, 78], [52, 73], [52, 83]], true),
    ],
  },
  {
    key: "willow",
    name: "柳樹",
    shapes: [
      V([[38, 92], [36, 60], [42, 36]]),
      A(50, 36, 26, 180, 360),
      V([[28, 40], [25, 58], [29, 74]]),
      V([[40, 36], [37, 60], [42, 78]]),
      V([[52, 34], [55, 58], [50, 76]]),
      V([[64, 38], [68, 58], [63, 72]]),
      V([[74, 46], [78, 60], [73, 70]]),
      ...WAVES.slice(1),
    ],
  },
  {
    key: "bridge",
    name: "小橋",
    shapes: [
      A(50, 74, 34, 180, 360),
      A(50, 74, 26, 180, 360),
      P([[16, 74], [16, 88]]),
      P([[84, 74], [84, 88]]),
      P([[34, 55], [34, 68]]),
      P([[50, 48], [50, 62]]),
      P([[66, 55], [66, 68]]),
      ...WAVES.slice(1),
    ],
  },
  {
    key: "mountain",
    name: "遠山",
    shapes: [
      P([
        [4, 70],
        [30, 26],
        [50, 52],
        [66, 32],
        [96, 70],
      ]),
      P([[22, 45], [30, 34], [38, 45]]),
      ...WAVES,
    ],
  },
  {
    key: "sun",
    name: "太陽",
    shapes: [
      C(50, 42, 20),
      P([[50, 8], [50, 16]]),
      P([[50, 68], [50, 76]]),
      P([[16, 42], [24, 42]]),
      P([[76, 42], [84, 42]]),
      P([[26, 18], [32, 24]]),
      P([[74, 18], [68, 24]]),
      P([[26, 66], [32, 60]]),
      P([[74, 66], [68, 60]]),
      ...WAVES.slice(1),
    ],
  },
  {
    key: "moon",
    name: "月光",
    shapes: [
      A(46, 40, 24, 40, 320),
      A(60, 40, 24, 130, 230),
      C(78, 20, 3),
      C(20, 26, 2.4),
      C(30, 14, 2),
      ...WAVES,
    ],
  },
  {
    key: "cloud",
    name: "雲",
    shapes: [
      C(36, 42, 14),
      C(54, 36, 18),
      C(70, 46, 12),
      P([[24, 54], [78, 54]]),
      ...WAVES,
    ],
  },
  {
    key: "rain",
    name: "雨",
    shapes: [
      C(34, 30, 12),
      C(52, 25, 16),
      C(68, 33, 11),
      P([[24, 42], [76, 42]]),
      P([[30, 54], [26, 68]]),
      P([[46, 54], [42, 68]]),
      P([[62, 54], [58, 68]]),
      P([[38, 72], [34, 86]]),
      P([[56, 72], [52, 86]]),
    ],
  },
  {
    key: "rainbow",
    name: "彩虹",
    shapes: [
      A(50, 78, 40, 180, 360),
      A(50, 78, 32, 180, 360),
      A(50, 78, 24, 180, 360),
      A(50, 78, 16, 180, 360),
      ...WAVES.slice(1),
    ],
  },
  {
    key: "lantern",
    name: "水燈",
    shapes: [
      P([
        [22, 60],
        [78, 60],
        [70, 80],
        [30, 80],
      ], true),
      E(50, 44, 18, 16),
      P([[32, 60], [36, 44]]),
      P([[68, 60], [64, 44]]),
      C(50, 46, 6),
      ...WAVES.slice(1),
    ],
  },
  {
    key: "star",
    name: "星星",
    shapes: [
      P([
        [50, 12],
        [61, 38],
        [89, 40],
        [67, 58],
        [75, 86],
        [50, 70],
        [25, 86],
        [33, 58],
        [11, 40],
        [39, 38],
      ], true),
    ],
  },
  {
    key: "whirl",
    name: "漩渦",
    shapes: [
      V([
        [50, 50],
        [58, 44],
        [58, 56],
        [46, 60],
        [40, 46],
        [52, 36],
        [68, 44],
        [70, 64],
        [50, 76],
        [28, 66],
        [22, 44],
        [38, 24],
        [64, 22],
        [84, 38],
      ]),
    ],
  },
  {
    key: "wave",
    name: "大浪",
    shapes: [
      V([[8, 76], [20, 46], [42, 28], [64, 32], [78, 50]]),
      V([[78, 50], [68, 64], [52, 60], [58, 46], [72, 48]]),
      V([[8, 76], [30, 80], [52, 76], [74, 80], [92, 76]]),
      C(34, 34, 3.4),
      C(50, 26, 2.6),
    ],
  },
  {
    key: "river-bend",
    name: "河道",
    shapes: [
      V([
        [6, 20],
        [34, 34],
        [30, 58],
        [58, 72],
        [94, 78],
      ]),
      V([
        [6, 42],
        [42, 52],
        [46, 74],
        [76, 90],
        [94, 94],
      ]),
      C(20, 32, 2.4),
      C(66, 80, 2.4),
    ],
  },
  {
    key: "raft",
    name: "竹筏",
    shapes: [
      P([[10, 62], [90, 62]]),
      P([[10, 70], [90, 70]]),
      P([[10, 62], [10, 70]]),
      P([[90, 62], [90, 70]]),
      P([[26, 62], [26, 70]]),
      P([[42, 62], [42, 70]]),
      P([[58, 62], [58, 70]]),
      P([[74, 62], [74, 70]]),
      P([[64, 62], [78, 22]]),
      ...WAVES.slice(1),
    ],
  },
  {
    key: "waterwheel",
    name: "水車",
    shapes: [
      C(50, 48, 32),
      C(50, 48, 10),
      P([[50, 16], [50, 80]]),
      P([[18, 48], [82, 48]]),
      P([[27, 25], [73, 71]]),
      P([[73, 25], [27, 71]]),
      ...WAVES.slice(1),
    ],
  },
  {
    key: "fishing",
    name: "釣竿",
    shapes: [
      V([[8, 84], [40, 40], [76, 20]]),
      P([[76, 20], [76, 62]]),
      V([[76, 62], [72, 70], [80, 74], [76, 80]]),
      C(50, 78, 5),
      ...WAVES.slice(1),
    ],
  },
  {
    key: "footbridge-stones",
    name: "踏石",
    shapes: [
      E(20, 44, 12, 8),
      E(44, 56, 13, 9),
      E(70, 44, 12, 8),
      E(88, 58, 9, 7),
      ...WAVES,
    ],
  },
  {
    key: "heron",
    name: "白鷺",
    shapes: [
      E(56, 58, 22, 14),
      V([[42, 50], [34, 26], [42, 16]]),
      P([[42, 16], [26, 20]]),
      C(40, 20, 2.4),
      P([[52, 70], [50, 88]]),
      P([[62, 70], [64, 88]]),
      V([[60, 52], [78, 46], [86, 58]]),
      ...WAVES.slice(1),
    ],
  },
];

/**
 * 把一個樣式畫進畫布。
 *
 * 只描邊不填色：這是給人塗的線稿，填滿了就沒地方塗了。
 */
export function drawStencil(
  ctx: CanvasRenderingContext2D,
  stencil: RiverStencil,
  color: string,
  lineWidth = 2.4,
): void {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  for (const shape of stencil.shapes) {
    ctx.beginPath();

    if (shape.k === "circle") {
      ctx.arc(shape.x, shape.y, shape.r, 0, Math.PI * 2);
    } else if (shape.k === "ellipse") {
      ctx.ellipse(
        shape.x,
        shape.y,
        shape.rx,
        shape.ry,
        shape.rot ?? 0,
        0,
        Math.PI * 2,
      );
    } else if (shape.k === "arc") {
      ctx.arc(
        shape.x,
        shape.y,
        shape.r,
        (shape.a0 * Math.PI) / 180,
        (shape.a1 * Math.PI) / 180,
      );
    } else if (shape.k === "poly") {
      const [first, ...rest] = shape.p;
      if (!first) {
        continue;
      }
      ctx.moveTo(first[0], first[1]);
      for (const [x, y] of rest) {
        ctx.lineTo(x, y);
      }
      if (shape.close) {
        ctx.closePath();
      }
    } else {
      // 中點二次曲線：跟簽名板同一套，轉角不會出現稜角
      const pts = shape.close ? [...shape.p, shape.p[0]!, shape.p[1]!] : shape.p;
      const first = pts[0];
      if (!first || pts.length < 2) {
        continue;
      }
      ctx.moveTo(first[0], first[1]);
      for (let i = 1; i < pts.length - 1; i += 1) {
        const cur = pts[i]!;
        const next = pts[i + 1]!;
        ctx.quadraticCurveTo(
          cur[0],
          cur[1],
          (cur[0] + next[0]) / 2,
          (cur[1] + next[1]) / 2,
        );
      }
      const last = pts[pts.length - 1]!;
      ctx.lineTo(last[0], last[1]);
    }

    ctx.stroke();
  }

  ctx.restore();
}

/** 畫成一張透明背景的畫布，給 DrawingCanvas 當底層或當選擇器縮圖用 */
export function renderStencilLayer(
  stencil: RiverStencil,
  color: string,
  size: number,
  lineWidth = 2.4,
): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;

  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return canvas;
  }

  ctx.scale(size / 100, size / 100);
  drawStencil(ctx, stencil, color, lineWidth);
  return canvas;
}

export function findStencil(key: string): RiverStencil | undefined {
  return RIVER_STENCILS.find((s) => s.key === key);
}
