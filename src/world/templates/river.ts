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

const NAVY_DEEP = "#03060f";
const NAVY_MID = "#071227";
const NAVY_SOFT = "#0d2144";
const GOLD = "#f2c063";
const GOLD_BRIGHT = "#ffe6b0";
const GOLD_DEEP = "#c88b2c";

/**
 * 河道中心線。以畫面寬高的比例表示，繪製時再乘上實際尺寸。
 *
 * 走向刻意與主視覺一致：從右上進來，往左下蜿蜒而去，
 * 中段收窄成一束——那個收窄處就是「匯聚」的視覺焦點。
 */
const RIVER_PATH: readonly Point[] = [
  { x: 1.08, y: 0.06 },
  { x: 0.82, y: 0.2 },
  { x: 0.66, y: 0.4 },
  { x: 0.72, y: 0.58 },
  { x: 0.58, y: 0.72 },
  { x: 0.3, y: 0.82 },
  { x: -0.08, y: 0.95 },
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

/** 把河道畫成一條線，offset 用來做出多股並行的支流 */
function traceRiver(
  g: Graphics,
  bounds: Rect,
  offset: number,
  steps = 140,
): void {
  for (let s = 0; s <= steps; s += 1) {
    const t = s / steps;
    const { x, y, angle } = riverAt(t, bounds);
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
  glow
    .ellipse(width * 0.78, height * 0.18, width * 0.42, height * 0.36)
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

  // 金色光流：多股並行的支流，中段收窄成一束
  const streams = new Container();
  streams.blendMode = "add";
  container.addChild(streams);

  const offsets = [-150, -108, -72, -42, -18, 6, 30, 62, 100, 142];
  const tweens: gsap.core.Tween[] = [];

  for (const offset of offsets) {
    const strand = new Graphics();
    const wide = Math.abs(offset) > 70;

    // 同一條線疊三層：寬而淡的暈、中層、細而亮的芯。
    // 這是在不使用 filter 的前提下做出輝光最省效能的作法——
    // filter 在投影機那台機器上是最容易掉幀的東西。
    traceRiver(strand, app.screen, offset);
    strand.stroke({
      width: wide ? 16 : 30,
      color: GOLD_DEEP,
      alpha: 0.14,
      cap: "round",
      join: "round",
    });

    traceRiver(strand, app.screen, offset);
    strand.stroke({
      width: wide ? 4 : 9,
      color: GOLD,
      alpha: wide ? 0.28 : 0.5,
      cap: "round",
      join: "round",
    });

    traceRiver(strand, app.screen, offset);
    strand.stroke({
      width: wide ? 1.2 : 2.4,
      color: GOLD_BRIGHT,
      alpha: wide ? 0.35 : 0.75,
      cap: "round",
      join: "round",
    });

    streams.addChild(strand);

    // 整股輕微地呼吸，讓光流看起來是活的
    tweens.push(
      gsap.to(strand, {
        alpha: gsap.utils.random(0.55, 1),
        duration: gsap.utils.random(3.5, 7),
        repeat: -1,
        yoyo: true,
        ease: "sine.inOut",
        delay: gsap.utils.random(0, 3),
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

    // 每個光點沿著河道跑，offset 決定它在哪一股
    const offset = gsap.utils.random(-140, 140);
    const state = { t: gsap.utils.random(0, 1) };

    const place = () => {
      const { x, y, angle } = riverAt(state.t, app.screen);
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
const flowBehavior: CharacterBehavior = {
  key: "river-flow",

  init(state: CharacterMotionState, ctx: WorldFrameContext) {
    // vx 借用來存「在河道上的位置 t」，vy 存離中心線的偏移量。
    // 這一層的介面是為了自由漫遊設計的，河流world 需要的是沿曲線前進，
    // 借用既有欄位可以完全不動渲染核心。
    state.vx = Math.random();
    state.vy = gsap.utils.random(-165, 165);
    state.phase = Math.random() * Math.PI * 2;
    state.tilt = gsap.utils.random(-0.05, 0.05);

    const here = riverAt(state.vx, ctx.bounds);
    state.x = here.x + Math.sin(here.angle) * state.vy;
    state.y = here.y - Math.cos(here.angle) * state.vy;
  },

  update(state: CharacterMotionState, ctx: WorldFrameContext) {
    // 越靠近下游流得越快，做出「匯聚後加速」的感覺
    const speed = 0.018 + state.vx * 0.012;
    state.vx += speed * ctx.deltaSeconds;

    if (state.vx >= 1) {
      // 流出畫面就從上游重新進來，河是連續的
      state.vx -= 1;
      state.vy = gsap.utils.random(-165, 165);
    }

    // 中段收窄：離中心線的距離隨著往下游而縮小
    const narrowing = 1 - state.vx * 0.3;
    const offset = state.vy * narrowing;

    const here = riverAt(state.vx, ctx.bounds);
    state.x = here.x + Math.sin(here.angle) * offset;
    state.y = here.y - Math.cos(here.angle) * offset;

    // 隨波的輕微起伏，不改變左右方向
    const bob = Math.sin(ctx.elapsedSeconds * 0.9 + state.phase) * 4;
    state.y += bob;
    state.rotation = state.tilt + Math.sin(ctx.elapsedSeconds * 0.7 + state.phase) * 0.03;
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
 */
const BANDS: readonly LayoutBand[] = [
  { key: "upstream", top: 0.0, bottom: 0.4, scale: 0.72, speed: 0, alpha: 0.78 },
  { key: "midstream", top: 0.4, bottom: 0.7, scale: 0.9, speed: 0, alpha: 0.9 },
  { key: "downstream", top: 0.7, bottom: 1.0, scale: 1.08, speed: 0, alpha: 1 },
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
