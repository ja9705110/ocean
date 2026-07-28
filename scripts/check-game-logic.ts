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

console.log(failed === 0 ? "\n全部通過" : `\n有 ${failed} 項失敗`);
process.exit(failed === 0 ? 0 : 1);
