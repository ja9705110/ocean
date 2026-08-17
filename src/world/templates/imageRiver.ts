import { Container, type Application, type Sprite } from "pixi.js";
import gsap from "gsap";
import {
  flowAt,
  inExcludedZone,
  maskAt,
  randomSeedPoint,
  type RiverFlow,
} from "@/lib/stage/riverFlowSource";
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
 * 主視覺河道世界（C5）。
 *
 * 用在「主持人上傳了自己的主視覺當底圖」的情況：底圖是那張 PNG，
 * 河道的光流由 RiverFlowOverlay 畫在上面，而這個模板負責讓簽名
 * 沿著同一條河走。
 *
 * 關鍵是「同一條」：遮罩與流場只在 riverFlowSource 算一次，
 * 光流與簽名共用。各算一份的話，只要有一邊的參數被改了，
 * 簽名就會沿著跟光流不同的路徑走——那是最難察覺的那種錯。
 *
 * 這個模板不畫背景也不畫環境裝飾：底圖是使用者的圖，
 * 光效是上面那一層的事，這裡只管角色怎麼動。
 */

/**
 * 目前的河道資料。
 *
 * 模板是一份不可變的描述，拿不到 React 的狀態；由 StageView 在
 * 建立世界之前設定進來。沒有設定時 behavior 會退化成原地輕輕漂浮，
 * 不會爆掉——底圖還沒載完的那一瞬間就是這個狀態。
 */
let current: RiverFlow | null = null;

export function setImageRiverFlow(flow: RiverFlow | null): void {
  current = flow;
}

/** 環境動畫的速度倍率，由渲染器通知 */
let speedScale = 1;

/**
 * 簽名在河道上前進的速度（每秒畫面寬度的比例）。
 *
 * 用比例而不是像素：投影機從 1280 到 4K 都有，
 * 用像素的話在大螢幕上會慢得像靜止。
 */
const BASE_SPEED = 0.035;

/** 低於這個遮罩值就算離開河道，該重生了 */
const LEAVE_THRESHOLD = 0.03;

/** 進出畫面的淡入淡出時間（秒） */
const FADE_IN = 1.2;
const FADE_OUT = 1.6;

/**
 * 一個簽名在河上待多久就重新回到上游（秒）。
 *
 * 有壽命而不是只靠「離開遮罩才重生」：河道有幾處幾乎筆直，
 * 光靠邊界判斷的話會有簽名卡在同一段來回很久。
 */
const LIFE_MIN = 26;
const LIFE_MAX = 46;

/**
 * 借用運動狀態的欄位：
 * - vx 存目前壽命（秒）
 * - vy 存這一輪的總壽命
 * - scale 存個體的速度微擾
 *
 * 這一層的介面是為了自由漫遊設計的，借用既有欄位可以完全不動渲染核心。
 */
function reset(state: CharacterMotionState, ctx: WorldFrameContext): void {
  const flow = current;
  if (flow) {
    // 出生地要避開排除區。理論上種子本來就不會落在那裡，
    // 但邊緣的柔化會讓幾格越界，多這一道比較保險。
    let point = randomSeedPoint(flow, ctx.bounds.width, ctx.bounds.height);
    for (let tries = 0; tries < 8; tries += 1) {
      if (!inExcludedZone(point.x, point.y, ctx.bounds.width, ctx.bounds.height)) {
        break;
      }
      point = randomSeedPoint(flow, ctx.bounds.width, ctx.bounds.height);
    }
    state.x = point.x;
    state.y = point.y;
  } else {
    state.x = ctx.bounds.width * 0.7;
    state.y = ctx.bounds.height * (0.2 + Math.random() * 0.6);
  }

  state.vx = 0;
  state.vy = gsap.utils.random(LIFE_MIN, LIFE_MAX);
  state.phase = Math.random() * Math.PI * 2;
  state.tilt = gsap.utils.random(-0.04, 0.04);
  state.alpha = 0;
}

const imageFlowBehavior: CharacterBehavior = {
  key: "image-river-flow",

  init(state: CharacterMotionState, ctx: WorldFrameContext) {
    reset(state, ctx);
    // 一開始就散在河道各處，而不是全部從同一點出發
    state.vx = Math.random() * state.vy;
    state.scale = 1;
  },

  update(state: CharacterMotionState, ctx: WorldFrameContext) {
    const flow = current;
    const { width, height } = ctx.bounds;

    state.vx += ctx.deltaSeconds;

    if (flow) {
      const direction = flowAt(flow, state.x, state.y, width, height);
      // 個體差異：同樣的流場上每個人快慢略有不同，才不會像輸送帶
      const personal = 0.75 + (state.phase / (Math.PI * 2)) * 0.5;
      const step = BASE_SPEED * width * personal * ctx.deltaSeconds * ctx.speedScale;

      state.x += direction.x * step;
      state.y += direction.y * step;

      const inside = maskAt(flow, state.x, state.y, width, height);
      const trespassing = inExcludedZone(state.x, state.y, width, height);
      if (inside < LEAVE_THRESHOLD || trespassing || state.vx >= state.vy) {
        reset(state, ctx);
        return;
      }
    } else {
      // 還沒拿到河道資料：原地輕輕漂，不要突然衝出畫面
      state.x += Math.sin(ctx.elapsedSeconds * 0.3 + state.phase) * 6 * ctx.deltaSeconds;
      if (state.vx >= state.vy) {
        reset(state, ctx);
        return;
      }
    }

    // 隨波的輕微起伏，不改變左右方向（簽名是文字，翻過來就不能看了）
    state.y += Math.sin(ctx.elapsedSeconds * 0.8 + state.phase) * 3 * ctx.deltaSeconds;
    state.rotation =
      state.tilt + Math.sin(ctx.elapsedSeconds * 0.6 + state.phase) * 0.025;

    // 頭尾淡出。名字憑空出現或消失很突兀，淡進淡出之後
    // 看起來就是順流而來、順流而去。
    const fadeIn = Math.min(1, state.vx / FADE_IN);
    const fadeOut = Math.min(1, (state.vy - state.vx) / FADE_OUT);
    state.alpha = ctx.band.alpha * Math.max(0, Math.min(fadeIn, fadeOut));
  },
};

/** 這個世界的背景與環境裝飾都是空的：底圖與光效是別人的事 */
function buildEmpty(_app: Application): Container {
  return new Container();
}

/**
 * 進場：直接在河道上淡入。
 *
 * 不做「從畫面外游進來」的演出——那需要知道河道的入口在哪，
 * 而河道是使用者的圖決定的，每一張都不一樣。
 */
function entrance(sprite: Sprite): Timeline {
  const targetScale = sprite.scale.x;
  sprite.alpha = 0;
  sprite.scale.set(targetScale * 0.72);

  const timeline = gsap.timeline();
  timeline
    .to(sprite, { alpha: 1, duration: 0.9, ease: "power1.out" }, 0)
    .to(
      sprite.scale,
      { x: targetScale, y: targetScale, duration: 1.1, ease: "back.out(1.4)" },
      0,
    );
  return timeline;
}

/** 抽獎聚集：全部收攏到畫面中央偏右，也就是河道最亮的那一帶 */
function gatherAnimation(sprites: readonly Sprite[], center: Point): Timeline {
  const timeline = gsap.timeline();

  sprites.forEach((sprite, index) => {
    const angle = (index / Math.max(1, sprites.length)) * Math.PI * 2;
    const radius = 90 + Math.random() * 150;

    timeline.to(
      sprite,
      {
        x: center.x + Math.cos(angle) * radius,
        y: center.y + Math.sin(angle) * radius * 0.55,
        alpha: 0.35,
        duration: 1.5,
        ease: "power2.inOut",
      },
      index * 0.004,
    );
  });

  return timeline;
}

/**
 * 佈局帶。縮放比海洋那一套大，因為這個世界裝的是簽名：
 * 簽名又寬又扁，同樣的最長邊限制之下實際面積小得多。
 */
const BANDS: readonly LayoutBand[] = [
  { key: "upstream", top: 0.0, bottom: 0.4, scale: 0.95, speed: 0, alpha: 0.85 },
  { key: "midstream", top: 0.4, bottom: 0.7, scale: 1.15, speed: 0, alpha: 0.95 },
  { key: "downstream", top: 0.7, bottom: 1.0, scale: 1.35, speed: 0, alpha: 1 },
];

export const imageRiverTemplate: WorldTemplate = {
  key: "image-river",
  name: "主視覺河道",
  palette: {
    // 底圖是使用者的圖，這裡的配色只被抽獎的光暈之類的地方用到
    bg: ["#02040c", "#061024", "#02040c"],
    accent: "#f2c063",
  },
  buildBackground: buildEmpty,
  buildAmbient: buildEmpty,
  characterBehavior: imageFlowBehavior,
  entrance: (sprite: Sprite, _bounds: Rect) => entrance(sprite),
  bands: BANDS,
  gatherAnimation,
  onSpeedScaleChange(scale: number) {
    speedScale = scale;
  },
};

/** 讓 lint 知道這個值是刻意保留的：之後環境層若要跟著變速會用到 */
export function currentSpeedScale(): number {
  return speedScale;
}
