import {
  Container,
  FillGradient,
  Graphics,
  Sprite,
  type Application,
} from "pixi.js";
import gsap from "gsap";
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
const GOLD = "#f2c063";
const GOLD_BRIGHT = "#ffe6b0";
/** 光流最亮的芯，主視覺上那幾道近乎白色的高光 */
const GOLD_CORE = "#fff6e2";
const GOLD_DEEP = "#c88b2c";

/**
 * 河道中心線。以畫面寬高的比例表示，繪製時再乘上實際尺寸。
 *
 * 走向取自主視覺：從右上進來，中段回甩成一個 S，再往左下流出去。
 *
 * 位置比主視覺整體左移了一些，因為大螢幕的 QR Code 與人數面板固定在
 * 右上角（畫面寬的 0.73 之後）。照著原圖擺，最亮、簽名最密的那一段
 * 會正好被面板蓋住——投影出來看不到的東西畫得再漂亮也沒有意義。
 */
const RIVER_PATH: readonly Point[] = [
  { x: 1.02, y: -0.04 },
  { x: 0.78, y: 0.09 },
  { x: 0.6, y: 0.24 },
  { x: 0.63, y: 0.42 },
  { x: 0.48, y: 0.58 },
  { x: 0.26, y: 0.74 },
  { x: -0.04, y: 0.9 },
  { x: -0.24, y: 1.0 },
];

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

/**
 * 把河道畫成一條線。
 *
 * offset 收的是函式而不是數字：主視覺裡的光流不是等距並行的，
 * 上游收在一束、往下游散成一大片細絲。那個「散開」正是靠
 * 偏移量隨 t 變大做出來的，固定偏移永遠只能畫出一條繩子。
 */
function traceRiver(
  g: Graphics,
  bounds: Rect,
  offsetAt: (t: number) => number,
  steps = 150,
): void {
  for (let s = 0; s <= steps; s += 1) {
    const t = s / steps;
    const { x, y, angle } = riverAt(t, bounds);
    const offset = offsetAt(t);
    // 法線方向偏移，才會平行於河道而不是單純上下平移
    const nx = Math.sin(angle) * offset;
    const ny = -Math.cos(angle) * offset;
    if (s === 0) {
      g.moveTo(x + nx, y + ny);
    } else {
      g.lineTo(x + nx, y + ny);
    }
  }
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

function buildBackground(app: Application): Container {
  const container = new Container();
  const { width, height } = app.screen;

  // 夜色水面：由上而下加深，右上角留一塊比較亮的水光
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
  // 光暈跟著河道最亮的那一段走，不是固定在角落
  glow
    .ellipse(width * 0.62, height * 0.26, width * 0.44, height * 0.4)
    .fill(glowGradient);
  glow.alpha = 0.55;
  container.addChild(glow);

  // 水面的細紋：一整片橫向短線，密度往下遞減
  const ripples = new Graphics();
  for (let i = 0; i < 160; i += 1) {
    const y = height * (0.08 + Math.random() * 0.9);
    const len = width * (0.04 + Math.random() * 0.22);
    const x = Math.random() * width;
    ripples
      .moveTo(x, y)
      .lineTo(x + len, y + (Math.random() - 0.5) * 6)
      .stroke({
        width: 1,
        color: "#2b4f86",
        alpha: 0.1 + Math.random() * 0.18,
      });
  }
  container.addChild(ripples);

  // 藍色的水緞帶：跟著河道走的寬大低對比色塊。
  // 主視覺裡金色光流的外圍是一層一層的藍，沒有這一層，
  // 金線會像是浮在一片死藍上，而不是水本身在流。
  const water = new Graphics();
  const waterBands: readonly { start: number; spread: number; width: number }[] =
    [
      { start: -320, spread: -240, width: 130 },
      { start: -210, spread: -170, width: 96 },
      { start: -120, spread: -110, width: 72 },
      { start: 110, spread: 150, width: 84 },
      { start: 200, spread: 240, width: 110 },
      { start: 310, spread: 330, width: 140 },
    ];
  for (const band of waterBands) {
    traceRiver(water, app.screen, fanning(band.start, band.spread, 1.5));
    water.stroke({
      width: band.width,
      color: WATER_RIBBON,
      alpha: 0.16,
      cap: "round",
      join: "round",
    });
  }
  water.alpha = 0.9;
  container.addChild(water);

  const streams = new Container();
  streams.blendMode = "add";
  container.addChild(streams);

  const tweens: gsap.core.Tween[] = [];

  /**
   * 同一條線疊三層：寬而淡的暈、中層、細而亮的芯。
   * 這是在不使用 filter 的前提下做出輝光最省效能的作法——
   * filter 在投影機那台機器上是最容易掉幀的東西。
   */
  const strand = (
    offsetAt: (t: number) => number,
    core: number,
    brightness: number,
  ): Graphics => {
    const g = new Graphics();

    traceRiver(g, app.screen, offsetAt);
    g.stroke({
      width: core * 9,
      color: GOLD_DEEP,
      alpha: 0.1 * brightness,
      cap: "round",
      join: "round",
    });

    traceRiver(g, app.screen, offsetAt);
    g.stroke({
      width: core * 3,
      color: GOLD,
      alpha: 0.42 * brightness,
      cap: "round",
      join: "round",
    });

    traceRiver(g, app.screen, offsetAt);
    g.stroke({
      width: core,
      color: brightness > 0.85 ? GOLD_CORE : GOLD_BRIGHT,
      alpha: Math.min(1, 0.8 * brightness),
      cap: "round",
      join: "round",
    });

    streams.addChild(g);
    tweens.push(
      gsap.to(g, {
        alpha: gsap.utils.random(0.6, 1),
        duration: gsap.utils.random(3.5, 7),
        repeat: -1,
        yoyo: true,
        ease: "sine.inOut",
        delay: gsap.utils.random(0, 3),
      }),
    );
    return g;
  };

  // 亮芯：主視覺中央那幾道近乎白色的高光，收在一束，幾乎不散開
  strand(fanning(-14, -22, 1.3), 2.8, 1);
  strand(parallel(0), 3.6, 1);
  strand(fanning(12, 26, 1.3), 2.4, 0.95);
  strand(fanning(-38, -58, 1.4), 1.8, 0.72);
  strand(fanning(42, 70, 1.4), 1.8, 0.7);

  // 散開的細絲：主視覺左下角那一大片髮絲狀的光。
  // 這是整張圖的個性所在——上游是一束，下游散成一片。
  //
  // 數量、粗細與亮度都刻意壓得比主視覺低。那張圖裡光流就是主角，
  // 這裡的主角是簽名：細絲畫得跟原圖一樣亮，下游那幾百個名字
  // 會直接消失在光裡，投出來只剩一片金色。
  const FILAMENTS = 22;
  for (let i = 0; i < FILAMENTS; i += 1) {
    const side = i % 2 === 0 ? 1 : -1;
    const rank = (i + 1) / FILAMENTS;
    strand(
      fanning(
        side * gsap.utils.random(18, 70),
        side * (90 + rank * 260) * gsap.utils.random(0.8, 1.2),
        gsap.utils.random(1.6, 2.6),
      ),
      gsap.utils.random(0.5, 1),
      gsap.utils.random(0.16, 0.34),
    );
  }

  container.on("destroyed", () => {
    for (const tween of tweens) {
      tween.kill();
    }
  });

  return container;
}

/** 順流而下的光點。這是「流動」最直接的證據。 */
function buildAmbient(app: Application): Container {
  const container = new Container();
  container.blendMode = "add";

  const spark = new Graphics();
  spark.circle(0, 0, 8).fill({ color: GOLD_BRIGHT });
  const texture = app.renderer.generateTexture(spark);
  spark.destroy();
  container.on("destroyed", () => texture.destroy(true));

  const tweens: gsap.core.Tween[] = [];
  const count = 46;

  for (let i = 0; i < count; i += 1) {
    const dot = new Sprite(texture);
    dot.anchor.set(0.5);
    const size = gsap.utils.random(2, 6);
    dot.width = size;
    dot.height = size;
    dot.alpha = gsap.utils.random(0.25, 0.9);
    container.addChild(dot);

    // 每個光點沿著河道跑，而且跟著細絲一起往下游散開，
    // 否則光點會走在一條窄帶上，跟背景的扇形對不起來
    const offsetAt = fanning(
      gsap.utils.random(-70, 70),
      gsap.utils.random(-320, 320),
      gsap.utils.random(1.4, 2.4),
    );
    const state = { t: gsap.utils.random(0, 1) };

    const place = () => {
      const { x, y, angle } = riverAt(state.t, app.screen);
      const offset = offsetAt(state.t);
      dot.position.set(
        x + Math.sin(angle) * offset,
        y - Math.cos(angle) * offset,
      );
    };
    place();

    tweens.push(
      gsap.to(state, {
        t: 1,
        duration: gsap.utils.random(7, 16),
        repeat: -1,
        ease: "none",
        delay: gsap.utils.random(0, 6),
        onUpdate: place,
        onRepeat: () => {
          state.t = 0;
        },
      }),
    );
  }

  container.on("destroyed", () => {
    for (const tween of tweens) {
      tween.kill();
    }
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
    state.x = here.x + Math.sin(here.angle) * state.vy;
    state.y = here.y - Math.cos(here.angle) * state.vy;
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
    const offset = state.vy * narrowing;

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
