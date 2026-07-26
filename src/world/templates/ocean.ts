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
 * 海洋世界模板。
 *
 * 效能原則（規格第 16 節第 6 點）：
 * - 不使用任何 filter，光暈與泡泡都是預先烘好的貼圖
 * - 環境動畫由 GSAP 自驅，容器銷毀時透過 destroyed 事件統一清理
 */

const PALETTE = {
  bg: ["#0a4a66", "#083a55", "#052a42", "#02131f"],
  accent: "#4fd6c0",
} as const;

/** 佈局帶：由遠（上、小、慢、淡）至近（下、大、快、實） */
const BANDS: readonly LayoutBand[] = [
  { key: "far", top: 0.1, bottom: 0.3, scale: 0.62, speed: 0.012, alpha: 0.62 },
  { key: "mid-far", top: 0.28, bottom: 0.5, scale: 0.78, speed: -0.018, alpha: 0.78 },
  { key: "mid-near", top: 0.48, bottom: 0.72, scale: 0.9, speed: 0.024, alpha: 0.9 },
  { key: "near", top: 0.68, bottom: 0.92, scale: 1, speed: -0.03, alpha: 1 },
];

/** 綁在容器上的 gsap 動畫，容器銷毀時一併殺掉，整晚運行不洩漏 */
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

  // 垂直漸層：海面透光 → 深海
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

  const sea = new Graphics();
  sea.rect(0, 0, width, height).fill(gradient);
  container.addChild(sea);

  // 海面光暈：一大片放射漸層，緩慢呼吸
  const glowGradient = new FillGradient({
    type: "radial",
    center: { x: 0.5, y: 0.5 },
    innerRadius: 0,
    outerCenter: { x: 0.5, y: 0.5 },
    outerRadius: 0.5,
    colorStops: [
      { offset: 0, color: "rgba(158,222,236,0.34)" },
      { offset: 0.55, color: "rgba(110,190,214,0.12)" },
      { offset: 1, color: "rgba(110,190,214,0)" },
    ],
    textureSpace: "local",
  });

  const glow = new Graphics();
  const glowW = width * 1.1;
  const glowH = height * 0.5;
  glow.ellipse(0, 0, glowW / 2, glowH / 2).fill(glowGradient);
  glow.position.set(width / 2, 0);
  container.addChild(glow);

  // 遠景海丘剪影
  const dunes = new Graphics();
  dunes
    .ellipse(width * 0.2, height * 1.04, width * 0.42, height * 0.14)
    .fill({ color: "#01111c", alpha: 0.75 });
  dunes
    .ellipse(width * 0.75, height * 1.06, width * 0.5, height * 0.17)
    .fill({ color: "#010d16", alpha: 0.85 });
  container.addChild(dunes);

  const tweens: gsap.core.Tween[] = [
    gsap.to(glow, {
      alpha: 0.55,
      duration: 6,
      yoyo: true,
      repeat: -1,
      ease: "sine.inOut",
    }),
  ];
  glow.alpha = 0.9;
  bindCleanup(container, tweens);

  return container;
}

/** 烘一張柔邊圓形貼圖，給泡泡共用 */
function bakeBubbleTexture(app: Application): Texture {
  const g = new Graphics();
  const gradient = new FillGradient({
    type: "radial",
    center: { x: 0.5, y: 0.5 },
    innerRadius: 0,
    outerCenter: { x: 0.5, y: 0.5 },
    outerRadius: 0.5,
    colorStops: [
      { offset: 0, color: "rgba(255,255,255,0.05)" },
      { offset: 0.75, color: "rgba(255,255,255,0.12)" },
      { offset: 0.92, color: "rgba(255,255,255,0.5)" },
      { offset: 1, color: "rgba(255,255,255,0)" },
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

  // --- 泡泡 ---
  const bubbleTexture = bakeBubbleTexture(app);
  container.on("destroyed", () => bubbleTexture.destroy(true));

  const bubbleCount = 22;
  for (let i = 0; i < bubbleCount; i += 1) {
    const bubble = new Sprite(bubbleTexture);
    bubble.anchor.set(0.5);
    const size = gsap.utils.random(5, 18);
    bubble.width = size;
    bubble.height = size;
    bubble.alpha = gsap.utils.random(0.15, 0.5);
    bubble.position.set(
      gsap.utils.random(0, width),
      gsap.utils.random(height * 0.3, height + 30),
    );
    container.addChild(bubble);

    // 上升：到頂後跳回下方隨機位置
    tweens.push(
      gsap.to(bubble, {
        y: -40,
        duration: gsap.utils.random(9, 20),
        delay: gsap.utils.random(0, 8),
        repeat: -1,
        ease: "none",
        onRepeat: () => {
          bubble.position.set(
            gsap.utils.random(0, app.screen.width),
            app.screen.height + 30,
          );
        },
      }),
    );
    // 左右輕晃
    tweens.push(
      gsap.to(bubble, {
        x: `+=${gsap.utils.random(-30, 30)}`,
        duration: gsap.utils.random(2.5, 5),
        yoyo: true,
        repeat: -1,
        ease: "sine.inOut",
      }),
    );
  }

  // --- 海草 ---
  const bladeCount = 6;
  for (let i = 0; i < bladeCount; i += 1) {
    const blade = new Graphics();
    const bladeHeight = gsap.utils.random(height * 0.12, height * 0.24);
    const bladeWidth = bladeHeight * gsap.utils.random(0.1, 0.16);

    // 一片彎葉：兩段貝茲曲線圍成
    blade
      .moveTo(0, 0)
      .bezierCurveTo(
        -bladeWidth,
        -bladeHeight * 0.4,
        bladeWidth * 0.6,
        -bladeHeight * 0.7,
        0,
        -bladeHeight,
      )
      .bezierCurveTo(
        bladeWidth * 1.1,
        -bladeHeight * 0.6,
        bladeWidth * 0.3,
        -bladeHeight * 0.25,
        bladeWidth * 0.5,
        0,
      )
      .closePath()
      .fill({ color: "#06323f", alpha: 0.9 });

    blade.position.set(
      (width / (bladeCount + 1)) * (i + 1) + gsap.utils.random(-40, 40),
      height + 4,
    );
    container.addChild(blade);

    tweens.push(
      gsap.to(blade, {
        rotation: gsap.utils.random(0.05, 0.1),
        duration: gsap.utils.random(3, 5.5),
        yoyo: true,
        repeat: -1,
        ease: "sine.inOut",
      }),
    );
    blade.rotation = gsap.utils.random(-0.08, -0.03);
  }

  // --- 光束 ---
  for (let i = 0; i < 3; i += 1) {
    const shaft = new Graphics();
    const shaftWidth = width * gsap.utils.random(0.08, 0.14);
    shaft
      .poly([
        { x: -shaftWidth / 2, y: 0 },
        { x: shaftWidth / 2, y: 0 },
        { x: shaftWidth * 1.6, y: height * 0.85 },
        { x: shaftWidth * 0.4, y: height * 0.85 },
      ])
      .fill({ color: "#bfeef2", alpha: 1 });
    shaft.alpha = gsap.utils.random(0.03, 0.06);
    shaft.position.set(width * (0.18 + i * 0.3), -10);
    shaft.rotation = gsap.utils.random(-0.05, 0.05);
    container.addChild(shaft);

    tweens.push(
      gsap.to(shaft, {
        alpha: gsap.utils.random(0.07, 0.1),
        duration: gsap.utils.random(5, 9),
        yoyo: true,
        repeat: -1,
        ease: "sine.inOut",
      }),
    );
  }

  bindCleanup(container, tweens);
  return container;
}

/** 游動行為：帶內水平漂流＋垂直微盪＋呼吸縮放，全程零配置零 filter */
const swimBehavior: CharacterBehavior = {
  key: "ocean-swim",

  init(state: CharacterMotionState, ctx: WorldFrameContext): void {
    // 帶速度乘上個體擾動，同帶的角色速度略有差異才不像輸送帶
    state.vx =
      ctx.band.speed * ctx.bounds.width * gsap.utils.random(0.75, 1.3);
    state.vy = 0;
    state.alpha = ctx.band.alpha;
  },

  update(state: CharacterMotionState, ctx: WorldFrameContext): void {
    state.x += state.vx * ctx.deltaSeconds;

    // 垂直微盪：緩慢正弦漂移，並夾回帶內
    const bandTop = ctx.band.top * ctx.bounds.height;
    const bandBottom = ctx.band.bottom * ctx.bounds.height;
    state.y +=
      Math.sin(ctx.elapsedSeconds * 0.55 + state.phase) *
      6 *
      ctx.deltaSeconds;
    state.y = Math.min(bandBottom, Math.max(bandTop, state.y));

    // 輕微擺尾與呼吸
    state.rotation =
      Math.sin(ctx.elapsedSeconds * 1.1 + state.phase) *
      0.055 *
      (state.vx < 0 ? -1 : 1);
    state.scale = 1 + Math.sin(ctx.elapsedSeconds * 0.8 + state.phase) * 0.03;
  },
};

function entrance(sprite: Sprite, bounds: Rect): Timeline {
  // 引擎已把 sprite 放在目標位置，這裡從畫面外游進來
  const targetX = sprite.position.x;
  const targetY = sprite.position.y;
  const targetAlpha = sprite.alpha;
  const fromLeft = targetX < bounds.width / 2;
  const startX = fromLeft ? -90 : bounds.width + 90;

  const timeline = gsap.timeline();
  timeline
    .fromTo(
      sprite,
      { alpha: 0 },
      { alpha: targetAlpha, duration: 0.8, ease: "power1.out" },
      0,
    )
    .fromTo(
      sprite.position,
      { x: startX, y: targetY + 36 },
      { x: targetX, y: targetY, duration: 2.4, ease: "power2.out" },
      0,
    );
  return timeline;
}

function gatherAnimation(sprites: readonly Sprite[], center: Point): Timeline {
  // M7 會擴充為完整的抽獎演出；先提供基本聚集
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

export const oceanTemplate: WorldTemplate = {
  key: "ocean",
  name: "海洋",
  palette: { bg: [...PALETTE.bg], accent: PALETTE.accent },
  buildBackground,
  buildAmbient,
  characterBehavior: swimBehavior,
  entrance,
  bands: BANDS,
  gatherAnimation,
};
