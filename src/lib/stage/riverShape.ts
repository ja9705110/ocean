/**
 * 程式繪製河道的形狀參數（C9）。
 *
 * 原本河道是一組手調的座標寫死在模板裡。畫面本身是對的，
 * 但「對不對」只有現場投影出來才知道，而那時候已經改不動了——
 * 每調一次都要我改程式、重新部署。這一份把那組座標拆成六個可調的數字，
 * 後台拉一下就看到，不必經過我。
 *
 * 拆法不是把八個控制點都開放出來。那樣要調的是十六個數字，
 * 而且隨手一拉就會拉出一條打結的河。這裡改成：
 *
 *   一條直線（角度、長度、位置）＋ 一條固定的彎曲側寫（強度可調）
 *
 * 側寫是從原本那組座標反推出來的——把每個控制點投影到
 * 「起點到終點的連線」上，記下沿線位置 u 與側向偏移 v。
 * 預設值套回去會重建出原本那條河，最大誤差 0.00008（在 1600 寬的
 * 畫面上是 0.13 個像素），所以「恢復預設」真的會回到原來的樣子。
 *
 * 沒有 DOM 也沒有 Pixi：這一段的數學要能直接在 Node 裡驗證。
 */

export interface RiverPoint {
  readonly x: number;
  readonly y: number;
}

export interface RiverShape {
  /**
   * 流向：河道的整體走向角度（度）。
   *
   * 0 是往右，90 是往下（畫面座標的 y 是向下的），
   * 預設 140.5 就是主視覺的走向：從右上流向左下。
   * 加 180 度就是整條河反向流。
   */
  readonly angle: number;
  /**
   * 彎曲程度。1 是原本那條 S 型，0 是一條直線。
   *
   * 超過 1 之後 S 會愈甩愈開，2 已經是誇張的蛇行。
   */
  readonly bend: number;
  /** 長度倍率。1 是原本的長度（兩端都在畫面外一點）。 */
  readonly length: number;
  /** 寬度倍率。1 是原本的寬度。光帶、髮絲、光粒、簽名的散開範圍一起變。 */
  readonly width: number;
  /** 水平位置微調，以畫面寬度的比例計。正值往右。 */
  readonly offsetX: number;
  /** 垂直位置微調，以畫面高度的比例計。正值往下。 */
  readonly offsetY: number;
}

/**
 * 彎曲側寫：沿線位置 u（0~1）對側向偏移 v。
 *
 * 從原本手調的那八個控制點反推出來的，不是隨手畫的曲線。
 * u 的間距刻意不均勻——原本的河在中段轉折密、兩端疏，
 * 改成均勻取樣會把那個轉折抹平。
 */
export const RIVER_PROFILE: readonly { readonly u: number; readonly v: number }[] =
  [
    { u: 0, v: 0 },
    { u: 0.1639, v: 0.0525 },
    { u: 0.3074, v: 0.0514 },
    { u: 0.3633, v: -0.1065 },
    { u: 0.4965, v: -0.1344 },
    { u: 0.6627, v: -0.1178 },
    { u: 0.8666, v: -0.0502 },
    { u: 1, v: 0 },
  ];

/** 原本那條河從起點到終點的直線長度（以畫面比例計） */
export const RIVER_SPAN = 1.6338;

/** 原本那條河的中點。角度、長度、彎曲都以這一點為基準。 */
export const RIVER_CENTER: RiverPoint = { x: 0.39, y: 0.48 };

export const DEFAULT_RIVER_SHAPE: RiverShape = {
  angle: 140.5,
  bend: 1,
  length: 1,
  width: 1,
  offsetX: 0,
  offsetY: 0,
};

/**
 * 各項的可調範圍。
 *
 * 上下限不是為了限制，是為了「拉到底也不會壞」：
 * 長度低於 0.5 河會短到浮在畫面中央變成一條香腸，
 * 寬度高於 2.2 光帶會糊成一整片而看不出是河。
 */
export const RIVER_SHAPE_LIMITS: {
  readonly [K in keyof RiverShape]: {
    readonly min: number;
    readonly max: number;
    readonly step: number;
  };
} = {
  angle: { min: 0, max: 359, step: 0.5 },
  bend: { min: 0, max: 2, step: 0.05 },
  length: { min: 0.5, max: 1.6, step: 0.05 },
  width: { min: 0.4, max: 2.2, step: 0.05 },
  offsetX: { min: -0.35, max: 0.35, step: 0.01 },
  offsetY: { min: -0.35, max: 0.35, step: 0.01 },
};

function clamp(value: unknown, key: keyof RiverShape): number {
  const limit = RIVER_SHAPE_LIMITS[key];
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_RIVER_SHAPE[key];
  }
  return Math.min(limit.max, Math.max(limit.min, parsed));
}

/**
 * 角度要繞回 0~359，不是夾在兩端。
 *
 * 夾住的話從 359 度往上拉會卡死在 359，而使用者想要的是 0；
 * 那個地方剛好是「往右流」，不該是個死角。
 */
function wrapAngle(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_RIVER_SHAPE.angle;
  }
  return ((parsed % 360) + 360) % 360;
}

export function parseRiverShape(value: unknown): RiverShape {
  if (typeof value !== "object" || value === null) {
    return DEFAULT_RIVER_SHAPE;
  }
  const raw = value as Record<string, unknown>;
  return {
    angle: wrapAngle(raw.angle),
    bend: clamp(raw.bend, "bend"),
    length: clamp(raw.length, "length"),
    width: clamp(raw.width, "width"),
    offsetX: clamp(raw.offsetX, "offsetX"),
    offsetY: clamp(raw.offsetY, "offsetY"),
  };
}

/** 有沒有被動過。沒動過就不用在後台顯示「已改過」的提示。 */
export function riverShapeIsDefault(shape: RiverShape): boolean {
  return (
    Math.abs(shape.angle - DEFAULT_RIVER_SHAPE.angle) < 0.01 &&
    Math.abs(shape.bend - DEFAULT_RIVER_SHAPE.bend) < 0.001 &&
    Math.abs(shape.length - DEFAULT_RIVER_SHAPE.length) < 0.001 &&
    Math.abs(shape.width - DEFAULT_RIVER_SHAPE.width) < 0.001 &&
    Math.abs(shape.offsetX) < 0.001 &&
    Math.abs(shape.offsetY) < 0.001
  );
}

/**
 * 把參數展開成河道的控制點（以畫面寬高的比例計）。
 *
 * 側向偏移跟著長度一起縮放：把河改短的時候，整條河等比例變小，
 * 形狀還是同一條河。彎曲要另外加強或拉平，用 bend。
 */
export function buildRiverPath(shape: RiverShape): readonly RiverPoint[] {
  const radians = (shape.angle * Math.PI) / 180;
  const along = { x: Math.cos(radians), y: Math.sin(radians) };
  const across = { x: -along.y, y: along.x };
  const span = RIVER_SPAN * shape.length;
  const cx = RIVER_CENTER.x + shape.offsetX;
  const cy = RIVER_CENTER.y + shape.offsetY;

  return RIVER_PROFILE.map(({ u, v }) => {
    const forward = (u - 0.5) * span;
    const lateral = v * shape.bend * shape.length;
    return {
      x: cx + along.x * forward + across.x * lateral,
      y: cy + along.y * forward + across.y * lateral,
    };
  });
}
