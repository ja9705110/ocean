import {
  BlurFilter,
  Container,
  FillGradient,
  Graphics,
  Particle,
  ParticleContainer,
  Sprite,
  type Application,
} from "pixi.js";
import gsap from "gsap";
import {
  DEFAULT_RIVER_SHAPE,
  buildRiverPath,
  type RiverShape,
} from "@/lib/stage/riverShape";
import type {
  CharacterBehavior,
  CharacterMotionState,
  LayoutBand,
  Point,
  Rect,
  Timeline,
  WorldFrameContext,
  WorldTemplate,
} from "@/world/types";

/**
 * 河流世界：「流嚮 FLOW TOGETHER」。
 *
 * 這是活動主視覺的向量版本——深夜藍的水面上，幾道金色的光流蜿蜒而下，
 * 最後匯聚成同一個方向。
 *
 * 為什麼用向量重畫而不是直接鋪主視覺圖檔：
 * 1. 主視覺上有標題、logo 與日期，簽名蓋上去會互相打架。
 * 2. 圖檔是靜止的。這一頁的重點是「流動」與「匯聚」，
 *    光流必須真的在動，簽名也必須真的順流而下。
 * 3. 投影機的解析度與比例每場都不同，向量在哪裡都清晰。
 *
 * 主視覺的色票取自那張圖：深藍底、金色光流、暖白的高光。
 */

const NAVY_DEEP = "#02040c";
const NAVY_MID = "#061024";
const NAVY_SOFT = "#0c1f42";
/** 水面上的藍色緞帶：比底色亮，但遠不到金色的亮度 */
const WATER_RIBBON = "#17386c";
/** 絲綢紋理裡比較亮的那一種藍 */
const WATER_LINE = "#2a5da8";

/**
 * 環境光粒的速度倍率。
 *
 * 角色的速度是每幀從 WorldFrameContext 拿的，但環境層沒有那個管道——
 * buildAmbient 只拿得到 Application。與其為此把整個 context 灌進環境層，
 * 不如讓渲染器在設定速度時順手通知模板一次（WorldTemplate.onSpeedScaleChange）。
 */
let ambientSpeedScale = 1;
const GOLD = "#f2c063";
const GOLD_BRIGHT = "#ffe6b0";
/** 光流最亮的芯，主視覺上那幾道近乎白色的高光 */
const GOLD_CORE = "#fff6e2";
const GOLD_DEEP = "#c88b2c";

/**
 * 河道中心線。以畫面寬高的比例表示，繪製時再乘上實際尺寸。
 *
 * 走向的預設值取自主視覺：從右上進來，中段回甩成一個 S，
 * 再往左下流出去。
 *
 * 位置比主視覺整體左移了一些，因為大螢幕的 QR Code 與人數面板固定在
 * 右上角（畫面寬的 0.73 之後）。照著原圖擺，最亮、簽名最密的那一段
 * 會正好被面板蓋住——投影出來看不到的東西畫得再漂亮也沒有意義。
 *
 * 現在這組座標是從六個可調參數展開來的（C9），主持人在後台改
 * 角度、彎曲、長度、寬度與位置，不必動程式。預設值展開的結果
 * 就是原本那組手調的座標。
 */
let shape: RiverShape = DEFAULT_RIVER_SHAPE;
let RIVER_PATH: readonly Point[] = buildRiverPath(DEFAULT_RIVER_SHAPE);

/**
 * 套用新的河道形狀。
 *
 * 只改參數不會讓畫面變——背景是啟動時烘成貼圖的，光粒的偏移函式
 * 也是建立時就決定的。呼叫端改完要請 WorldRenderer 重建環境層
 * （rebuildEnvironment），這裡刻意不自己去碰渲染器：
 * 模板不應該知道誰在用它。
 */
export function setRiverShape(next: RiverShape): void {
  shape = next;
  RIVER_PATH = buildRiverPath(next);
}

export function getRiverShape(): RiverShape {
  return shape;
}

/**
 * 側向偏移的統一縮放。
 *
 * 所有貼著河道的東西——光帶、髮絲、水紋、光粒、簽名——的偏移量
 * 都要經過這裡，寬度倍率才會一起變。漏掉任何一處，
 * 把河調寬之後就會看到光帶變寬但光粒還擠在原來的細線上。
 */
function lateral(offset: number): number {
  return offset * shape.width;
}

/**
 * Catmull-Rom 樣條上的一點。
 *
 * 一開始用線性內插加 smoothstep，結果在控制點上留下明顯的折角——
 * 投影到牆上像是一條折線而不是河。樣條會通過每一個控制點，
 * 而且在接點處切線連續，看起來才是真的在流。
 */
function spline(p0: number, p1: number, p2: number, p3: number, t: number) {
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    0.5 *
    (2 * p1 +
      (-p0 + p2) * t +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
      (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
  );
}

function pointAt(t: number, bounds: Rect): Point {
  const clamped = Math.min(Math.max(t, 0), 0.99999);
  const span = RIVER_PATH.length - 1;
  const scaled = clamped * span;
  const i = Math.floor(scaled);
  const f = scaled - i;

  const at = (k: number) =>
    RIVER_PATH[Math.min(Math.max(k, 0), span)] ?? RIVER_PATH[0]!;
  const p0 = at(i - 1);
  const p1 = at(i);
  const p2 = at(i + 1);
  const p3 = at(i + 2);

  return {
    x: spline(p0.x, p1.x, p2.x, p3.x, f) * bounds.width,
    y: spline(p0.y, p1.y, p2.y, p3.y, f) * bounds.height,
  };
}

/** 取得河道上參數位置 t（0~1）的座標與切線方向 */
function riverAt(
  t: number,
  bounds: Rect,
): { readonly x: number; readonly y: number; readonly angle: number } {
  const here = pointAt(t, bounds);
  // 切線用前後取樣求，比解析微分好寫也夠準
  const ahead = pointAt(Math.min(t + 0.004, 1), bounds);
  const behind = pointAt(Math.max(t - 0.004, 0), bounds);

  return {
    x: here.x,
    y: here.y,
    angle: Math.atan2(ahead.y - behind.y, ahead.x - behind.x),
  };
}

/** 等距並行：上下游都保持同樣的距離 */
function parallel(offset: number): (t: number) => number {
  return () => offset;
}

/**
 * 散開的細絲：上游幾乎貼著芯，往下游愈散愈開。
 * spread 是它在最下游能跑多遠，bend 控制散開的快慢
 * （次方大於一表示前段先跟著走，後段才甩出去）。
 */
function fanning(
  start: number,
  spread: number,
  bend: number,
): (t: number) => number {
  return (t) => start + spread * Math.pow(t, bend);
}
/**
 * 一條有粗細變化的光帶。
 *
 * 原本用 stroke 畫等寬的線，投出來就是主視覺裡沒有的東西——一根繩子。
 * 真實的光流是中段最寬、兩端收成一個點，而且邊緣是漸消的。
 * 這裡改成填一個多邊形：沿著河道走一遍記下左側，再倒著走回來記右側。
 *
 * widthAt 回傳的是半寬。回傳 0 的地方光帶就收尖了。
 */
function ribbon(
  g: Graphics,
  bounds: Rect,
  offsetAt: (t: number) => number,
  widthAt: (t: number) => number,
  steps = 160,
): void {
  const left: Point[] = [];
  const right: Point[] = [];

  for (let s = 0; s <= steps; s += 1) {
    const t = s / steps;
    const { x, y, angle } = riverAt(t, bounds);
    const nx = Math.sin(angle);
    const ny = -Math.cos(angle);
    const offset = lateral(offsetAt(t));
    const half = lateral(widthAt(t));

    left.push({ x: x + nx * (offset - half), y: y + ny * (offset - half) });
    right.push({ x: x + nx * (offset + half), y: y + ny * (offset + half) });
  }

  const first = left[0];
  if (!first) {
    return;
  }
  g.moveTo(first.x, first.y);
  for (const point of left.slice(1)) {
    g.lineTo(point.x, point.y);
  }
  for (let i = right.length - 1; i >= 0; i -= 1) {
    const point = right[i];
    if (point) {
      g.lineTo(point.x, point.y);
    }
  }
  g.closePath();
}

/**
 * 光帶的粗細曲線：兩端收尖、中段飽滿。
 *
 * 指數小於一會讓中段變成一個「平台」而不是尖峰，
 * 那才像主視覺裡那種一路亮過去的光帶；純 sin 會讓亮處只有一小段。
 */
function taper(peak: number, plateau = 0.55): (t: number) => number {
  return (t) => peak * Math.pow(Math.sin(Math.PI * t), plateau);
}

/**
 * 把一個容器烘焙成貼圖。
 *
 * 這是整個輝光的關鍵：BlurFilter 若掛在會被每幀重繪的容器上，
 * 在投影機那台機器上是最容易掉幀的東西——這也是我一開始完全避開它、
 * 結果畫出一堆硬邊線條的原因。
 *
 * 但背景只建立一次。在建立時套上模糊、當場烘成一張貼圖，
 * 之後每幀畫的就只是一個 Sprite，執行期成本是零。
 *
 * resolution 刻意小於 1：模糊本來就會把細節抹掉，
 * 用一半的解析度存這張圖，記憶體省四倍而肉眼看不出差別。
 */
function bakeGlow(
  app: Application,
  draw: (g: Graphics) => void,
  blur: number,
  resolution: number,
  tint?: string,
): Sprite {
  const { width, height } = app.screen;

  const graphics = new Graphics();
  // 先鋪一塊全螢幕的透明矩形，把容器的邊界撐到整個畫面。
  // 沒有這一塊，烘出來的貼圖只會有圖形本身的外框，
  // 貼回畫面時位置與比例都會跑掉。
  graphics.rect(0, 0, width, height).fill({ color: 0x000000, alpha: 0 });
  draw(graphics);

  const holder = new Container();
  holder.addChild(graphics);
  if (blur > 0) {
    const filter = new BlurFilter({ strength: blur, quality: 4 });
    // 不加 padding 的話，模糊會在圖形原本的邊界被硬生生切斷
    filter.padding = blur * 2;
    holder.filters = [filter];
  }

  const texture = app.renderer.generateTexture({
    target: holder,
    resolution,
    antialias: true,
  });

  holder.destroy({ children: true });

  const sprite = new Sprite(texture);
  sprite.width = width;
  sprite.height = height;
  sprite.blendMode = "add";
  if (tint) {
    // 三層都用原色的話，疊加混色會把金色一路推到全白，
    // 核心就變成一團沒有顏色的灰霧。外圈染成暖金，
    // 只有最中間那一道細芯才准是白的——主視覺就是這個層次。
    sprite.tint = tint;
  }
  sprite.on("destroyed", () => texture.destroy(true));
  return sprite;
}

/** 一股光流的描述 */
interface Strand {
  readonly offsetAt: (t: number) => number;
  readonly widthAt: (t: number) => number;
  readonly color: string;
  readonly alpha: number;
}

/**
 * 產生所有光流。
 *
 * 三種角色：
 * - core：中央那幾道近乎白色的主光帶，寬、亮、幾乎不散開
 * - mid：伴隨主光帶的金色副流，稍微散開
 * - hair：大量的髮絲，細、暗、散得很開，負責做出主視覺左下角那片絲綢感
 *
 * 髮絲的數量是這張圖「高不高級」的關鍵。少於一百根就會看得出是
 * 一根一根畫的；多到兩百根以上，眼睛就只讀得到「一片流動的光」。
 */
function buildStrands(): readonly Strand[] {
  const strands: Strand[] = [];

  // 主光帶
  strands.push(
    // 主光帶是金的；只有最中央那一道細芯才是白熱的。
    // 三道都用白色的話，疊起來整束會變成銀色，主視覺的暖金就沒了。
    {
      offsetAt: fanning(-10, -18, 1.3),
      widthAt: taper(4.5),
      color: GOLD_BRIGHT,
      alpha: 0.9,
    },
    {
      offsetAt: parallel(6),
      widthAt: taper(6.5),
      color: GOLD_BRIGHT,
      alpha: 1,
    },
    {
      offsetAt: parallel(6),
      widthAt: taper(1.6, 0.35),
      color: GOLD_CORE,
      alpha: 1,
    },
    {
      offsetAt: fanning(24, 40, 1.3),
      widthAt: taper(3.6),
      color: GOLD,
      alpha: 0.9,
    },
  );

  // 金色副流
  for (let i = 0; i < 16; i += 1) {
    const side = i % 2 === 0 ? 1 : -1;
    const rank = (i + 1) / 16;
    strands.push({
      offsetAt: fanning(
        side * gsap.utils.random(14, 60),
        side * (60 + rank * 180) * gsap.utils.random(0.85, 1.15),
        gsap.utils.random(1.3, 2),
      ),
      widthAt: taper(gsap.utils.random(1.2, 3.2)),
      color: gsap.utils.random([GOLD, GOLD_BRIGHT]),
      alpha: gsap.utils.random(0.55, 0.9),
    });
  }

  // 髮絲
  const HAIRS = 190;
  for (let i = 0; i < HAIRS; i += 1) {
    const side = i % 2 === 0 ? 1 : -1;
    const rank = (i + 1) / HAIRS;
    strands.push({
      offsetAt: fanning(
        side * gsap.utils.random(8, 120),
        side * (70 + rank * 470) * gsap.utils.random(0.7, 1.3),
        gsap.utils.random(1.4, 2.8),
      ),
      widthAt: taper(gsap.utils.random(0.35, 0.9), gsap.utils.random(0.4, 0.8)),
      color: gsap.utils.random([GOLD, GOLD_DEEP, GOLD_BRIGHT]),
      alpha: gsap.utils.random(0.05, 0.16),
    });
  }

  return strands;
}

function buildBackground(app: Application): Container {
  const container = new Container();
  const { width, height } = app.screen;

  // 夜色水面：由上而下加深
  const base = new Graphics();
  const gradient = new FillGradient({
    type: "linear",
    start: { x: 0.5, y: 0 },
    end: { x: 0.35, y: 1 },
    colorStops: [
      { offset: 0, color: NAVY_MID },
      { offset: 0.45, color: NAVY_SOFT },
      { offset: 1, color: NAVY_DEEP },
    ],
  });
  base.rect(0, 0, width, height).fill(gradient);
  container.addChild(base);

  // 遠處的水光暈，讓畫面不會是一片死藍
  const glow = new Graphics();
  const glowGradient = new FillGradient({
    type: "radial",
    center: { x: 0.5, y: 0.5 },
    innerRadius: 0,
    outerCenter: { x: 0.5, y: 0.5 },
    outerRadius: 0.5,
    colorStops: [
      { offset: 0, color: "#1b3a6b" },
      { offset: 1, color: "#1b3a6b00" },
    ],
  });
  glow
    .ellipse(width * 0.62, height * 0.26, width * 0.44, height * 0.4)
    .fill(glowGradient);
  glow.alpha = 0.55;
  container.addChild(glow);

  // 藍色的水緞帶：跟著河道走的寬大低對比色塊
  const water = new Graphics();
  const waterBands: readonly { start: number; spread: number; half: number }[] =
    [
      { start: -320, spread: -240, half: 68 },
      { start: -210, spread: -170, half: 50 },
      { start: -120, spread: -110, half: 38 },
      { start: 110, spread: 150, half: 44 },
      { start: 200, spread: 240, half: 58 },
      { start: 310, spread: 330, half: 74 },
    ];
  for (const band of waterBands) {
    ribbon(
      water,
      app.screen,
      fanning(band.start, band.spread, 1.5),
      taper(band.half, 0.7),
    );
    water.fill({ color: WATER_RIBBON, alpha: 0.1 });
  }
  container.addChild(water);

  // 水面的絲綢紋理：大量沿著河道走的極細藍線。
  // 主視覺裡金線之外的那一大片並不是空的，是密密麻麻的細紋——
  // 少了它，深藍區域會是一塊死掉的色塊。
  const silk = new Graphics();
  for (let i = 0; i < 260; i += 1) {
    const side = i % 2 === 0 ? 1 : -1;
    const rank = (i + 1) / 260;
    ribbon(
      silk,
      app.screen,
      fanning(
        side * gsap.utils.random(30, 200),
        side * (120 + rank * 620) * gsap.utils.random(0.7, 1.3),
        gsap.utils.random(1.3, 2.6),
      ),
      taper(gsap.utils.random(0.25, 0.7), gsap.utils.random(0.4, 0.9)),
      120,
    );
    silk.fill({
      color: gsap.utils.random([WATER_RIBBON, WATER_LINE]),
      alpha: gsap.utils.random(0.035, 0.1),
    });
  }
  container.addChild(silk);

  const strands = buildStrands();
  const paint = (g: Graphics) => {
    for (const strand of strands) {
      ribbon(g, app.screen, strand.offsetAt, strand.widthAt);
      g.fill({ color: strand.color, alpha: strand.alpha });
    }
  };

  // 輝光三層：外圈很寬很淡的暈、中圈、然後才是清晰的光帶本身。
  // 疊加混色之下，重疊處會自然變成白熱——那就是主視覺裡最亮的地方。
  //
  // 模糊半徑刻意不跟著寬度倍率走。
  //
  // 試過讓它跟著放大，結果是「河變得更淡」而不是「更寬」：模糊把同樣的
  // 亮度攤到更大的面積上，量出來的金色像素反而少了四成。
  // 外圈的暈是光帶周圍固定範圍的散射，寬度該由光帶本身的幾何決定。
  const wide = bakeGlow(app, paint, 46, 0.35, GOLD_DEEP);
  wide.alpha = 0.62;
  container.addChild(wide);

  const halo = bakeGlow(app, paint, 24, 0.45, GOLD);
  halo.alpha = 0.6;
  container.addChild(halo);

  const mid = bakeGlow(app, paint, 9, 0.6, GOLD_BRIGHT);
  mid.alpha = 0.75;
  container.addChild(mid);

  const sharp = bakeGlow(app, paint, 0, 1);
  container.addChild(sharp);

  // 整束光流輕輕呼吸。只動三個 Sprite 的 alpha，不重畫任何東西。
  const tweens = [
    gsap.to(wide, {
      alpha: 0.68,
      duration: 5.5,
      repeat: -1,
      yoyo: true,
      ease: "sine.inOut",
    }),
    gsap.to(halo, {
      alpha: 0.78,
      duration: 4.6,
      repeat: -1,
      yoyo: true,
      ease: "sine.inOut",
      delay: 0.7,
    }),
    gsap.to(mid, {
      alpha: 0.92,
      duration: 4,
      repeat: -1,
      yoyo: true,
      ease: "sine.inOut",
      delay: 1.2,
    }),
  ];

  container.on("destroyed", () => {
    for (const tween of tweens) {
      tween.kill();
    }
  });

  return container;
}

/**
 * 順流而下的光粒。
 *
 * 這是「流動」最直接的證據，也是主視覺與我第一版之間最大的差距：
 * 那張圖的光帶上有成千上萬顆亮點，人眼讀到的是「光在流」，
 * 而不是「有幾條線」。
 *
 * 用 ParticleContainer 而不是一般的 Container：後者每個 Sprite 都是
 * 完整的顯示物件，一千個就要跑一千次變換計算與繪製呼叫；
 * 前者是為了同一張貼圖的大量實例設計的，一次就畫完。
 *
 * 位置更新掛在 ticker 上手算，而不是每顆各開一個 GSAP tween：
 * 一千個 tween 的排程成本遠高於一個迴圈。
 */
function buildAmbient(app: Application): Container {
  const container = new Container();

  // 光點貼圖：中心白、邊緣透明的圓。用漸層而不是實心圓，
  // 實心圓放大之後邊緣是硬的，看起來像貼紙不像光。
  const dot = new Graphics();
  const dotGradient = new FillGradient({
    type: "radial",
    center: { x: 0.5, y: 0.5 },
    innerRadius: 0,
    outerCenter: { x: 0.5, y: 0.5 },
    outerRadius: 0.5,
    colorStops: [
      { offset: 0, color: "#ffffff" },
      { offset: 0.35, color: "#fff2d0" },
      { offset: 1, color: "#f2c06300" },
    ],
  });
  dot.circle(32, 32, 32).fill(dotGradient);
  const texture = app.renderer.generateTexture({ target: dot, resolution: 1 });
  dot.destroy();

  const particles = new ParticleContainer({
    dynamicProperties: { position: true, scale: false, alpha: true },
  });
  particles.blendMode = "add";
  container.addChild(particles);

  interface Spark {
    readonly particle: Particle;
    /** 在河道上的位置 */
    t: number;
    readonly speed: number;
    readonly offsetAt: (t: number) => number;
    readonly baseAlpha: number;
    /** 閃爍用的相位 */
    readonly phase: number;
  }

  const sparks: Spark[] = [];
  const COUNT = 900;

  for (let i = 0; i < COUNT; i += 1) {
    // 大部分光粒貼著主光帶跑，少部分散在外圍的髮絲上。
    // 全部平均分佈的話，亮處不會亮，整片會糊成一樣的密度。
    const nearCore = Math.random() < 0.62;
    const side = Math.random() < 0.5 ? 1 : -1;

    const size = nearCore
      ? gsap.utils.random(1.6, 5)
      : gsap.utils.random(1, 3);

    const particle = new Particle({
      texture,
      anchorX: 0.5,
      anchorY: 0.5,
      scaleX: size / 64,
      scaleY: size / 64,
    });

    const spark: Spark = {
      particle,
      t: Math.random(),
      speed: gsap.utils.random(0.02, 0.075),
      offsetAt: nearCore
        ? fanning(
            side * gsap.utils.random(2, 40),
            side * gsap.utils.random(20, 160),
            gsap.utils.random(1.2, 2),
          )
        : fanning(
            side * gsap.utils.random(30, 140),
            side * gsap.utils.random(150, 620),
            gsap.utils.random(1.4, 2.8),
          ),
      baseAlpha: nearCore
        ? gsap.utils.random(0.5, 1)
        : gsap.utils.random(0.15, 0.5),
      phase: Math.random() * Math.PI * 2,
    };

    sparks.push(spark);
    particles.addParticle(particle);
  }

  let elapsed = 0;

  const update = (): void => {
    const deltaSeconds = app.ticker.deltaMS / 1000;
    elapsed += deltaSeconds;
    const bounds = app.screen;

    for (const spark of sparks) {
      spark.t += spark.speed * deltaSeconds * ambientSpeedScale;
      if (spark.t >= 1) {
        spark.t -= 1;
      }

      const { x, y, angle } = riverAt(spark.t, bounds);
      const offset = lateral(spark.offsetAt(spark.t));
      spark.particle.x = x + Math.sin(angle) * offset;
      spark.particle.y = y - Math.cos(angle) * offset;

      // 頭尾淡出，加上各自不同步的閃爍
      const fade = Math.min(1, spark.t / 0.08, (1 - spark.t) / 0.12);
      const twinkle = 0.65 + 0.35 * Math.sin(elapsed * 2.4 + spark.phase);
      spark.particle.alpha = spark.baseAlpha * fade * twinkle;
    }
  };

  app.ticker.add(update);

  container.on("destroyed", () => {
    app.ticker.remove(update);
    texture.destroy(true);
  });

  return container;
}


/**
 * 簽名順流而下。
 *
 * 與海洋的自由漫遊不同：這裡每個人都在同一條河上，往同一個方向流。
 * 那正是「匯聚同行・流向未來」要傳達的事——
 * 各自從不同的地方進來，最後走在同一條河道上。
 *
 * 一樣不做水平鏡像：簽名是文字，翻過來就不能看了。
 */
/**
 * 河道的最後一段延伸到畫面外（x 到 -0.24），那一段只是為了讓光流
 * 有地方流出去。簽名走到那裡會被渲染核心的安全夾制拉回畫面邊緣，
 * 全部疊在左下角變成一坨。所以簽名提早在這裡收掉。
 */
const FLOW_END = 0.9;

/** 進出畫面的淡入淡出長度（以 t 計） */
const FADE_IN = 0.05;
const FADE_OUT = 0.12;

const flowBehavior: CharacterBehavior = {
  key: "river-flow",

  init(state: CharacterMotionState, ctx: WorldFrameContext) {
    // vx 借用來存「在河道上的位置 t」，vy 存離中心線的偏移量。
    // 這一層的介面是為了自由漫遊設計的，河流world 需要的是沿曲線前進，
    // 借用既有欄位可以完全不動渲染核心。
    state.vx = Math.random() * FLOW_END;
    state.vy = gsap.utils.random(-190, 190);
    state.phase = Math.random() * Math.PI * 2;
    state.tilt = gsap.utils.random(-0.05, 0.05);

    const here = riverAt(state.vx, ctx.bounds);
    const offset = lateral(state.vy);
    state.x = here.x + Math.sin(here.angle) * offset;
    state.y = here.y - Math.cos(here.angle) * offset;
  },

  update(state: CharacterMotionState, ctx: WorldFrameContext) {
    // 每個人的流速略有不同，但沿途固定。
    //
    // 原本讓下游流得比較快，想做出「加速衝出去」的感覺，結果是反效果：
    // 密度與速度成反比，上游因此愈積愈多，畫面上擠成一團的是上游，
    // 而不是要匯聚的下游。收窄的工作交給側向偏移，速度保持均勻。
    //
    // phase 在 init 之後就不再變動，拿它當每個人的固定速度種子，
    // 不必為此在運動狀態上多開一個欄位（那是渲染核心的介面）。
    const speed = 0.019 + (state.phase / (Math.PI * 2)) * 0.007;
    state.vx += speed * ctx.deltaSeconds * ctx.speedScale;

    if (state.vx >= FLOW_END) {
      // 流出畫面就從上游重新進來，河是連續的
      state.vx -= FLOW_END;
      state.vy = gsap.utils.random(-190, 190);
    }

    // 往下游收窄：離中心線的距離隨著 t 縮小。
    // 這一條就是「匯聚」——散在上游的名字，到下游併成同一束。
    const narrowing = 1 - state.vx * 0.55;
    const offset = lateral(state.vy * narrowing);

    const here = riverAt(state.vx, ctx.bounds);
    state.x = here.x + Math.sin(here.angle) * offset;
    state.y = here.y - Math.cos(here.angle) * offset;

    // 隨波的輕微起伏，不改變左右方向
    const bob = Math.sin(ctx.elapsedSeconds * 0.9 + state.phase) * 4;
    state.y += bob;
    state.rotation = state.tilt + Math.sin(ctx.elapsedSeconds * 0.7 + state.phase) * 0.03;

    // 頭尾淡出。名字直接憑空出現或憑空消失很突兀，
    // 淡進淡出之後看起來就是「順流而來、順流而去」。
    const fadeIn = Math.min(1, state.vx / FADE_IN);
    const fadeOut = Math.min(1, (FLOW_END - state.vx) / FADE_OUT);
    state.alpha = ctx.band.alpha * Math.max(0, Math.min(fadeIn, fadeOut));
  },
};

/** 從上游漂進來 */
function entrance(sprite: Sprite, bounds: Rect): Timeline {
  const start = riverAt(0, bounds);
  const target = { x: sprite.x, y: sprite.y };

  sprite.position.set(start.x + 80, start.y - 60);
  sprite.alpha = 0;
  sprite.scale.set(sprite.scale.x * 0.7);

  const timeline = gsap.timeline();
  timeline
    .to(sprite, { alpha: 1, duration: 0.6, ease: "power1.out" }, 0)
    .to(
      sprite.scale,
      { x: sprite.scale.x / 0.7, y: sprite.scale.y / 0.7, duration: 1.1, ease: "back.out(1.2)" },
      0,
    )
    .to(
      sprite.position,
      { x: target.x, y: target.y, duration: 1.6, ease: "power2.out" },
      0,
    );

  return timeline;
}

/** 抽獎聚集：全部收攏到河道的收窄處 */
function gatherAnimation(sprites: readonly Sprite[], center: Point): Timeline {
  const timeline = gsap.timeline();

  sprites.forEach((sprite, index) => {
    timeline.to(
      sprite.position,
      {
        x: center.x + gsap.utils.random(-140, 140),
        y: center.y + gsap.utils.random(-90, 90),
        duration: 1.5,
        ease: "power2.inOut",
      },
      index * 0.004,
    );
  });

  return timeline;
}

/**
 * 佈局帶。河流是往下游走的，因此「遠近」對應河道的上下游而不是畫面高度，
 * 這裡的 top/bottom 只影響 WorldRenderer 分配角色到哪一帶，
 * 實際位置由 flowBehavior 依河道計算。
 *
 * 縮放比海洋那一套大一截，因為這個世界裝的是簽名。
 * 角色是方的，簽名是又寬又扁的——同樣的最長邊限制之下，
 * 簽名的實際面積小得多，用海洋的比例投到牆上會看不清楚是誰的名字。
 */
const BANDS: readonly LayoutBand[] = [
  { key: "upstream", top: 0.0, bottom: 0.4, scale: 0.95, speed: 0, alpha: 0.78 },
  { key: "midstream", top: 0.4, bottom: 0.7, scale: 1.2, speed: 0, alpha: 0.9 },
  { key: "downstream", top: 0.7, bottom: 1.0, scale: 1.45, speed: 0, alpha: 1 },
];

export const riverTemplate: WorldTemplate = {
  key: "river",
  onSpeedScaleChange(scale: number) {
    ambientSpeedScale = scale;
  },
  name: "河流",
  palette: {
    bg: [NAVY_MID, NAVY_SOFT, NAVY_DEEP],
    accent: GOLD,
  },
  buildBackground,
  buildAmbient,
  characterBehavior: flowBehavior,
  entrance,
  bands: BANDS,
  gatherAnimation,
};
