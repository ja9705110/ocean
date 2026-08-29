/**
 * 節拍與划槳邏輯的檢查（G1）。
 *
 * 這兩層是純函式與純狀態機，刻意不依賴 DOM 與 React，
 * 就是為了能像這樣直接跑。判定窗只有一百多毫秒，
 * 改動之後靠手感回歸是不可能的，一定要有這支。
 *
 * 執行：npm run check:game
 * （用 Node 內建的型別剝離，不需要任何測試框架或額外套件）
 */

import { readFileSync } from "node:fs";
import {
  DEFAULT_RHYTHM, RhythmScorer, beatIntervalMs, beatTimeMs,
  judge, nearestBeat, parseRhythmConfig,
} from "../src/lib/game/rhythm.ts";
import { RowingDetector, strokeDistanceFor } from "../src/lib/game/rowing.ts";
import { ShakeAnalyser, TARGET_SPM } from "../src/lib/game/motion.ts";
import {
  DEFAULT_RESCUE_CONFIG,
  parseRescueConfig,
  toConfigPatch,
} from "../src/lib/game/rescue.ts";
import { parseStageDisplay, pickStageImages } from "../src/lib/stageDisplay.ts";
import { toCsv } from "../src/lib/checkin/csv.ts";
import { cookieUploadUrl, joinUrl, playUrl, publicOrigin } from "../src/lib/qrcode.ts";
import {
  DEFAULT_STAGE_CONFIG, MAX_FLOW_SPEED, MIN_FLOW_SPEED,
  parseStageConfig, posterIsEmpty, toStageConfigJson,
} from "../src/lib/stageConfig.ts";
import {
  DEFAULT_EXCLUSIONS, applyExclusions, blurMask, buildMask,
  flowField, goldness, sampleFlow, sampleMask, seedCells,
} from "../src/lib/stage/riverMask.ts";
import {
  LAB_MASK_HEIGHT, LAB_MASK_WIDTH, VISUAL_HEIGHT, VISUAL_WIDTH,
  dilateMask, validatePair, type ImageReport,
} from "../src/lib/stage/visualAssets.ts";
import {
  COOKIE_ASPECT, beltSpeed, cookieSlots, planCookieBelt,
} from "../src/lib/stage/cookieBelt.ts";
import {
  DEFAULT_BENDS, DEFAULT_RIVER_LOOK, DEFAULT_RIVER_SHAPE, MAX_BENDS,
  MAX_BEND_V, RIVER_LOOK_LIMITS, RIVER_SHAPE_LIMITS, buildRiverGeometry,
  buildRiverPath, evenBends, parseRiverLook, parseRiverShape,
  riverLookIsDefault, riverShapeIsDefault,
} from "../src/lib/stage/riverShape.ts";

let failed = 0;
function ok(name: string, cond: boolean, extra = "") {
  if (!cond) { failed += 1; console.log("  失敗:", name, extra); }
  else console.log("  通過:", name);
}

console.log("節拍數學");
const bpm = 80;
const interval = beatIntervalMs(bpm);
ok("一拍 750 毫秒", interval === 750);
ok("第 4 拍在 3000 毫秒", beatTimeMs(4, 0, bpm) === 3000);
ok("最近拍：早 40 毫秒", (() => { const r = nearestBeat(2960, 0, bpm); return r.index === 4 && r.errorMs === -40; })());
ok("最近拍：晚 100 毫秒", (() => { const r = nearestBeat(3100, 0, bpm); return r.index === 4 && r.errorMs === 100; })());
ok("判定 perfect", judge(100, DEFAULT_RHYTHM) === "perfect");
ok("判定 good", judge(-200, DEFAULT_RHYTHM) === "good");
ok("判定 miss", judge(300, DEFAULT_RHYTHM) === "miss");

console.log("設定解析");
ok("壞資料退回預設", parseRhythmConfig({ bpm: "abc" }).bpm === DEFAULT_RHYTHM.bpm);
ok("good 不小於 perfect", (() => { const c = parseRhythmConfig({ perfectMs: 200, goodMs: 80 }); return c.goodMs === 200; })());
ok("bpm 夾在範圍內", parseRhythmConfig({ bpm: 9000 }).bpm === 200);

console.log("計分");
{
  const cfg = { ...DEFAULT_RHYTHM, bpm: 80, totalBeats: 8 };
  const s = new RhythmScorer(0, cfg);
  ok("前導拍不計分", s.registerStroke(-700, 5) === null);
  const a = s.registerStroke(30, 5)!;
  ok("準時是完美", a.judgement === "perfect" && a.beatIndex === 0);
  const b = s.registerStroke(60, 5)!;
  ok("同一拍第二次算重複", b.duplicate === true);
  ok("重複不加分", s.tally.perfect === 1 && s.tally.strokes === 1);
  const c = s.registerStroke(750 + 180, 5)!;
  ok("偏一點是不錯", c.judgement === "good" && c.beatIndex === 1);
  const d = s.registerStroke(1500 + 400, 5)!;
  ok("差太多是沒跟上", d.judgement === "miss");
  ok("亂划不佔用該拍", s.registerStroke(1500 + 20, 5)!.duplicate === false);
  // 第 3~7 拍都不划，時間走到最後
  const missed = s.audit(beatTimeMs(8, 0, 80) + 1000);
  ok("漏拍被結算", missed.length === 5, JSON.stringify(missed));
  ok("總數合理", s.tally.perfect === 2 && s.tally.good === 1 && s.tally.miss === 6,
     JSON.stringify(s.tally));
  ok("重複結算不會重複計", s.audit(999999).length === 0);
}

console.log("划槳偵測");
{
  const d = new RowingDetector({ strokeDistance: 100 });
  ok("沒手：released", d.snapshot.grip === "released");
  d.pointerDown("left", 1, 200);
  ok("一手：one-hand", d.snapshot.grip === "one-hand");
  d.pointerDown("right", 2, 200);
  ok("兩手：held", d.snapshot.grip === "held");

  ok("單手拉不算一槳", d.pointerMove(1, 320, 1000) === null);
  ok("進度取較落後的一手", d.snapshot.progress === 0 && d.snapshot.leftProgress === 1);
  const stroke = d.pointerMove(2, 310, 1080);
  ok("兩手都到才算一槳", stroke !== null);
  ok("時刻取兩手平均", stroke!.atMs === 1040, String(stroke?.atMs));
  ok("雙手時間差 80 毫秒", stroke!.handOffsetMs === 80);
  ok("划完進入回槳", d.snapshot.phase === "pulled");

  ok("停在下面不會連發", d.pointerMove(1, 325, 1200) === null && d.pointerMove(2, 315, 1210) === null);
  d.pointerMove(1, 240, 1300);
  d.pointerMove(2, 235, 1310);
  ok("回槳後可再划", d.snapshot.phase === "recovered");
  const second = d.pointerMove(1, 360, 1400) ?? d.pointerMove(2, 350, 1410);
  ok("第二槳成立", second !== null);

  const e = new RowingDetector({ strokeDistance: 100 });
  e.pointerDown("left", 1, 200); e.pointerDown("right", 2, 200);
  e.pointerMove(1, 320, 1000);
  ok("另一手拖太久就作廢", e.pointerMove(2, 320, 2500) === null);

  const f = new RowingDetector({ strokeDistance: 100 });
  f.pointerDown("left", 1, 200); f.pointerDown("right", 2, 200);
  f.pointerMove(1, 320, 1000);
  f.pointerUp(2);
  ok("放開一手就失去握持", f.snapshot.grip === "one-hand" && f.snapshot.progress === 0);

  ok("一槳距離有下限", strokeDistanceFor(60) === 62);
  ok("一槳距離有上限", strokeDistanceFor(2000) === 118);
  ok("一槳距離依高度換算", Math.round(strokeDistanceFor(300)) === 102);
}

console.log("晃動偵測");
{
  const SAMPLE_MS = 1000 / 60;

  /** 餵一段正弦晃動：模擬以 hz 的頻率、amp 的加速度幅度划槳 */
  function shake(
    a: ShakeAnalyser,
    hz: number,
    amp: number,
    seconds: number,
    fromMs = 0,
  ): number {
    let strokes = 0;
    const steps = Math.round((seconds * 1000) / SAMPLE_MS);
    for (let i = 0; i <= steps; i += 1) {
      const t = fromMs + i * SAMPLE_MS;
      const mag = 9.8 + amp * Math.sin((2 * Math.PI * hz * t) / 1000);
      if (a.push(mag, t)) {
        strokes += 1;
      }
      a.read(t);
    }
    return strokes;
  }

  {
    const a = new ShakeAnalyser();
    // 靜止：只有重力，不該有任何一下
    let strokes = 0;
    for (let i = 0; i <= 300; i += 1) {
      if (a.push(9.8, i * SAMPLE_MS)) strokes += 1;
    }
    ok("靜止不會誤判", strokes === 0);
    ok("靜止划速為零", a.read(300 * SAMPLE_MS).spm === 0);
  }

  {
    // 2 Hz = 每分鐘 120 下
    const a = new ShakeAnalyser();
    const strokes = shake(a, 2, 5, 5);
    ok("一個週期算一下", Math.abs(strokes - 10) <= 1, `實際 ${strokes}`);
    const spm = a.read(5000).spm;
    ok("2 Hz 約等於 120 下／分", Math.abs(spm - 120) < 12, `實際 ${spm.toFixed(1)}`);
  }

  {
    // 划得更快，划速要跟著上去
    const slow = new ShakeAnalyser();
    shake(slow, 1.2, 5, 5);
    const fast = new ShakeAnalyser();
    shake(fast, 2.8, 5, 5);
    ok("划越快數字越大", fast.read(5000).spm > slow.read(5000).spm * 1.6);
    ok("強度不超過 1", fast.read(5000).intensity <= 1);
    ok("滿速對應設定值", Math.abs(new ShakeAnalyser().read(0).intensity) === 0 && TARGET_SPM > 0);
  }

  {
    // 停手要掉速，否則放著不動船還在前進
    const a = new ShakeAnalyser();
    shake(a, 2.5, 6, 4);
    const moving = a.read(4000).spm;
    let t = 4000;
    for (let i = 0; i < 220; i += 1) {
      t += SAMPLE_MS;
      a.push(9.8, t);
      a.read(t);
    }
    const stopped = a.read(t).spm;
    ok("停手後掉速", moving > 40 && stopped < moving * 0.2, `${moving.toFixed(0)} → ${stopped.toFixed(0)}`);
  }

  {
    // 靈敏度：同一段輕微晃動，鬆的抓得到、緊的抓不到
    const gentleHigh = new ShakeAnalyser();
    gentleHigh.setSensitivity("high");
    const highCount = shake(gentleHigh, 2, 2.0, 4);

    const gentleLow = new ShakeAnalyser();
    gentleLow.setSensitivity("low");
    const lowCount = shake(gentleLow, 2, 2.0, 4);

    ok("鬆的靈敏度抓得到輕晃", highCount >= 6, `實際 ${highCount}`);
    ok("緊的靈敏度擋掉輕晃", lowCount === 0, `實際 ${lowCount}`);
  }

  {
    // 放開再握回來，累計次數不能被清掉
    const a = new ShakeAnalyser();
    shake(a, 2.4, 6, 3);
    const before = a.read(3000).strokes;
    a.resetRhythm();
    shake(a, 2.4, 6, 3, 4000);
    const after = a.read(7000).strokes;
    ok("換手不會把成績歸零", before > 0 && after > before, `${before} → ${after}`);

    a.reset();
    ok("新回合才歸零", a.read(8000).strokes === 0);
  }

  {
    // 慢慢傾斜手機（重力方向改變）不該被當成划槳
    const a = new ShakeAnalyser();
    let strokes = 0;
    for (let i = 0; i <= 240; i += 1) {
      const t = i * SAMPLE_MS;
      // 四秒內從 9.8 平滑變到 6.0，模擬轉動手機
      const mag = 9.8 - 3.8 * (i / 240);
      if (a.push(mag, t)) strokes += 1;
    }
    ok("緩慢傾斜不算划槳", strokes === 0, `實際 ${strokes}`);
  }

  {
    // 兩下之間太密的雜訊要被最短間隔擋掉
    const a = new ShakeAnalyser();
    let strokes = 0;
    for (let i = 0; i <= 60; i += 1) {
      const t = i * 8;
      const mag = 9.8 + (i % 2 === 0 ? 6 : -6);
      if (a.push(mag, t)) strokes += 1;
    }
    ok("高頻雜訊被最短間隔擋下", strokes <= 4, `實際 ${strokes}`);
  }
}

console.log("場次設定");
{
  // 設定由主持人寫進 jsonb，沒有型別保證。壞掉一定要退回預設，
  // 不能因為設定髒了就讓現場開不了場。
  ok("空設定用預設", parseRescueConfig(null).sensitivity === "medium");
  ok("讀得到主持人設定", parseRescueConfig({ sensitivity: "low" }).sensitivity === "low");
  ok("亂填的靈敏度退回預設", parseRescueConfig({ sensitivity: "turbo" }).sensitivity === "medium");
  ok("回合長度夾在範圍內", parseRescueConfig({ durationMs: 999999 }).durationMs === 300000);
  ok(
    "非數字的長度退回預設",
    parseRescueConfig({ durationMs: "abc" }).durationMs ===
      DEFAULT_RESCUE_CONFIG.durationMs,
  );
  ok(
    "寫回的形狀正確",
    JSON.stringify(toConfigPatch({ sensitivity: "high", durationMs: 30000 })) ===
      '{"sensitivity":"high","durationMs":30000}',
  );
}

console.log("\n大螢幕顯示方式（C1）");
{
  const both = { image_path: "a/art.webp", signature_path: "a/sig.webp" };
  const signOnly = { image_path: "a/sig.webp", signature_path: "a/sig.webp" };
  const artOnly = { image_path: "a/art.webp", signature_path: null };

  ok("亂填的顯示方式退回簽名", parseStageDisplay("whatever") === "signature");
  ok("認得 both", parseStageDisplay("both") === "both");

  ok(
    "簽名模式取簽名",
    pickStageImages(both, "signature").primary === "a/sig.webp",
  );
  ok(
    "簽名模式不合成第二張",
    pickStageImages(both, "signature").secondary === null,
  );
  ok(
    "彩繪模式取彩繪",
    pickStageImages(both, "artwork").primary === "a/art.webp",
  );
  ok(
    "兩者模式：彩繪在上、簽名在下",
    (() => {
      const r = pickStageImages(both, "both");
      return r.primary === "a/art.webp" && r.secondary === "a/sig.webp";
    })(),
  );
  ok(
    "只簽名的人在兩者模式下不會疊兩張一樣的",
    pickStageImages(signOnly, "both").secondary === null,
  );
  // 現場一定有人只簽名就入座，切到彩繪模式時那些人不能整個消失
  ok(
    "只簽名的人在彩繪模式仍有圖",
    pickStageImages(signOnly, "artwork").primary === "a/sig.webp",
  );
  ok(
    "沒簽名的人在簽名模式仍有圖",
    pickStageImages(artOnly, "signature").primary === "a/art.webp",
  );
}

console.log("\n簽到表 CSV（C1）");
{
  const row = {
    displayName: "王小明",
    organization: "某某基金會, 台中",
    title: '他說"你好"',
    seatNo: "3",
    imageUrl: "https://x/art.webp",
    signatureUrl: "https://x/sig.webp",
    checkedInAt: "2026-09-19T03:30:00.000Z",
  };
  const csv = toCsv([row]);

  ok("開頭有 BOM，Excel 才不會亂碼", csv.charCodeAt(0) === 0xfeff);
  ok("換行是 CRLF", csv.includes("\r\n"));
  ok("含逗號的欄位被引號包住", csv.includes('"某某基金會, 台中"'));
  ok("引號被跳脫成兩個", csv.includes('"他說""你好"""'));
  ok("序號從 1 開始", csv.split("\r\n")[1]?.startsWith("1,3,王小明") === true);

  // 只簽名的人沒有彩繪，最後一欄要留白而不是重複貼一次簽名網址
  const sameUrl = { ...row, imageUrl: "https://x/sig.webp" };
  ok(
    "只簽名的人彩繪欄留白",
    toCsv([sameUrl]).split("\r\n")[1]?.endsWith("https://x/sig.webp,") === true,
  );

  ok("沒有人時只有表頭", toCsv([]).split("\r\n").length === 2);
}

console.log("\n大螢幕設定（C2）");
{
  // 這份設定是手打的，任何形狀的髒資料都要能安全落地——
  // 大螢幕在活動當下不能因為某一欄型別不對就整頁白掉
  ok("null 退回預設", parseStageConfig(null).flowSpeed === 1);
  ok("字串退回預設", parseStageConfig("nope").flowSpeed === 1);
  ok(
    "缺 poster 也不會爆",
    posterIsEmpty(parseStageConfig({ flowSpeed: 1 }).poster),
  );
  ok(
    "poster 是陣列時當作沒填",
    posterIsEmpty(parseStageConfig({ poster: [1, 2] }).poster),
  );
  ok(
    "數字型別的文字欄位當作沒填",
    parseStageConfig({ poster: { title: 42 } }).poster.title === "",
  );

  ok("流速太小夾到下限", parseStageConfig({ flowSpeed: 0 }).flowSpeed === MIN_FLOW_SPEED);
  ok("流速太大夾到上限", parseStageConfig({ flowSpeed: 99 }).flowSpeed === MAX_FLOW_SPEED);

  // 光粒子與簽名的流速分開（C28）
  ok("沒設過光粒子流速時跟著簽名走（既有活動看起來完全不變）",
    parseStageConfig({ flowSpeed: 1.6 }).particleSpeed === 1.6);
  ok("設了就各走各的",
    (() => {
      const c = parseStageConfig({ flowSpeed: 0.5, particleSpeed: 2 });
      return c.flowSpeed === 0.5 && c.particleSpeed === 2;
    })());
  ok("光粒子流速也會夾在範圍內",
    parseStageConfig({ flowSpeed: 1, particleSpeed: 99 }).particleSpeed
      === MAX_FLOW_SPEED);
  ok("光粒子流速是髒資料時退回簽名的流速",
    parseStageConfig({ flowSpeed: 1.4, particleSpeed: "快" }).particleSpeed === 1);
  /*
    兩個流速真的沒有綁在一起——用原始碼層級的不變式守。

    為什麼不是量畫面：試過了，200 個角色扣掉粒子底噪之後是
    0.00% 對 0.01%。角色沿著河道緩慢漂移，兩幀之間移動的像素本來就
    少於粒子的閃爍，訊號整個埋在噪音裡，那組數字下不了結論。

    這裡守的是「誰讀誰」：角色那條路只讀 ctx.speedScale，
    環境層只讀 ambientSpeedScale。有人日後又把它們綁回同一個數字，
    這一項就會失敗——而那正是這次修掉的毛病。
  */
  {
    const river = readFileSync("src/world/templates/river.ts", "utf8");
    const renderer = readFileSync("src/world/engine/WorldRenderer.ts", "utf8");

    const sparkLine = river
      .split("\n")
      .find((line) => line.includes("spark.t +="));
    ok("光粒子只吃 ambientSpeedScale，沒有讀 ctx.speedScale",
      sparkLine !== undefined &&
        sparkLine.includes("ambientSpeedScale") &&
        !sparkLine.includes("ctx.speedScale"));

    const charLine = river
      .split("\n")
      .find((line) => line.includes("state.vx +="));
    ok("角色只吃 ctx.speedScale，沒有讀 ambientSpeedScale",
      charLine !== undefined &&
        charLine.includes("ctx.speedScale") &&
        !charLine.includes("ambientSpeedScale"));

    // setSpeedScale 以前會順手通知模板，把兩者綁在一起——那一行要不見了
    const setSpeed = renderer.slice(
      renderer.indexOf("setSpeedScale(value: number)"),
      renderer.indexOf("setAmbientSpeedScale(value: number)"),
    );
    ok("設定角色流速時不會順手改到光粒子",
      !setSpeed.includes("onSpeedScaleChange"));
    ok("光粒子有自己的那一支 setter",
      renderer.includes("setAmbientSpeedScale(value: number)") &&
        renderer
          .slice(renderer.indexOf("setAmbientSpeedScale(value: number)"))
          .includes("onSpeedScaleChange"));
  }

  ok("兩個流速都寫得回資料庫",
    (() => {
      const json = toStageConfigJson(
        parseStageConfig({ flowSpeed: 0.6, particleSpeed: 1.8 }),
      );
      return json.flowSpeed === 0.6 && json.particleSpeed === 1.8;
    })());
  ok("非數字流速退回 1", parseStageConfig({ flowSpeed: "快" }).flowSpeed === 1);
  ok("正常流速原樣保留", parseStageConfig({ flowSpeed: 0.6 }).flowSpeed === 0.6);

  ok(
    "主標過長會被截斷",
    parseStageConfig({ poster: { title: "一二三四五六七八九十十一十二十三" } })
      .poster.title.length === 12,
  );
  ok(
    "前後空白會被去掉",
    parseStageConfig({ poster: { tagline: "  每一條河  " } }).poster.tagline ===
      "每一條河",
  );

  ok(
    "整塊沒填就是空的",
    posterIsEmpty(DEFAULT_STAGE_CONFIG.poster),
  );
  ok(
    "只填一行就不算空的",
    !posterIsEmpty(parseStageConfig({ poster: { title: "流嚮" } }).poster),
  );

  // 存回去再讀出來要一模一樣，否則主持人存完重整會發現設定跑掉
  // 這個值會直接進 <img src>，不能讓 javascript: 之類的東西進來
  ok(
    "背景圖只收 http(s)",
    parseStageConfig({ backgroundUrl: "javascript:alert(1)" }).backgroundUrl ===
      "",
  );
  ok(
    "正常網址保留",
    parseStageConfig({ backgroundUrl: "https://x/a.png" }).backgroundUrl ===
      "https://x/a.png",
  );
  ok(
    "壓暗夾在上限內",
    parseStageConfig({ backgroundDim: 9 }).backgroundDim === 0.85,
  );
  ok(
    "QR 預設是顯示的",
    parseStageConfig({}).showQr === true,
  );
  ok(
    "QR 只有明確設成 false 才隱藏",
    parseStageConfig({ showQr: false }).showQr === false,
  );

  ok(
    "來回轉換不失真",
    (() => {
      const original = parseStageConfig({
        flowSpeed: 0.75,
        backgroundUrl: "https://x/bg.png",
        backgroundDim: 0.4,
        showQr: false,
        poster: { title: "流嚮", tagline: "每一條河，都有自己的方向" },
      });
      const round = parseStageConfig(toStageConfigJson(original));
      return JSON.stringify(round) === JSON.stringify(original);
    })(),
  );
}

console.log("\n主視覺河道遮罩（C4）");
{
  // 金色的水要被認出來，深藍的水不能
  ok("亮金色算河道", goldness(255, 220, 150) > 0.6);
  ok("暗金色不算（那是底噪）", goldness(70, 55, 30) < 0.2);
  ok("深藍的水不算", goldness(20, 40, 90) === 0);
  ok("亮藍白的水光不算（不夠暖）", goldness(150, 190, 235) === 0);

  // 造一張假的主視覺：整片深藍，中間一條橫的金帶，左上角一塊金色的字
  const W = 64;
  const H = 36;
  const pixels = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const i = (y * W + x) * 4;
      const river = y >= 16 && y <= 20;
      const text = x < 12 && y < 8;
      const gold = river || text;
      pixels[i] = gold ? 250 : 18;
      pixels[i + 1] = gold ? 215 : 38;
      pixels[i + 2] = gold ? 140 : 88;
      pixels[i + 3] = 255;
    }
  }

  const noExclusion = buildMask(pixels, W, H, []);
  ok(
    "沒有排除區時，金色的字也會被當成河道",
    sampleMask(noExclusion, W, H, 4, 4) > 0.5,
  );

  // 這正是規格要求「不能只使用顏色辨識」的理由
  const masked = buildMask(pixels, W, H, [
    { x: 0, y: 0, w: 0.25, h: 0.3, note: "左上角的字" },
  ]);
  ok("排除區裡的金色字被清成 0", sampleMask(masked, W, H, 4, 4) < 0.02);
  ok("河道本身不受影響", sampleMask(masked, W, H, 40, 18) > 0.5);

  // 排除區邊緣要有漸變，硬邊在畫面上會是一條看得出來的直線
  const hard = buildMask(pixels, W, H, []);
  applyExclusions(hard, W, H, [{ x: 0, y: 0, w: 0.5, h: 1, note: "左半" }], 0.15);
  const inside = sampleMask(hard, W, H, 10, 18);
  const edge = sampleMask(hard, W, H, 36, 18);
  const outside = sampleMask(hard, W, H, 50, 18);
  ok("排除區內是 0", inside < 0.02);
  ok("邊緣是漸變而不是硬邊", edge > 0.02 && edge < outside);

  // 模糊之後河道邊界外側要有一點殘值，光點才不會忽然出現與消失
  const blurred = blurMask(masked, W, H, 2);
  ok(
    "模糊讓河道邊界外側有殘值",
    sampleMask(masked, W, H, 40, 22) < 0.02 &&
      sampleMask(blurred, W, H, 40, 22) > 0.02,
  );

  // 流場：橫向的河道，方向應該是水平的
  const field = flowField(blurred, W, H, { x: 1, y: 0 });
  const flow = sampleFlow(field, W, H, 40, 18);
  ok("橫向河道的流向是水平的", Math.abs(flow.x) > 0.9 && Math.abs(flow.y) < 0.3);
  ok("流向與提示同向（不會逆流）", flow.x > 0);

  const reversed = flowField(blurred, W, H, { x: -1, y: 0 });
  ok(
    "換提示方向就反向",
    sampleFlow(reversed, W, H, 40, 18).x < 0,
  );

  // 出生地只在河道裡
  const seeds = seedCells(blurred);
  ok("有找到出生地", seeds.length > 0);
  ok(
    "出生地全部落在河道附近，沒有一個在被排除的字上",
    seeds.every((cell) => {
      const x = cell % W;
      const y = Math.floor(cell / W);
      return !(x < 12 && y < 8);
    }),
  );

  // 取樣超出邊界不能爆，也不能回傳垃圾值
  ok("取樣超出範圍回 0", sampleMask(blurred, W, H, -5, 100) === 0);

  ok(
    "預設排除區含左側整欄與右下角",
    DEFAULT_EXCLUSIONS.length === 2 &&
      DEFAULT_EXCLUSIONS[0]!.x === 0 &&
      DEFAULT_EXCLUSIONS[1]!.y > 0.5,
  );
}

console.log("\n主視覺素材檢查與文字保護遮罩（C8）");
{
  // 這一段的重點是「該擋的有沒有擋下來」。
  // 素材對不上的時候要在畫面上就講清楚，而不是等到活動當天
  // 才發現文字浮在河道旁邊三十個像素的地方。
  const report = (
    width: number,
    height: number,
    transparentRatio: number,
    name = "x.png",
  ): ImageReport =>
    ({
      name,
      width,
      height,
      hasAlpha: transparentRatio > 0.3,
      transparentRatio,
      image: null,
      src: "",
    }) as unknown as ImageReport;

  const good = report(VISUAL_WIDTH, VISUAL_HEIGHT, 0);
  const goodOverlay = report(VISUAL_WIDTH, VISUAL_HEIGHT, 0.93);

  ok("正確的一對沒有任何問題", validatePair(good, goodOverlay).length === 0);
  ok("只選了一張時不會誤報", validatePair(good, null).length === 0);

  const noAlpha = validatePair(good, report(VISUAL_WIDTH, VISUAL_HEIGHT, 0.02));
  ok(
    "去背圖沒有 Alpha 是錯誤，不是警告",
    noAlpha.length === 1 && noAlpha[0]!.level === "error",
  );
  ok(
    "錯誤訊息要說明不會自動去背（否則使用者會以為系統壞了）",
    noAlpha[0]!.message.includes("不會自動用白色或亮度去背"),
  );

  // 尺寸不同但比例相同：座標對不起來，一定要擋
  const sizeMismatch = validatePair(
    good,
    report(VISUAL_WIDTH / 2, VISUAL_HEIGHT / 2, 0.93),
  );
  ok(
    "兩張尺寸不同是錯誤",
    sizeMismatch.some((i) => i.level === "error" && i.message.includes("座標")),
  );

  // 比例不同：疊起來會拉伸變形
  const ratioMismatch = validatePair(good, report(1600, 941, 0.93));
  ok(
    "長寬比不同是錯誤",
    ratioMismatch.some(
      (i) => i.level === "error" && i.message.includes("長寬比"),
    ),
  );

  // 等比例放大：對得齊，所以只提醒不阻擋
  const scaled = validatePair(
    report(VISUAL_WIDTH * 2, VISUAL_HEIGHT * 2, 0),
    report(VISUAL_WIDTH * 2, VISUAL_HEIGHT * 2, 0.93),
  );
  ok(
    "等比例放大只給警告，不擋下來",
    scaled.length > 0 && scaled.every((i) => i.level === "warning"),
  );

  // 擴張：文字周圍那一圈發光也要一起擋住。
  // 用取鄰域最大值而不是模糊——模糊會讓邊緣變淡，而邊緣正是要擋的地方。
  const W = 16;
  const H = 16;
  const dot = new Float32Array(W * H);
  dot[8 * W + 8] = 1;
  const grown = dilateMask(dot, W, H, 2);
  ok("擴張之後中心還是滿值", grown[8 * W + 8] === 1);
  ok("擴張半徑內是滿值，不是被模糊掉的殘值", grown[8 * W + 10] === 1);
  ok("擴張半徑外仍是 0", grown[8 * W + 11] === 0);
  ok("對角線也擴張到（兩次一維掃描的結果）", grown[10 * W + 10] === 1);
  ok("半徑 0 時原樣回傳", dilateMask(dot, W, H, 0) === dot);

  // 邊界不能溢出到另一行
  const edge = new Float32Array(W * H);
  edge[5 * W + 0] = 1;
  const grownEdge = dilateMask(edge, W, H, 2);
  ok("靠邊的點不會繞到上一行的尾端", grownEdge[4 * W + (W - 1)] === 0);

  ok(
    "遮罩解析度維持 16:9，跟主視覺同比例",
    Math.abs(
      LAB_MASK_WIDTH / LAB_MASK_HEIGHT - VISUAL_WIDTH / VISUAL_HEIGHT,
    ) < 0.02,
  );
}

console.log("\n河道形狀（C9／C10）");
{
  // 預設值：一個平緩的 S，從右上流到左下。
  //
  // 原本的預設是照著主視覺描的八個控制點，數字忠實但那條 S 是個髮夾彎
  // （側向甩出 0.16 只花了 0.06 的行程）。光帶一有寬度，彎道內側就會
  // 翻折並冒出亮楔形——以前被對不準的輝光糊掉了，輝光一對準就露出來。
  // 所以預設改成平緩的兩個轉彎。要更急的彎由使用者自己在後台拖。
  const path = buildRiverPath(DEFAULT_RIVER_SHAPE);
  ok("預設是兩個轉彎，展開成四個控制點", path.length === 4);
  ok(
    "走向仍然是從右上流到左下",
    path[0]!.x > path[path.length - 1]!.x &&
      path[0]!.y < path[path.length - 1]!.y,
  );

  // 曲率：預設不能有髮夾彎。
  // 這一項是回歸測試——把預設調回急彎，畫面上就會再出現那塊亮楔形。
  {
    const sampleCurvature = (points: readonly { x: number; y: number }[]) => {
      // 以連續三點的外接圓半徑估計曲率，取最大值
      let worstK = 0;
      for (let i = 1; i < points.length - 1; i += 1) {
        const a = points[i - 1]!;
        const b = points[i]!;
        const c = points[i + 1]!;
        const area =
          Math.abs(
            (b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y),
          ) / 2;
        const ab = Math.hypot(b.x - a.x, b.y - a.y);
        const bc = Math.hypot(c.x - b.x, c.y - b.y);
        const ca = Math.hypot(a.x - c.x, a.y - c.y);
        if (area < 1e-9) {
          continue;
        }
        worstK = Math.max(worstK, (4 * area) / (ab * bc * ca));
      }
      return worstK;
    };
    const k = sampleCurvature(path);
    // 1/k 是轉彎半徑（正規化空間）。光帶最寬的光絲在 0.2 附近，
    // 半徑至少要有那個量級才不會翻折。
    ok(`預設沒有髮夾彎（轉彎半徑 ${(1 / k).toFixed(2)}）`, 1 / k > 0.35);
  }

  const lateralOf = (points: readonly { x: number; y: number }[]) => {
    const first = points[0]!;
    const last = points[points.length - 1]!;
    const span = Math.hypot(last.x - first.x, last.y - first.y);
    return points.reduce((max, p) => {
      const cross =
        (last.x - first.x) * (p.y - first.y) -
        (last.y - first.y) * (p.x - first.x);
      return Math.max(max, Math.abs(cross) / span);
    }, 0);
  };

  // 沒有轉彎就是一條直線
  const straight = buildRiverPath({ ...DEFAULT_RIVER_SHAPE, bends: [] });
  ok("沒有轉彎時是一條直線", lateralOf(straight) < 1e-9);
  ok("沒有轉彎時只剩頭尾兩個控制點", straight.length === 2);

  // 一個轉彎：偏移量與方向都要照著設定
  const oneRight = buildRiverPath({
    ...DEFAULT_RIVER_SHAPE,
    bends: [{ u: 0.5, v: 0.2 }],
  });
  const oneLeft = buildRiverPath({
    ...DEFAULT_RIVER_SHAPE,
    bends: [{ u: 0.5, v: -0.2 }],
  });
  ok("一個轉彎就有一個彎", oneRight.length === 3);
  ok(
    `轉彎的幅度照著 v 走（量到 ${lateralOf(oneRight).toFixed(3)}）`,
    Math.abs(lateralOf(oneRight) - 0.2) < 0.001,
  );
  ok(
    "v 換正負就換邊彎",
    Math.sign(oneRight[1]!.x - oneLeft[1]!.x) !== 0 &&
      Math.abs(oneRight[1]!.x - oneLeft[1]!.x) > 0.1,
  );

  // 轉彎數量：加幾個就是幾個
  for (const n of [1, 3, 5]) {
    const many = buildRiverPath({ ...DEFAULT_RIVER_SHAPE, bends: evenBends(n) });
    ok(`${n} 個轉彎展開成 ${n + 2} 個控制點`, many.length === n + 2);
  }
  ok(
    "自動加出來的轉彎是左右交替的蛇行，不會往同一邊愈滑愈遠",
    evenBends(4).every((bend, i) => Math.sign(bend.v) === (i % 2 === 0 ? 1 : -1)),
  );
  ok("轉彎數量有上限", evenBends(99).length === MAX_BENDS);

  // 長度：首尾距離等比例
  const shortSpan = (() => {
    const p = buildRiverPath({ ...DEFAULT_RIVER_SHAPE, length: 0.5 });
    return Math.hypot(
      p[p.length - 1]!.x - p[0]!.x,
      p[p.length - 1]!.y - p[0]!.y,
    );
  })();
  const fullSpan = Math.hypot(
    path[path.length - 1]!.x - path[0]!.x,
    path[path.length - 1]!.y - path[0]!.y,
  );
  ok("長度減半，首尾距離也減半", Math.abs(shortSpan / fullSpan - 0.5) < 0.01);

  // 反向：角度加 180 度，首尾互換位置（繞著同一個中心）
  const flipped = buildRiverPath({
    ...DEFAULT_RIVER_SHAPE,
    angle: DEFAULT_RIVER_SHAPE.angle + 180,
  });
  ok(
    "角度加 180 度就是反向流（起點跑到原本的終點）",
    Math.hypot(
      flipped[0]!.x - path[path.length - 1]!.x,
      flipped[0]!.y - path[path.length - 1]!.y,
    ) < 0.01,
  );

  // 位置：所有點一起平移，形狀不變
  const moved = buildRiverPath({
    ...DEFAULT_RIVER_SHAPE,
    offsetX: 0.1,
    offsetY: -0.05,
  });
  ok(
    "位置只平移，不改形狀",
    moved.every((p, i) => {
      const base = path[i]!;
      return (
        Math.abs(p.x - base.x - 0.1) < 1e-9 &&
        Math.abs(p.y - base.y + 0.05) < 1e-9
      );
    }),
  );

  // ── 頭尾一定要在畫面外 ──
  //
  // 這是使用者明確要求的：河要有「從遠處流過來、往近處流出去」的感覺，
  // 兩端收在畫面裡就變成一條躺在畫面中央的緞帶。
  // 所以不管流向轉到哪裡、長度調到多短、位置移到哪，都要成立。
  const outside = (p: { x: number; y: number }) =>
    p.x < -0.02 || p.x > 1.02 || p.y < -0.02 || p.y > 1.02;

  let allOutside = true;
  let worstCase = "";
  for (const angle of [0, 45, 90, 140.5, 200, 270, 315]) {
    for (const length of [0.5, 1, 1.8]) {
      for (const [ox, oy] of [
        [0, 0],
        [0.5, 0.5],
        [-0.5, -0.5],
      ] as const) {
        const geo = buildRiverGeometry({
          ...DEFAULT_RIVER_SHAPE,
          angle,
          length,
          offsetX: ox,
          offsetY: oy,
        });
        const head = geo.points[0]!;
        const tail = geo.points[geo.points.length - 1]!;
        if (!outside(head) || !outside(tail)) {
          allOutside = false;
          worstCase = `角度 ${angle} 長度 ${length} 位置 ${ox},${oy}`;
        }
      }
    }
  }
  ok(`任何設定下頭尾都在畫面外${worstCase ? `（失敗於 ${worstCase}）` : ""}`, allOutside);

  // 延伸段的段長要跟主體一致，否則樣條走起來會忽快忽慢
  {
    const geo = buildRiverGeometry(DEFAULT_RIVER_SHAPE);
    const lengths: number[] = [];
    for (let i = 0; i < geo.points.length - 1; i += 1) {
      const a = geo.points[i]!;
      const b = geo.points[i + 1]!;
      lengths.push(Math.hypot(b.x - a.x, b.y - a.y));
    }
    const lead = lengths[0]!;
    const tail = lengths[lengths.length - 1]!;
    const mid = lengths[Math.floor(lengths.length / 2)]!;
    ok(
      `延伸段與主體的段長相近（${lead.toFixed(3)} / ${mid.toFixed(3)} / ${tail.toFixed(3)}）`,
      Math.abs(lead - tail) < 1e-9 && lead / mid > 0.5 && lead / mid < 2.5,
    );
  }

  // 主體在 t 上的範圍：延伸越長，主體佔的比例越小，速度補償要跟著放大
  {
    const geo = buildRiverGeometry(DEFAULT_RIVER_SHAPE);
    ok("主體不是從 t=0 開始（前面那段在畫面外）", geo.from > 0.05);
    ok("主體不是到 t=1 結束（後面那段在畫面外）", geo.to < 0.95);
    ok(
      `速度補償等於 1 除以主體佔比（${geo.speedScale.toFixed(3)}）`,
      Math.abs(geo.speedScale - 1 / (geo.to - geo.from)) < 1e-9,
    );
    ok("速度補償大於 1（延伸之後同樣的 t 走得更遠）", geo.speedScale > 1);
  }

  // 解析：髒資料要安全落地
  ok("不是物件就退回預設", parseRiverShape(null).bends.length === DEFAULT_BENDS.length);
  ok("非數字的長度退回預設", parseRiverShape({ length: "abc" }).length === 1);
  ok(
    "超出範圍的值被夾住",
    parseRiverShape({ width: 99 }).width === RIVER_SHAPE_LIMITS.width.max,
  );
  ok("角度 370 度繞回 10 度", parseRiverShape({ angle: 370 }).angle === 10);
  ok("角度 -20 度繞回 340 度", parseRiverShape({ angle: -20 }).angle === 340);
  ok(
    "轉彎依 u 排序（後台插入新的轉彎時不必自己找位置）",
    (() => {
      const parsed = parseRiverShape({
        bends: [
          { u: 0.8, v: 0.1 },
          { u: 0.2, v: -0.1 },
        ],
      }).bends;
      return parsed[0]!.u === 0.2 && parsed[1]!.u === 0.8;
    })(),
  );
  ok(
    "轉彎的偏移量被夾在合理範圍",
    parseRiverShape({ bends: [{ u: 0.5, v: 99 }] }).bends[0]!.v === MAX_BEND_V,
  );
  ok(
    "轉彎數量超過上限時只留前面幾個",
    parseRiverShape({
      bends: Array.from({ length: 30 }, (_, i) => ({ u: i / 30, v: 0.1 })),
    }).bends.length === MAX_BENDS,
  );
  ok("空陣列是合法的（那是一條直線）", parseRiverShape({ bends: [] }).bends.length === 0);

  // C9 的舊資料只有一個 bend 倍率，升級之後畫面不能突然變樣
  ok(
    "舊資料的 bend 倍率換算成轉彎",
    (() => {
      const parsed = parseRiverShape({ bend: 1 }).bends;
      return (
        parsed.length === DEFAULT_BENDS.length &&
        Math.abs(parsed[0]!.v - DEFAULT_BENDS[0]!.v) < 1e-9
      );
    })(),
  );
  ok(
    "舊資料的 bend 0 換算成直線",
    parseRiverShape({ bend: 0 }).bends.every((b) => b.v === 0),
  );

  ok("預設值被認出是預設", riverShapeIsDefault(DEFAULT_RIVER_SHAPE));
  ok(
    "動過一個轉彎就不是預設了",
    !riverShapeIsDefault({
      ...DEFAULT_RIVER_SHAPE,
      bends: [{ u: 0.5, v: 0.2 }],
    }),
  );

  // 這一份會被寫進 stage_config，來回一趟要不失真
  const custom = parseRiverShape({
    angle: 200,
    bends: [
      { u: 0.3, v: 0.2 },
      { u: 0.7, v: -0.15 },
    ],
    length: 0.8,
    width: 1.6,
    offsetX: 0.12,
    offsetY: -0.08,
  });
  const roundTrip = parseStageConfig(
    toStageConfigJson({ ...DEFAULT_STAGE_CONFIG, river: custom }),
  );
  ok(
    "河道形狀存進設定再讀回來不失真",
    JSON.stringify(roundTrip.river) === JSON.stringify(custom),
  );
  ok(
    "舊活動沒有這一欄時拿到預設值（不能整個大螢幕空掉）",
    riverShapeIsDefault(parseStageConfig({ flowSpeed: 1 }).river),
  );
}

console.log("\n河道外觀與簽名迴圈（C11）");
{
  // 亮度：簽名讀不讀得到就靠這一個，所以不能有「調到 0 整條河消失」
  ok("預設亮度是 1", DEFAULT_RIVER_LOOK.brightness === 1);
  ok(
    "亮度不能調到 0（畫面只剩黑底不是設定，是壞掉）",
    RIVER_LOOK_LIMITS.brightness.min > 0,
  );
  ok(
    "亮度超出範圍會被夾住",
    parseRiverLook({ brightness: 99 }).brightness ===
      RIVER_LOOK_LIMITS.brightness.max,
  );
  ok("光粒可以完全關掉", parseRiverLook({ particleCount: 0 }).particleCount === 0);
  ok(
    "光粒數量有上限（350 人同時在線時大螢幕不能掉幀）",
    parseRiverLook({ particleCount: 99999 }).particleCount ===
      RIVER_LOOK_LIMITS.particleCount.max,
  );
  ok("光粒數量是整數", Number.isInteger(parseRiverLook({ particleCount: 137.6 }).particleCount));
  ok("髒資料退回預設", parseRiverLook({ brightness: "abc" }).brightness === 1);
  ok("不是物件退回預設", riverLookIsDefault(parseRiverLook(null)));
  ok(
    "外觀存進設定再讀回來不失真",
    (() => {
      const custom = parseRiverLook({
        brightness: 0.4,
        particleCount: 300,
        particleSize: 1.5,
        particleBrightness: 0.6,
      });
      const round = parseStageConfig(
        toStageConfigJson({ ...DEFAULT_STAGE_CONFIG, riverLook: custom }),
      );
      return JSON.stringify(round.riverLook) === JSON.stringify(custom);
    })(),
  );
  ok(
    "舊活動沒有這一欄時拿到預設值",
    riverLookIsDefault(parseStageConfig({ flowSpeed: 1 }).riverLook),
  );

  // 簽名的迴圈範圍：兩端都必須在畫面外，接點才看不到。
  // 這是「流動很生硬」的根因——之前簽名只走主體，走到邊緣被夾住原地淡出。
  {
    let allOutside = true;
    let worstCase = "";
    for (const angle of [0, 45, 90, 140.5, 200, 270, 315]) {
      for (const length of [0.5, 1, 1.8]) {
        const geo = buildRiverGeometry({
          ...DEFAULT_RIVER_SHAPE,
          angle,
          length,
        });
        const from = geo.from - geo.margin;
        const to = geo.to + geo.margin;
        // 迴圈的兩端要落在延伸段裡（也就是畫面外）
        if (from < 0 || to > 1 || geo.margin <= 0) {
          allOutside = false;
          worstCase = `角度 ${angle} 長度 ${length}`;
        }
      }
    }
    ok(
      `簽名迴圈的接點都在畫面外${worstCase ? `（失敗於 ${worstCase}）` : ""}`,
      allOutside,
    );

    const geo = buildRiverGeometry(DEFAULT_RIVER_SHAPE);
    const visible = geo.to - geo.from;
    const loop = visible + geo.margin * 2;
    ok(
      `畫面內佔迴圈的比例夠高（${((visible / loop) * 100).toFixed(0)}%，太低會看不到幾個名字）`,
      visible / loop > 0.55,
    );
  }
}

console.log("\n餅乾輸送帶（C14）");
{
  const belt = planCookieBelt({
    pathLength: 5600,
    halfWidth: 150,
    tileWidth: 64,
    photoCount: 220,
  });

  // 接縫是這一段最容易出事的地方：格距沒有整除河道長度的話，
  // 迴圈的接點會在同一個位置一直重複出現，非常明顯。
  ok(
    `格距乘上格數剛好等於河道全長（${(belt.spacing * belt.columns).toFixed(2)} 對 5600）`,
    Math.abs(belt.spacing * belt.columns - 5600) < 1e-6,
  );
  ok("格距跟格高相近（不會擠在一起也不會有空隙）",
    Math.abs(belt.spacing / belt.tileHeight - 1) < 0.5);
  ok("格子是直立的長方形，跟餅乾一樣",
    Math.abs(belt.tileWidth / belt.tileHeight - COOKIE_ASPECT) < 1e-9);

  // 排數要跟著鋪滿的寬度走
  const wide = planCookieBelt({
    pathLength: 5600, halfWidth: 300, tileWidth: 64, photoCount: 220,
  });
  ok(`鋪得越寬排數越多（${belt.rows} → ${wide.rows}）`, wide.rows > belt.rows);

  // 格子越大，排數與格數都越少
  const big = planCookieBelt({
    pathLength: 5600, halfWidth: 150, tileWidth: 128, photoCount: 220,
  });
  ok(`格子放大之後總格數變少（${belt.slots} → ${big.slots}）`, big.slots < belt.slots);

  // 上限：不能把三千個貼圖丟給投影機那台機器
  const insane = planCookieBelt({
    pathLength: 60000, halfWidth: 2000, tileWidth: 28, photoCount: 220,
  });
  ok(`總格數有上限（量到 ${insane.slots}）`, insane.slots <= 1600);

  // 一定要鋪滿：人少的時候照片重複用，河道不能開天窗
  const few = planCookieBelt({
    pathLength: 5600, halfWidth: 150, tileWidth: 64, photoCount: 12,
  });
  const fewSlots = cookieSlots(few, 0, 12);
  ok("人少的時候照片重複使用，格子全部有東西",
    fewSlots.length === few.slots &&
      fewSlots.every((slot) => slot.photoIndex >= 0 && slot.photoIndex < 12));

  // 每一格固定對應同一張照片：格子會繞回來但不能換人，
  // 否則沒有人找得到自己的那一張
  const atZero = cookieSlots(belt, 0, 220);
  const later = cookieSlots(belt, 1234.5, 220);
  ok("輸送帶推進之後，每一格還是同一個人的照片",
    atZero.length === later.length &&
      atZero.every((slot, i) => slot.photoIndex === later[i]!.photoIndex));

  // t 一定要落在 0~1，否則取樣會跑到河道外面
  ok("所有格子的位置都在河道上",
    later.every((slot) => slot.t >= 0 && slot.t < 1));

  // 繞一整圈之後回到原點：接縫看不見的前提
  const beltLength = belt.spacing * belt.columns;
  const wrapped = cookieSlots(belt, beltLength, 220);
  ok("推進一整圈之後回到原本的位置",
    atZero.every((slot, i) => Math.abs(slot.t - wrapped[i]!.t) < 1e-9));

  // 負的推進量也要能繞（反向流的時候會用到）
  const backwards = cookieSlots(belt, -500, 220);
  ok("往回推也不會算出負的位置",
    backwards.every((slot) => slot.t >= 0 && slot.t < 1));

  // 橫向：最外側剛好在鋪滿範圍的邊界上
  ok("最外側那一排在鋪滿範圍的邊界",
    Math.abs(Math.min(...later.map((s) => s.lateral)) + 1) < 1e-9 &&
      Math.abs(Math.max(...later.map((s) => s.lateral)) - 1) < 1e-9);

  // 速度：用「幾秒一圈」表達，河道變長不該讓它變慢
  ok("河道變長時速度跟著變快，一圈的時間不變",
    Math.abs(beltSpeed(11200, 90) / beltSpeed(5600, 90) - 2) < 1e-9);
  ok("秒數不會是零（除以零會讓整條河消失）", beltSpeed(5600, 0) === 5600);

  ok("沒有照片時不會畫出任何格子", cookieSlots(belt, 0, 0).length === 0);
}

// ============================================================
// QR Code 指向的網域（C16）
//
// 桌卡是活動前印的。印的當下如果後台開在 Vercel 的預覽網址或
// localhost，印出來的 QR 就會指到那裡——而預覽網址預設要登入。
// 三百個人拿著手機站著的時候才發現就來不及了。
// ============================================================
{
  console.log("\nQR Code 的網域（C16）");

  const LIVE = "https://flow.example.com";
  const PREVIEW = "https://ocean-git-abc123.vercel.app";

  // 沒設定時沿用現在這個網域，跟以前的行為一樣
  delete process.env.NEXT_PUBLIC_SITE_URL;
  ok("沒設定時沿用目前的網域", publicOrigin(PREVIEW) === PREVIEW);
  ok("沒設定時桌卡的網址也沿用目前的網域",
    playUrl(PREVIEW, "AB12") === `${PREVIEW}/play/AB12`);

  // 設定之後一律指向正式站，不管後台現在開在哪
  process.env.NEXT_PUBLIC_SITE_URL = LIVE;
  ok("設定之後不再跟著預覽網址跑", publicOrigin(PREVIEW) === LIVE);
  ok("桌卡指向正式站", playUrl(PREVIEW, "AB12") === `${LIVE}/play/AB12`);
  ok("報到指向正式站", joinUrl(PREVIEW, "FLOW01") === `${LIVE}/join/FLOW01`);
  ok("餅乾上傳指向正式站",
    cookieUploadUrl(PREVIEW, "FLOW01") === `${LIVE}/cookie/FLOW01`);
  ok("在 localhost 印桌卡也一樣指向正式站",
    playUrl("http://localhost:3000", "AB12") === `${LIVE}/play/AB12`);

  // 貼網址的人很常多帶一條斜線，那會變成 https://x.com//play/AB12
  process.env.NEXT_PUBLIC_SITE_URL = `${LIVE}/`;
  ok("結尾多打斜線不會變成兩條", playUrl(PREVIEW, "AB12") === `${LIVE}/play/AB12`);
  process.env.NEXT_PUBLIC_SITE_URL = `${LIVE}///`;
  ok("結尾多打好幾條斜線也吃得下",
    playUrl(PREVIEW, "AB12") === `${LIVE}/play/AB12`);

  // 空白字串等於沒設，不要因此產出 "/play/AB12" 這種沒有網域的網址
  process.env.NEXT_PUBLIC_SITE_URL = "   ";
  ok("只有空白等於沒設定", publicOrigin(PREVIEW) === PREVIEW);
  delete process.env.NEXT_PUBLIC_SITE_URL;
}

console.log(failed === 0 ? "\n全部通過" : `\n有 ${failed} 項失敗`);
process.exit(failed === 0 ? 0 : 1);
