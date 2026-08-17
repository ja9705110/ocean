import {
  BlurFilter,
  Container,
  FillGradient,
  Graphics,
  Particle,
  ParticleContainer,
  Rectangle,
  Sprite,
  type Application,
} from "pixi.js";
import gsap from "gsap";
import {
  DEFAULT_RIVER_LOOK,
  DEFAULT_RIVER_SHAPE,
  buildRiverGeometry,
  type RiverGeometry,
  type RiverLook,
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
let geometry: RiverGeometry = buildRiverGeometry(DEFAULT_RIVER_SHAPE);
let RIVER_PATH: readonly Point[] = geometry.points;

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
  geometry = buildRiverGeometry(next);
  RIVER_PATH = geometry.points;
}

export function getRiverShape(): RiverShape {
  return shape;
}

let look: RiverLook = DEFAULT_RIVER_LOOK;

/**
 * 套用外觀（亮度與光粒）。
 *
 * 跟 setRiverShape 一樣要重建環境層才會生效：輝光是烘成貼圖的，
 * 光粒是建立時就配好的。
 */
export function setRiverLook(next: RiverLook): void {
  look = next;
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

/**
 * 河道在某一點的彎曲程度（1 / 曲率半徑，帶正負號）。
 *
 * 拿來擋「光帶在急彎的內側翻過去」。沿著曲線往側邊平移 d 之後，
 * 前進方向的縮放是 (1 + d·k)；一旦這個值變成負的，那一段就往回折，
 * 圍出來的多邊形自己穿過自己，填色時彎道內側會冒出一塊亮楔形。
 * 那正是加上轉彎之後最容易出現的破綻。
 */
function curvatureAt(t: number, bounds: Rect): number {
  const step = 0.004;
  const before = riverAt(Math.max(0, t - step), bounds);
  const after = riverAt(Math.min(1, t + step), bounds);

  let delta = after.angle - before.angle;
  // 角度會在 ±π 繞回去，不處理的話那一格的曲率會變成天文數字
  while (delta > Math.PI) {
    delta -= Math.PI * 2;
  }
  while (delta < -Math.PI) {
    delta += Math.PI * 2;
  }

  const arc = Math.hypot(after.x - before.x, after.y - before.y);
  return arc > 0.0001 ? delta / arc : 0;
}

/**
 * 河道最寬的那一根光絲離中心線多遠（像素，寬度倍率 1 時）。
 *
 * 這個數字要跟轉彎的半徑是同一個量級。散得比轉彎半徑還遠的光絲，
 * 在彎道內側一定會翻折——不管怎麼補救，補出來的都是一塊
 * 「所有光絲擠在同一條線上」的亮斑，比翻折本身更顯眼。
 */
const MAX_LATERAL = 340;

/**
 * 急彎處整條河一起收窄的倍率。
 *
 * 關鍵是「一起」：每一根各自被夾住的話，超標的那些會全部落到同一個
 * 位置疊成亮斑。整條等比例收窄則保持了光絲之間的間距，
 * 看起來就是河流過彎道時本來就會變窄。
 *
 * 下限 0.45 是不讓它縮成一根線——真的轉得太急時，寧可留一點翻折，
 * 也不要一條河突然斷成兩截。
 */
function fitScale(t: number, bounds: Rect): number {
  const k = Math.abs(curvatureAt(t, bounds));
  if (k < 1e-6) {
    return 1;
  }
  const limit = 0.82 / k;
  return Math.min(1, Math.max(0.6, limit / (MAX_LATERAL * shape.width)));
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
    const fit = fitScale(t, bounds);
    const offset = lateral(offsetAt(t)) * fit;
    const half = lateral(widthAt(t)) * fit;

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
 * 從遠流到近：上游細、下游粗，而且下游不收尖。
 *
 * 原本頭尾都收成一個點，那是「一條躺在畫面裡的緞帶」，
 * 不是「從遠處流過來」。真正在靠近的東西是愈來愈粗、
 * 一路粗到出畫面為止——收尖的動作留給遠處那一端就好。
 *
 * far 是最上游的粗細比例。不設 0 是因為河從畫面外流進來，
 * 進畫面的那一刻就該已經有寬度了。
 */
function perspective(peak: number, far = 0.16, curve = 1.35): (t: number) => number {
  return (t) => {
    const grown = far + (1 - far) * Math.pow(Math.min(1, Math.max(0, t)), curve);
    // 最上游那一小段收尖，讓它在畫面外就消失，不會在邊緣切出一條硬邊
    const fadeIn = Math.min(1, t / 0.06);
    return peak * grown * fadeIn;
  };
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

  // frame 一定要明確給。
  //
  // 模糊的 padding 會把容器的邊界往外推（blur 46 時四邊各 92），
  // 不指定範圍的話烘出來的貼圖比畫面大一圈，貼回去時被 sprite.width
  // 壓成畫面寬——整層輝光因此縮成九成、還往上偏了一點。
  //
  // 那個偏移就是「光粒不在河道上」的原因：光粒是照著河道的座標算的，
  // 是準的，被縮掉的是背後那層光。兩邊對不齊，改設定時偏移量還會變，
  // 看起來就像各跑各的。
  const texture = app.renderer.generateTexture({
    target: holder,
    resolution,
    antialias: true,
    frame: new Rectangle(0, 0, width, height),
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

/**
 * 把一整個容器壓成一張貼圖，之後每幀只畫一個 Sprite。
 *
 * 這是 350 人同時在線時大螢幕撐不撐得住的關鍵。
 *
 * 背景裡有兩百多條絲綢紋理，每一條都是一個上百個頂點的填充多邊形。
 * 它們是靜止的，但 Pixi 每一幀都得把那幾萬個三角形重新光柵化一次——
 * 實測（軟體渲染）光是這一層就吃掉 726 毫秒，畫面只剩 1.4 fps，
 * 而那時候連一個簽名都還沒放上去。
 *
 * 背景只建立一次，所以在建立時就把它畫完、存成一張圖。
 * 之後每幀的成本是「畫一個全螢幕矩形」，跟裡面有幾條線無關。
 */
function bakeStatic(app: Application, source: Container): Sprite {
  const { width, height } = app.screen;
  const texture = app.renderer.generateTexture({
    target: source,
    resolution: 1,
    antialias: true,
    frame: new Rectangle(0, 0, width, height),
  });
  source.destroy({ children: true });

  const sprite = new Sprite(texture);
  sprite.width = width;
  sprite.height = height;
  sprite.on("destroyed", () => texture.destroy(true));
  return sprite;
}

/**
 * 把幾層輝光合成一張。
 *
 * 每一層都是全螢幕的疊加混色，在投影機那種內顯上，一層就是一次
 * 一百四十萬像素的混色。四層併成兩層，成本直接砍半，
 * 而畫面上看不出差別——反正它們本來就疊在一起。
 */
function mergeGlow(app: Application, layers: readonly Sprite[]): Sprite {
  const holder = new Container();
  for (const layer of layers) {
    holder.addChild(layer);
  }
  const merged = bakeStatic(app, holder);
  merged.blendMode = "add";
  return merged;
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
      widthAt: perspective(5.4),
      color: GOLD_BRIGHT,
      alpha: 0.9,
    },
    {
      offsetAt: parallel(6),
      widthAt: perspective(7.6),
      color: GOLD_BRIGHT,
      alpha: 1,
    },
    {
      offsetAt: parallel(6),
      widthAt: perspective(1.9, 0.3, 1.1),
      color: GOLD_CORE,
      alpha: 1,
    },
    {
      offsetAt: fanning(24, 40, 1.3),
      widthAt: perspective(4.3),
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
        side * gsap.utils.random(10, 44),
        side * (45 + rank * 120) * gsap.utils.random(0.85, 1.15),
        gsap.utils.random(1.3, 2),
      ),
      widthAt: perspective(gsap.utils.random(1.4, 3.8)),
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
        side * gsap.utils.random(6, 80),
        side * (55 + rank * 230) * gsap.utils.random(0.7, 1.3),
        gsap.utils.random(1.4, 2.8),
      ),
      widthAt: perspective(
        gsap.utils.random(0.4, 1.05),
        gsap.utils.random(0.08, 0.28),
        gsap.utils.random(1.1, 1.7),
      ),
      color: gsap.utils.random([GOLD, GOLD_DEEP, GOLD_BRIGHT]),
      alpha: gsap.utils.random(0.05, 0.16),
    });
  }

  return strands;
}

function buildBackground(app: Application): Container {
  const container = new Container();
  const { width, height } = app.screen;

  /*
   * 靜止的那些先畫進一個暫存容器，最後整個烘成一張圖。
   * 底色、水光暈、藍色水緞帶、絲綢紋理都不會動，
   * 每幀重畫兩百多個多邊形是純粹的浪費。
   */
  const still = new Container();

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
  still.addChild(base);

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
  still.addChild(glow);

  // 藍色的水緞帶：跟著河道走的寬大低對比色塊
  const water = new Graphics();
  const waterBands: readonly { start: number; spread: number; half: number }[] =
    [
      { start: -190, spread: -140, half: 68 },
      { start: -130, spread: -100, half: 50 },
      { start: -80, spread: -70, half: 38 },
      { start: 70, spread: 95, half: 44 },
      { start: 125, spread: 145, half: 58 },
      { start: 190, spread: 200, half: 74 },
    ];
  for (const band of waterBands) {
    ribbon(
      water,
      app.screen,
      fanning(band.start, band.spread, 1.5),
      perspective(band.half, 0.2),
    );
    water.fill({ color: WATER_RIBBON, alpha: 0.1 });
  }
  still.addChild(water);

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
        side * gsap.utils.random(20, 130),
        side * (75 + rank * 300) * gsap.utils.random(0.7, 1.3),
        gsap.utils.random(1.3, 2.6),
      ),
      perspective(gsap.utils.random(0.3, 0.8), gsap.utils.random(0.1, 0.3)),
      120,
    );
    silk.fill({
      color: gsap.utils.random([WATER_RIBBON, WATER_LINE]),
      alpha: gsap.utils.random(0.035, 0.1),
    });
  }
  still.addChild(silk);

  const strands = buildStrands();
  const paint = (g: Graphics) => {
    for (const strand of strands) {
      ribbon(g, app.screen, strand.offsetAt, strand.widthAt);
      g.fill({ color: strand.color, alpha: strand.alpha });
    }
  };

  // 輝光：外圈很寬很淡的暈、中圈、然後才是清晰的光帶本身。
  // 疊加混色之下，重疊處會自然變成白熱——那就是主視覺裡最亮的地方。
  //
  // alpha 比對齊之前低了不少。以前四層是錯開的，各自貼在旁邊，疊起來
  // 剛好是柔的；對齊之後同一個地方疊四次，用原本的值會燒成一條白鐵片。
  //
  // 外面那兩層直接併進靜態底圖裡。它們是疊加混色，而底圖是不透明且靜止的，
  // 先加跟後加的結果完全一樣——但每幀就少了兩次全螢幕混色。
  // 現場的投影機常常是內顯，全螢幕混色正是那種機器最吃力的事。
  const soft = mergeGlow(app, [
    (() => {
      const layer = bakeGlow(app, paint, 64, 0.3, GOLD_DEEP);
      layer.alpha = 0.62 * look.brightness;
      return layer;
    })(),
    (() => {
      const layer = bakeGlow(app, paint, 30, 0.4, GOLD);
      layer.alpha = 0.56 * look.brightness;
      return layer;
    })(),
  ]);
  still.addChild(soft);

  // 靜止的一切壓成一張圖：底色、水光暈、水緞帶、兩百多條絲綢紋理，
  // 加上外圈的輝光。之後每幀畫的就只是一個全螢幕矩形。
  container.addChild(bakeStatic(app, still));

  // 只留最亮的那一層做疊加，讓它呼吸。
  // 呼吸要有東西可動，而動的那一層必須是疊加混色才會「發亮」而不是「變白」。
  const core = mergeGlow(app, [
    (() => {
      const layer = bakeGlow(app, paint, 12, 0.55, GOLD_BRIGHT);
      layer.alpha = 0.62 * look.brightness;
      return layer;
    })(),
    (() => {
      // 清晰的那一層是唯一有硬邊的，壓一點才不會像貼紙
      const layer = bakeGlow(app, paint, 0, 1);
      layer.alpha = 0.82 * look.brightness;
      return layer;
    })(),
  ]);
  container.addChild(core);

  const tweens = [
    gsap.to(core, {
      alpha: 1.22,
      duration: 4.6,
      repeat: -1,
      yoyo: true,
      ease: "sine.inOut",
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
    // scale 也要每幀更新：光粒要有近大遠小，才看得出是朝著人流過來
    dynamicProperties: { position: true, scale: true, alpha: true },
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
    /** 最近處的大小（像素）。實際大小依 t 由遠到近長大。 */
    readonly size: number;
    /** 閃爍用的相位 */
    readonly phase: number;
  }

  const sparks: Spark[] = [];
  const COUNT = look.particleCount;

  for (let i = 0; i < COUNT; i += 1) {
    // 大部分光粒貼著主光帶跑，少部分散在外圍的髮絲上。
    // 全部平均分佈的話，亮處不會亮，整片會糊成一樣的密度。
    const nearCore = Math.random() < 0.62;
    const side = Math.random() < 0.5 ? 1 : -1;

    const size =
      (nearCore ? gsap.utils.random(1.6, 5) : gsap.utils.random(1, 3)) *
      look.particleSize;

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
            side * gsap.utils.random(2, 30),
            side * gsap.utils.random(15, 110),
            gsap.utils.random(1.2, 2),
          )
        : fanning(
            side * gsap.utils.random(20, 95),
            side * gsap.utils.random(90, 300),
            gsap.utils.random(1.4, 2.8),
          ),
      baseAlpha:
        (nearCore ? gsap.utils.random(0.5, 1) : gsap.utils.random(0.15, 0.5)) *
        look.particleBrightness,
      phase: Math.random() * Math.PI * 2,
      size,
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
      // 乘上 speedScale：河道往畫面外延伸之後同樣的 t 走得更遠，
      // 不補償的話光粒會隨著長度設定一起變慢
      spark.t += spark.speed * deltaSeconds * ambientSpeedScale * geometry.speedScale;
      if (spark.t >= 1) {
        spark.t -= 1;
      }

      const { x, y, angle } = riverAt(spark.t, bounds);
      const offset = lateral(spark.offsetAt(spark.t));
      spark.particle.x = x + Math.sin(angle) * offset;
      spark.particle.y = y - Math.cos(angle) * offset;

      // 近大遠小。基準是「畫面內那一段」而不是整條含延伸的路徑——
      // 用整條算的話，可見範圍全落在曲線前段，光粒會一路又小又暗。
      const visible = Math.min(
        1,
        Math.max(0, (spark.t - geometry.from) / (geometry.to - geometry.from)),
      );
      const near = 0.45 + 0.55 * visible;
      const scale = (spark.size * near) / 64;
      spark.particle.scaleX = scale;
      spark.particle.scaleY = scale;

      // 頭尾淡出（都在畫面外，只是不要讓光粒憑空出現），加上不同步的閃爍
      const fade = Math.min(1, spark.t / 0.05, (1 - spark.t) / 0.05);
      const twinkle = 0.65 + 0.35 * Math.sin(elapsed * 2.4 + spark.phase);
      spark.particle.alpha = spark.baseAlpha * fade * twinkle * near;
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
 * 簽名活動的範圍。
 *
 * 從「主體再往兩端各多走一小段」——那一小段在畫面外。簽名在這個範圍裡
 * 循環，接點因此永遠看不到，就跟光粒一樣一直流不停。
 *
 * 之前的版本只走主體，而且渲染核心會把跑出畫面的角色夾回邊緣，
 * 結果是名字滑到邊緣就卡住、原地淡出再憑空出現。那就是「流動很生硬」。
 * 現在河流世界關掉了夾制（WorldTemplate.clampToBounds = false）。
 */
function flowRange(): { readonly from: number; readonly to: number } {
  return {
    from: Math.max(0, geometry.from - geometry.margin),
    to: Math.min(1, geometry.to + geometry.margin),
  };
}

/**
 * 進出畫面的淡入淡出長度，以「畫面外那一小段」為單位。
 *
 * 1 表示整段淡完，也就是說淡入淡出全部發生在畫面外，
 * 畫面裡看到的簽名一律是全不透明的。
 */
const FADE_SPAN = 1;

const flowBehavior: CharacterBehavior = {
  key: "river-flow",

  init(state: CharacterMotionState, ctx: WorldFrameContext) {
    // vx 借用來存「在河道上的位置 t」，vy 存離中心線的偏移量。
    // 這一層的介面是為了自由漫遊設計的，河流world 需要的是沿曲線前進，
    // 借用既有欄位可以完全不動渲染核心。
    const { from, to } = flowRange();
    state.vx = from + Math.random() * (to - from);
    state.vy = gsap.utils.random(-150, 150);
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
    const { from, to } = flowRange();
    const body = Math.max(0.01, geometry.to - geometry.from);
    const speed = (0.019 + (state.phase / (Math.PI * 2)) * 0.007) * body;
    state.vx += speed * ctx.deltaSeconds * ctx.speedScale;

    if (state.vx >= to) {
      // 迴繞。接點在畫面外，所以看不到——這就是光粒一直流不停的做法。
      state.vx = from + (state.vx - to);
      state.vy = gsap.utils.random(-150, 150);
    }

    // 主體上的相對位置，0 是最上游、1 是最下游
    const local = Math.min(
      1,
      Math.max(0, (state.vx - geometry.from) / body),
    );

    // 往下游收窄：離中心線的距離隨著位置縮小。
    // 這一條就是「匯聚」——散在上游的名字，到下游併成同一束。
    const narrowing = 1 - local * 0.55;
    const offset = lateral(state.vy * narrowing);

    const here = riverAt(state.vx, ctx.bounds);
    state.x = here.x + Math.sin(here.angle) * offset;
    state.y = here.y - Math.cos(here.angle) * offset;

    // 隨波的輕微起伏，不改變左右方向
    const bob = Math.sin(ctx.elapsedSeconds * 0.9 + state.phase) * 4;
    state.y += bob;
    state.rotation = state.tilt + Math.sin(ctx.elapsedSeconds * 0.7 + state.phase) * 0.03;

    // 淡入淡出整段都在畫面外，所以畫面裡的名字一律是清楚的。
    // 這一段唯一的作用是讓迴繞的瞬間不會有東西憑空出現。
    const edge = Math.max(0.0001, geometry.margin * FADE_SPAN);
    const fadeIn = Math.min(1, (state.vx - from) / edge);
    const fadeOut = Math.min(1, (to - state.vx) / edge);
    state.alpha = ctx.band.alpha * Math.max(0, Math.min(fadeIn, fadeOut));
  },
};

/** 從上游漂進來 */
function entrance(sprite: Sprite, bounds: Rect): Timeline {
  const start = riverAt(geometry.from, bounds);
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
  // 簽名沿著固定路徑跑，而路徑的頭尾在畫面外。夾住的話名字會卡在邊緣。
  clampToBounds: false,
  // 光粒放到簽名底下：那些光很亮，蓋在名字上就讀不出來了
  ambientBelowCharacters: true,
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
