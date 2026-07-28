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

console.log(failed === 0 ? "\n全部通過" : `\n有 ${failed} 項失敗`);
process.exit(failed === 0 ? 0 : 1);
