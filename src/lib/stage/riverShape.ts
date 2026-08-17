/**
 * 程式繪製河道的形狀（C9 / C10）。
 *
 * 原本河道是一組手調的座標寫死在模板裡。畫面本身是對的，
 * 但「對不對」只有現場投影出來才知道，而那時候已經改不動了。
 * 這一份把那組座標拆成可調的參數，後台拉一下就看到。
 *
 * 拆法：
 *
 *   一條直線（流向、長度、位置）＋ 一串轉彎（每個轉彎的位置與方向）
 *
 * 轉彎是一串 {u, v}：u 是沿河的位置（0 最上游、1 最下游），
 * v 是側向偏移（正負決定往哪一邊彎，絕對值是幅度）。
 * 後台可以直接拖這些點，加一個轉彎就是往這串裡插一個。
 *
 * 預設值是從原本那組手調座標反推出來的——把每個控制點投影到
 * 起點終點的連線上，記下 u 與 v。套回去會重建出原本那條河，
 * 最大誤差 0.0005（1920 寬的畫面上是 1 個像素）。
 *
 * 頭尾一定會延伸到畫面外（見 buildRiverGeometry）：河要有「從遠處流過來、
 * 往近處流出去」的感覺，兩端收在畫面裡就變成一條躺在畫面中央的緞帶。
 *
 * 沒有 DOM 也沒有 Pixi：這一段的數學要能直接在 Node 裡驗證。
 */

export interface RiverPoint {
  readonly x: number;
  readonly y: number;
}

/** 一個轉彎 */
export interface RiverBend {
  /** 沿河的位置：0 是最上游，1 是最下游 */
  readonly u: number;
  /** 側向偏移：正負是彎的方向，絕對值是幅度 */
  readonly v: number;
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
   * 轉彎。空陣列就是一條直線。
   *
   * 順序不重要，展開時會依 u 排序——後台插入新的轉彎時不必自己找位置。
   */
  readonly bends: readonly RiverBend[];
  /** 長度倍率。1 是原本的長度。頭尾一律延伸到畫面外，這裡調的是彎道的疏密。 */
  readonly length: number;
  /** 寬度倍率。1 是原本的寬度。光帶、髮絲、光粒、簽名的散開範圍一起變。 */
  readonly width: number;
  /**
   * 水平位置微調。正值往右。
   *
   * 相對刻度，不是「畫面寬度的百分比」：背景的輝光層是烘成貼圖再貼回
   * 畫面的，位移在那一層會被縮掉一點（見 river.ts 的 bakeGlow）。
   */
  readonly offsetX: number;
  /** 垂直位置微調。正值往下。同樣是相對刻度。 */
  readonly offsetY: number;
}

/**
 * 預設的轉彎：一個平緩的 S。
 *
 * 原本的預設是從那張主視覺描下來的八個控制點反推的，數字上很忠實，
 * 但那條 S 其實是個髮夾彎——側向甩出 0.16 只花了 0.06 的行程，
 * 換算成畫面上是「一百四十個像素的橫移配上一百四十個像素的前進」。
 *
 * 那個急彎在河很細的時候看不出來，一旦光帶有寬度就出事：
 * 彎道內側的光絲會翻折過去，填色時冒出一塊亮楔形。以前那塊楔形被
 * 對不準的輝光糊掉了，輝光一對準就露出來。
 *
 * 所以預設改成兩個平緩的轉彎，走向仍然是從右上到左下。
 * 要更急的彎可以在後台自己拖——那是使用者的選擇，不是預設就該長這樣。
 */
export const DEFAULT_BENDS: readonly RiverBend[] = [
  { u: 0.32, v: 0.062 },
  { u: 0.66, v: -0.085 },
];

/** 原本那條河從起點到終點的直線長度（以畫面比例計） */
export const RIVER_SPAN = 1.6338;

/** 原本那條河的中點。流向、長度、轉彎都以這一點為基準。 */
export const RIVER_CENTER: RiverPoint = { x: 0.39, y: 0.48 };

/**
 * 頭尾往畫面外延伸的距離（正規化空間）。
 *
 * 1.25 是「從畫面內任何一點往任何方向走這麼遠，一定會出界」的距離
 * （單位正方形的對角線是 1.414，而河道中心一定在畫面內）。
 * 這樣不管流向轉到哪裡、長度調到多短，兩端都看不到收尾。
 */
export const RIVER_LEAD = 1.25;

/** 轉彎數量的上限。超過這個數字，河道會變成一團彈簧。 */
export const MAX_BENDS = 8;

export const DEFAULT_RIVER_SHAPE: RiverShape = {
  angle: 140.5,
  bends: DEFAULT_BENDS,
  length: 1,
  width: 1,
  offsetX: 0,
  offsetY: 0,
};

/**
 * 數值項目的可調範圍。
 *
 * 上下限不是為了限制，是為了「拉到底也不會壞」：
 * 寬度高於 2.2 光帶會糊成一整片而看不出是河。
 */
export const RIVER_SHAPE_LIMITS = {
  angle: { min: 0, max: 359, step: 0.5 },
  length: { min: 0.5, max: 1.8, step: 0.05 },
  width: { min: 0.4, max: 2.2, step: 0.05 },
  offsetX: { min: -0.5, max: 0.5, step: 0.01 },
  offsetY: { min: -0.5, max: 0.5, step: 0.01 },
} as const;

/** 轉彎的側向偏移上限。再大就會甩出畫面外，看起來不像同一條河。 */
export const MAX_BEND_V = 0.45;

type NumericKey = keyof typeof RIVER_SHAPE_LIMITS;

function clamp(value: unknown, key: NumericKey): number {
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

function parseBends(value: unknown, legacyBend: unknown): readonly RiverBend[] {
  if (Array.isArray(value)) {
    const bends = value
      .filter(
        (item): item is Record<string, unknown> =>
          typeof item === "object" && item !== null,
      )
      .map((item) => ({
        u: Math.min(0.97, Math.max(0.03, Number(item.u))),
        v: Math.min(MAX_BEND_V, Math.max(-MAX_BEND_V, Number(item.v))),
      }))
      .filter((bend) => Number.isFinite(bend.u) && Number.isFinite(bend.v))
      .slice(0, MAX_BENDS)
      .sort((a, b) => a.u - b.u);
    // 空陣列是合法的——那是一條直線，使用者可能真的要
    return bends;
  }

  // C9 舊資料只有一個 bend 倍率。用它去縮放預設的轉彎，
  // 已經設定過的活動升級之後畫面不會突然變樣。
  const scale = Number(legacyBend);
  if (Number.isFinite(scale)) {
    return DEFAULT_BENDS.map((bend) => ({
      u: bend.u,
      v: Math.min(MAX_BEND_V, Math.max(-MAX_BEND_V, bend.v * scale)),
    }));
  }

  return DEFAULT_BENDS;
}

export function parseRiverShape(value: unknown): RiverShape {
  if (typeof value !== "object" || value === null) {
    return DEFAULT_RIVER_SHAPE;
  }
  const raw = value as Record<string, unknown>;
  return {
    angle: wrapAngle(raw.angle),
    bends: parseBends(raw.bends, raw.bend),
    length: clamp(raw.length, "length"),
    width: clamp(raw.width, "width"),
    offsetX: clamp(raw.offsetX, "offsetX"),
    offsetY: clamp(raw.offsetY, "offsetY"),
  };
}

/** 有沒有被動過。沒動過就不用在後台顯示「已改過」的提示。 */
export function riverShapeIsDefault(shape: RiverShape): boolean {
  const sameBends =
    shape.bends.length === DEFAULT_BENDS.length &&
    shape.bends.every((bend, i) => {
      const base = DEFAULT_BENDS[i]!;
      return Math.abs(bend.u - base.u) < 0.001 && Math.abs(bend.v - base.v) < 0.001;
    });

  return (
    sameBends &&
    Math.abs(shape.angle - DEFAULT_RIVER_SHAPE.angle) < 0.01 &&
    Math.abs(shape.length - DEFAULT_RIVER_SHAPE.length) < 0.001 &&
    Math.abs(shape.width - DEFAULT_RIVER_SHAPE.width) < 0.001 &&
    Math.abs(shape.offsetX) < 0.001 &&
    Math.abs(shape.offsetY) < 0.001
  );
}

/**
 * 主體控制點（不含往畫面外的延伸）。
 *
 * 後台的轉彎編輯器畫的就是這一段，檢查腳本驗的也是這一段。
 * 實際繪製請用 buildRiverGeometry。
 */
export function buildRiverPath(shape: RiverShape): readonly RiverPoint[] {
  const radians = (shape.angle * Math.PI) / 180;
  const along = { x: Math.cos(radians), y: Math.sin(radians) };
  const across = { x: -along.y, y: along.x };
  const span = RIVER_SPAN * shape.length;
  const cx = RIVER_CENTER.x + shape.offsetX;
  const cy = RIVER_CENTER.y + shape.offsetY;

  const profile: readonly RiverBend[] = [
    { u: 0, v: 0 },
    ...[...shape.bends].sort((a, b) => a.u - b.u),
    { u: 1, v: 0 },
  ];

  return profile.map(({ u, v }) => {
    const forward = (u - 0.5) * span;
    // 側向偏移跟著長度一起縮放：把河改短的時候整條等比例變小，
    // 形狀還是同一條河
    const lateral = v * shape.length;
    return {
      x: cx + along.x * forward + across.x * lateral,
      y: cy + along.y * forward + across.y * lateral,
    };
  });
}

export interface RiverGeometry {
  /** 含頭尾延伸的完整控制點 */
  readonly points: readonly RiverPoint[];
  /** 主體（畫面內那一段）在 t 上的起點 */
  readonly from: number;
  /** 主體在 t 上的終點 */
  readonly to: number;
  /**
   * 速度補償。
   *
   * 延伸之後同樣的 t 走過的距離變長了，不補償的話河會整個慢下來，
   * 而且慢多少取決於長度設定——那是使用者不會預期的連動。
   */
  readonly speedScale: number;
  /**
   * 主體兩端各留多少 t 給「進出畫面」用。
   *
   * 簽名在 [from - margin, to + margin] 之間循環。兩端都在畫面外，
   * 所以迴圈的接點看不到——那正是光粒看起來一直流不停的原因，
   * 簽名也該一樣。
   */
  readonly margin: number;
}

/**
 * 展開成實際繪製用的控制點：主體加上往兩端畫面外的延伸。
 *
 * 延伸段沿著兩端的切線直直往外，而且每一段的長度跟主體的間距一致——
 * 樣條是以「每段等參數」走的，段長不一致的話光粒會在某些地方
 * 突然加速，看起來像卡頓。
 */
export function buildRiverGeometry(shape: RiverShape): RiverGeometry {
  const main = buildRiverPath(shape);
  const first = main[0];
  const second = main[1];
  const last = main[main.length - 1];
  const beforeLast = main[main.length - 2];

  if (!first || !second || !last || !beforeLast) {
    return { points: main, from: 0, to: 1, speedScale: 1, margin: 0 };
  }

  const step = (RIVER_SPAN * shape.length) / (main.length - 1);
  const leadCount = Math.max(1, Math.ceil(RIVER_LEAD / step));

  const direction = (from: RiverPoint, to: RiverPoint): RiverPoint => {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const len = Math.hypot(dx, dy) || 1;
    return { x: dx / len, y: dy / len };
  };

  // 上游：從第一點往「進入方向的反面」延伸
  const inDir = direction(first, second);
  const head: RiverPoint[] = [];
  for (let k = leadCount; k >= 1; k -= 1) {
    head.push({
      x: first.x - inDir.x * step * k,
      y: first.y - inDir.y * step * k,
    });
  }

  // 下游：從最後一點沿著出去的方向繼續走
  const outDir = direction(beforeLast, last);
  const tail: RiverPoint[] = [];
  for (let k = 1; k <= leadCount; k += 1) {
    tail.push({
      x: last.x + outDir.x * step * k,
      y: last.y + outDir.y * step * k,
    });
  }

  const points = [...head, ...main, ...tail];
  const totalSegments = points.length - 1;
  const mainSegments = main.length - 1;

  // 0.32 個正規化單位：夠讓角色整個離開畫面，又不會佔掉太多行程
  // （佔太多的話同一時間看得到的簽名就變少了）
  const margin = Math.min(
    leadCount / totalSegments,
    0.32 / (totalSegments * step),
  );

  return {
    points,
    from: leadCount / totalSegments,
    to: (leadCount + mainSegments) / totalSegments,
    speedScale: totalSegments / mainSegments,
    margin,
  };
}

/**
 * 平均分佈的轉彎，用在後台按下「加一個轉彎」的時候。
 *
 * 方向交替：加出來的是蛇行，不是往同一邊愈滑愈遠。
 */
export function evenBends(count: number, amplitude = 0.13): readonly RiverBend[] {
  const n = Math.min(MAX_BENDS, Math.max(0, Math.round(count)));
  const bends: RiverBend[] = [];
  for (let i = 0; i < n; i += 1) {
    bends.push({
      u: (i + 1) / (n + 1),
      v: (i % 2 === 0 ? 1 : -1) * amplitude,
    });
  }
  return bends;
}

/**
 * 河道的外觀（不影響形狀，只影響看起來多亮、光粒多少）。
 *
 * 跟形狀分開的理由：形狀改了要重算路徑，外觀改了只要重畫，
 * 而且這兩件事在現場是不同時間調的——形狀是活動前排版，
 * 亮度是投影打上去、簽名蓋上去之後才知道要壓多少。
 */
export interface RiverLook {
  /**
   * 河道亮度。1 是原本的亮度。
   *
   * 調低的用途很具體：簽名是疊在河道上的，河太亮名字就讀不出來。
   * 下限沒訂到 0——河整個不見的話畫面就只剩黑底，那不是設定，是壞掉。
   */
  readonly brightness: number;
  /** 懸浮光粒的數量。0 就是完全不要。 */
  readonly particleCount: number;
  /** 光粒大小倍率 */
  readonly particleSize: number;
  /** 光粒亮度倍率 */
  readonly particleBrightness: number;
}

export const DEFAULT_RIVER_LOOK: RiverLook = {
  brightness: 1,
  particleCount: 900,
  particleSize: 1,
  particleBrightness: 1,
};

export const RIVER_LOOK_LIMITS = {
  brightness: { min: 0.25, max: 1.5, step: 0.05 },
  // 上限 1600：ParticleContainer 是為了大量同貼圖實例設計的，
  // 這個量級在投影機常見的內顯上仍然滿幀。
  particleCount: { min: 0, max: 1600, step: 50 },
  particleSize: { min: 0.4, max: 2.5, step: 0.1 },
  particleBrightness: { min: 0.2, max: 1.8, step: 0.05 },
} as const;

function clampLook(value: unknown, key: keyof RiverLook): number {
  const limit = RIVER_LOOK_LIMITS[key];
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_RIVER_LOOK[key];
  }
  return Math.min(limit.max, Math.max(limit.min, parsed));
}

export function parseRiverLook(value: unknown): RiverLook {
  if (typeof value !== "object" || value === null) {
    return DEFAULT_RIVER_LOOK;
  }
  const raw = value as Record<string, unknown>;
  return {
    brightness: clampLook(raw.brightness, "brightness"),
    particleCount: Math.round(clampLook(raw.particleCount, "particleCount")),
    particleSize: clampLook(raw.particleSize, "particleSize"),
    particleBrightness: clampLook(raw.particleBrightness, "particleBrightness"),
  };
}

export function riverLookIsDefault(look: RiverLook): boolean {
  return (
    Math.abs(look.brightness - 1) < 0.001 &&
    look.particleCount === DEFAULT_RIVER_LOOK.particleCount &&
    Math.abs(look.particleSize - 1) < 0.001 &&
    Math.abs(look.particleBrightness - 1) < 0.001
  );
}
