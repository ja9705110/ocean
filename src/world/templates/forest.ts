import { Container, FillGradient, Graphics, Sprite } from "pixi.js";
import type { Application, Texture } from "pixi.js";
import { gsap } from "gsap";
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
 * 森林世界模板。
 *
 * 這個檔案是可插拔架構的驗證：新增一個世界不需要動 world/engine/
 * 底下任何一行程式碼，只需實作 WorldTemplate 並在 index.ts 註冊。
 *
 * 與海洋的差異在於「重力感」：角色是飄浮的光點與生物，
 * 移動較慢、上下起伏較明顯，環境物件由地面往上生長而非由下往上冒。
 */

const PALETTE = {
  bg: ["#1d4a3a", "#16382e", "#0d2620", "#04120f"],
  accent: "#9ee37d",
} as const;

const BANDS: readonly LayoutBand[] = [
  { key: "canopy", top: 0.08, bottom: 0.28, scale: 0.6, speed: 0.01, alpha: 0.6 },
  { key: "upper", top: 0.26, bottom: 0.48, scale: 0.76, speed: -0.015, alpha: 0.76 },
  { key: "lower", top: 0.46, bottom: 0.7, scale: 0.9, speed: 0.02, alpha: 0.9 },
  { key: "ground", top: 0.66, bottom: 0.9, scale: 1, speed: -0.025, alpha: 1 },
];

function bindCleanup(container: Container, tweens: gsap.core.Tween[]): void {
  container.on("destroyed", () => {
    for (const tween of tweens) {
      tween.kill();
    }
  });
}

function buildBackground(app: Application): Container {
  const container = new Container();
  const { width, height } = app.screen;

  const gradient = new FillGradient({
    type: "linear",
    start: { x: 0.5, y: 0 },
    end: { x: 0.5, y: 1 },
    colorStops: PALETTE.bg.map((color, index) => ({
      offset: index / (PALETTE.bg.length - 1),
      color,
    })),
    textureSpace: "local",
  });

  const sky = new Graphics();
  sky.rect(0, 0, width, height).fill(gradient);
  container.addChild(sky);

  // 樹冠透下來的光暈
  const glowGradient = new FillGradient({
    type: "radial",
    center: { x: 0.5, y: 0.5 },
    innerRadius: 0,
    outerCenter: { x: 0.5, y: 0.5 },
    outerRadius: 0.5,
    colorStops: [
      { offset: 0, color: "rgba(214,247,178,0.3)" },
      { offset: 0.6, color: "rgba(158,227,125,0.1)" },
      { offset: 1, color: "rgba(158,227,125,0)" },
    ],
    textureSpace: "local",
  });

  const glow = new Graphics();
  glow.ellipse(0, 0, width * 0.6, height * 0.28).fill(glowGradient);
  glow.position.set(width * 0.45, height * 0.05);
  container.addChild(glow);

  // 遠景樹幹剪影：深淺兩層做出景深
  const farTrunks = new Graphics();
  for (let i = 0; i < 7; i += 1) {
    const x = (width / 7) * i + width * 0.04;
    const w = width * gsap.utils.random(0.018, 0.032);
    farTrunks.rect(x, height * 0.1, w, height).fill({
      color: "#0b241d",
      alpha: 0.55,
    });
  }
  container.addChild(farTrunks);

  const nearTrunks = new Graphics();
  for (let i = 0; i < 4; i += 1) {
    const x = (width / 4) * i + width * 0.1;
    const w = width * gsap.utils.random(0.035, 0.06);
    nearTrunks.rect(x, 0, w, height).fill({ color: "#061a15", alpha: 0.8 });
  }
  container.addChild(nearTrunks);

  // 地面
  const ground = new Graphics();
  ground
    .ellipse(width * 0.5, height * 1.05, width * 0.75, height * 0.16)
    .fill({ color: "#04120f", alpha: 0.9 });
  container.addChild(ground);

  const tweens = [
    gsap.to(glow, {
      alpha: 0.55,
      duration: 7,
      yoyo: true,
      repeat: -1,
      ease: "sine.inOut",
    }),
  ];
  glow.alpha = 0.95;
  bindCleanup(container, tweens);

  return container;
}

/** 烘一張柔邊光點，給螢火蟲與花粉共用 */
function bakeMoteTexture(app: Application): Texture {
  const g = new Graphics();
  const gradient = new FillGradient({
    type: "radial",
    center: { x: 0.5, y: 0.5 },
    innerRadius: 0,
    outerCenter: { x: 0.5, y: 0.5 },
    outerRadius: 0.5,
    colorStops: [
      { offset: 0, color: "rgba(226,255,193,0.95)" },
      { offset: 0.4, color: "rgba(158,227,125,0.5)" },
      { offset: 1, color: "rgba(158,227,125,0)" },
    ],
    textureSpace: "local",
  });
  g.circle(16, 16, 16).fill(gradient);
  const texture = app.renderer.generateTexture(g);
  g.destroy();
  return texture;
}

function buildAmbient(app: Application): Container {
  const container = new Container();
  const { width, height } = app.screen;
  const tweens: gsap.core.Tween[] = [];

  const moteTexture = bakeMoteTexture(app);
  container.on("destroyed", () => moteTexture.destroy(true));

  // 螢火蟲：閃爍並緩慢漂移
  for (let i = 0; i < 30; i += 1) {
    const mote = new Sprite(moteTexture);
    mote.anchor.set(0.5);
    const size = gsap.utils.random(5, 14);
    mote.width = size;
    mote.height = size;
    mote.position.set(
      gsap.utils.random(0, width),
      gsap.utils.random(height * 0.15, height * 0.95),
    );
    container.addChild(mote);

    mote.alpha = gsap.utils.random(0.1, 0.5);
    tweens.push(
      gsap.to(mote, {
        alpha: gsap.utils.random(0.5, 1),
        duration: gsap.utils.random(1.4, 3.4),
        yoyo: true,
        repeat: -1,
        ease: "sine.inOut",
        delay: gsap.utils.random(0, 3),
      }),
    );
    tweens.push(
      gsap.to(mote.position, {
        x: `+=${gsap.utils.random(-70, 70)}`,
        y: `+=${gsap.utils.random(-45, 45)}`,
        duration: gsap.utils.random(6, 13),
        yoyo: true,
        repeat: -1,
        ease: "sine.inOut",
      }),
    );
  }

  // 蕨葉：由地面往上生長，隨風擺動
  for (let i = 0; i < 7; i += 1) {
    const frond = new Graphics();
    const frondHeight = gsap.utils.random(height * 0.14, height * 0.3);

    frond
      .moveTo(0, 0)
      .bezierCurveTo(
        -frondHeight * 0.16,
        -frondHeight * 0.4,
        frondHeight * 0.1,
        -frondHeight * 0.72,
        0,
        -frondHeight,
      )
      .bezierCurveTo(
        frondHeight * 0.2,
        -frondHeight * 0.62,
        frondHeight * 0.06,
        -frondHeight * 0.26,
        frondHeight * 0.09,
        0,
      )
      .closePath()
      .fill({ color: "#0e3a2c", alpha: 0.92 });

    frond.position.set(
      (width / (7 + 1)) * (i + 1) + gsap.utils.random(-50, 50),
      height + 6,
    );
    container.addChild(frond);

    frond.rotation = gsap.utils.random(-0.1, -0.02);
    tweens.push(
      gsap.to(frond, {
        rotation: gsap.utils.random(0.04, 0.12),
        duration: gsap.utils.random(3.5, 6.5),
        yoyo: true,
        repeat: -1,
        ease: "sine.inOut",
      }),
    );
  }

  bindCleanup(container, tweens);
  return container;
}

const VERTICAL_ROAM_EXPAND = 0.16;

/**
 * 森林的漂浮行為：比海洋更慢、上下起伏更明顯，像在無風的林間浮遊。
 * 與海洋共用同樣的三項約束：不鏡像、不出框、每幀零配置。
 */
const driftBehavior: CharacterBehavior = {
  key: "forest-drift",

  init(state: CharacterMotionState, ctx: WorldFrameContext): void {
    const base = Math.abs(ctx.band.speed) * ctx.bounds.width;
    const speed = base * gsap.utils.random(0.35, 0.8);
    const angle = Math.random() * Math.PI * 2;

    state.vx = Math.cos(angle) * speed;
    state.vy = Math.sin(angle) * speed * 0.75;
    state.tilt = gsap.utils.random(-0.16, 0.16);
    state.alpha = ctx.band.alpha;
  },

  update(state: CharacterMotionState, ctx: WorldFrameContext): void {
    const turn =
      Math.sin(ctx.elapsedSeconds * 0.18 + state.phase) * 0.42 * ctx.deltaSeconds;
    const cos = Math.cos(turn);
    const sin = Math.sin(turn);
    const vx = state.vx * cos - state.vy * sin;
    const vy = state.vx * sin + state.vy * cos;
    state.vx = vx;
    state.vy = vy;

    state.x += state.vx * ctx.deltaSeconds;
    state.y += state.vy * ctx.deltaSeconds;

    const margin = ctx.radius * 1.15;
    if (state.x < margin) {
      state.vx = Math.abs(state.vx);
    } else if (state.x > ctx.bounds.width - margin) {
      state.vx = -Math.abs(state.vx);
    }

    const height = ctx.bounds.height;
    const expand = height * VERTICAL_ROAM_EXPAND;
    const top = Math.max(margin, ctx.band.top * height - expand);
    const bottom = Math.min(height - margin, ctx.band.bottom * height + expand);

    if (state.y < top) {
      state.vy = Math.abs(state.vy);
    } else if (state.y > bottom) {
      state.vy = -Math.abs(state.vy);
    }

    // 上下起伏比海洋明顯，強化「飄浮」而非「游動」的感覺
    state.rotation =
      state.tilt + Math.sin(ctx.elapsedSeconds * 0.7 + state.phase) * 0.07;
    state.scale = 1 + Math.sin(ctx.elapsedSeconds * 0.6 + state.phase) * 0.04;
  },
};

function entrance(sprite: Sprite, bounds: Rect): Timeline {
  // 森林的角色從下方升起，像被光吸引著往上飄
  const targetX = sprite.position.x;
  const targetY = sprite.position.y;
  const targetAlpha = sprite.alpha;

  const timeline = gsap.timeline();
  timeline
    .fromTo(
      sprite,
      { alpha: 0 },
      { alpha: targetAlpha, duration: 1, ease: "power1.out" },
      0,
    )
    .fromTo(
      sprite.position,
      { x: targetX + gsap.utils.random(-60, 60), y: bounds.height + 90 },
      { x: targetX, y: targetY, duration: 2.6, ease: "power2.out" },
      0,
    );
  return timeline;
}

function gatherAnimation(sprites: readonly Sprite[], center: Point): Timeline {
  const timeline = gsap.timeline();
  sprites.forEach((sprite, index) => {
    const angle = (index / Math.max(sprites.length, 1)) * Math.PI * 2;
    const radius = 150 + (index % 5) * 34;
    timeline.to(
      sprite.position,
      {
        x: center.x + Math.cos(angle) * radius,
        y: center.y + Math.sin(angle) * radius,
        duration: 1.8,
        ease: "power2.inOut",
      },
      index * 0.004,
    );
  });
  return timeline;
}

export const forestTemplate: WorldTemplate = {
  key: "forest",
  name: "森林",
  palette: { bg: [...PALETTE.bg], accent: PALETTE.accent },
  buildBackground,
  buildAmbient,
  characterBehavior: driftBehavior,
  entrance,
  bands: BANDS,
  gatherAnimation,
};
