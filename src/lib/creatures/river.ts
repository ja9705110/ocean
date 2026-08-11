/**
 * 河流主題的符號。
 *
 * 與海洋那一套共用同一個約定：在 100×100 的正規化座標系中繪製，
 * 呼叫端負責縮放，因此同一份定義能同時用於手機按鈕、大螢幕與後台縮圖。
 *
 * 挑選標準是「隔著三十公尺看得出來」：
 * 剪影要差很多（長／圓／細長／有翅），顏色要跨開色相，
 * 而且不能只靠顏色分辨——紅綠色盲的人也要認得出來，
 * 所以形狀本身就是主要線索。
 *
 * 四個分別是魚、兩棲、昆蟲、鳥，這是河邊最容易被認出來的四類生物。
 */

import type { OceanCreature } from "@/lib/creatures/ocean";

const LINE = 3.2;

function setup(ctx: CanvasRenderingContext2D, color: string): void {
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.lineWidth = LINE;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
}

/** 眼睛：白底黑瞳，讓每個生物都有生命感 */
function eye(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
): void {
  ctx.save();
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#12161f";
  ctx.beginPath();
  ctx.arc(x + r * 0.15, y, r * 0.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/** 鯉魚：身體長、尾巴分岔，是河裡最經典的剪影 */
const carp: OceanCreature = {
  key: "carp",
  name: "鯉魚",
  defaultColor: "#e0632f",
  draw(ctx, color) {
    setup(ctx, color);

    // 身體
    ctx.beginPath();
    ctx.ellipse(46, 50, 30, 17, 0, 0, Math.PI * 2);
    ctx.fill();

    // 尾鰭：分岔的兩片
    ctx.beginPath();
    ctx.moveTo(74, 50);
    ctx.lineTo(93, 33);
    ctx.lineTo(88, 50);
    ctx.lineTo(93, 67);
    ctx.closePath();
    ctx.fill();

    // 背鰭
    ctx.beginPath();
    ctx.moveTo(38, 34);
    ctx.quadraticCurveTo(48, 20, 60, 36);
    ctx.closePath();
    ctx.fill();

    // 腹鰭
    ctx.beginPath();
    ctx.moveTo(40, 65);
    ctx.quadraticCurveTo(46, 76, 56, 64);
    ctx.closePath();
    ctx.fill();

    // 鬍鬚：鯉魚跟一般的魚最好認的差別
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(19, 52);
    ctx.quadraticCurveTo(11, 58, 12, 66);
    ctx.moveTo(20, 56);
    ctx.quadraticCurveTo(14, 64, 17, 71);
    ctx.stroke();

    eye(ctx, 28, 45, 5);
  },
};

/** 青蛙：正面蹲坐，兩顆突出的眼睛 */
const frog: OceanCreature = {
  key: "frog",
  name: "青蛙",
  defaultColor: "#3aa04f",
  draw(ctx, color) {
    setup(ctx, color);

    // 後腿
    ctx.beginPath();
    ctx.ellipse(22, 70, 14, 9, -0.4, 0, Math.PI * 2);
    ctx.ellipse(78, 70, 14, 9, 0.4, 0, Math.PI * 2);
    ctx.fill();

    // 身體
    ctx.beginPath();
    ctx.ellipse(50, 60, 26, 22, 0, 0, Math.PI * 2);
    ctx.fill();

    // 頭
    ctx.beginPath();
    ctx.ellipse(50, 38, 24, 18, 0, 0, Math.PI * 2);
    ctx.fill();

    // 突出的眼窩
    ctx.beginPath();
    ctx.arc(36, 24, 9, 0, Math.PI * 2);
    ctx.arc(64, 24, 9, 0, Math.PI * 2);
    ctx.fill();

    eye(ctx, 36, 23, 5.5);
    eye(ctx, 64, 23, 5.5);

    // 嘴
    ctx.strokeStyle = "#12161f";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(50, 40, 12, 0.25 * Math.PI, 0.75 * Math.PI);
    ctx.stroke();

    // 前腳
    ctx.strokeStyle = color;
    ctx.lineWidth = LINE;
    ctx.beginPath();
    ctx.moveTo(38, 76);
    ctx.lineTo(33, 84);
    ctx.moveTo(62, 76);
    ctx.lineTo(67, 84);
    ctx.stroke();
  },
};

/** 蜻蜓：細長身體加四片翅膀，剪影跟其他三個完全不會混 */
const dragonfly: OceanCreature = {
  key: "dragonfly",
  name: "蜻蜓",
  defaultColor: "#2f7fd0",
  draw(ctx, color) {
    setup(ctx, color);

    // 翅膀：先畫，讓身體壓在上面
    ctx.save();
    ctx.globalAlpha = 0.45;
    ctx.beginPath();
    ctx.ellipse(34, 34, 22, 7, -0.35, 0, Math.PI * 2);
    ctx.ellipse(66, 34, 22, 7, 0.35, 0, Math.PI * 2);
    ctx.ellipse(34, 52, 20, 6, 0.3, 0, Math.PI * 2);
    ctx.ellipse(66, 52, 20, 6, -0.3, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // 身體：胸部到細長的腹部
    ctx.beginPath();
    ctx.ellipse(50, 40, 8, 11, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.lineWidth = 7;
    ctx.beginPath();
    ctx.moveTo(50, 48);
    ctx.lineTo(50, 86);
    ctx.stroke();

    // 腹部的節，讓它更像昆蟲
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    for (const y of [58, 66, 74]) {
      ctx.moveTo(46, y);
      ctx.lineTo(54, y);
    }
    ctx.stroke();

    // 頭
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(50, 23, 10, 0, Math.PI * 2);
    ctx.fill();

    eye(ctx, 44, 21, 4.5);
    eye(ctx, 56, 21, 4.5);
  },
};

/** 水鴨：浮在水面的側面剪影，圓身體加一個明顯的扁嘴 */
const duck: OceanCreature = {
  key: "duck",
  name: "水鴨",
  defaultColor: "#8a52c9",
  draw(ctx, color) {
    setup(ctx, color);

    // 身體
    ctx.beginPath();
    ctx.ellipse(52, 62, 30, 19, -0.08, 0, Math.PI * 2);
    ctx.fill();

    // 翹起的尾巴
    ctx.beginPath();
    ctx.moveTo(78, 56);
    ctx.lineTo(94, 44);
    ctx.lineTo(84, 64);
    ctx.closePath();
    ctx.fill();

    // 脖子
    ctx.lineWidth = 15;
    ctx.beginPath();
    ctx.moveTo(34, 56);
    ctx.quadraticCurveTo(26, 42, 32, 30);
    ctx.stroke();

    // 頭
    ctx.lineWidth = LINE;
    ctx.beginPath();
    ctx.arc(32, 26, 14, 0, Math.PI * 2);
    ctx.fill();

    // 扁嘴：認出鴨子的關鍵
    ctx.fillStyle = "#f2a93a";
    ctx.beginPath();
    ctx.ellipse(15, 29, 10, 5, -0.12, 0, Math.PI * 2);
    ctx.fill();

    // 翅膀
    ctx.fillStyle = "#ffffff";
    ctx.globalAlpha = 0.35;
    ctx.beginPath();
    ctx.ellipse(56, 60, 17, 10, -0.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;

    eye(ctx, 30, 23, 4.5);
  },
};

export const RIVER_CREATURES: readonly OceanCreature[] = [
  carp,
  frog,
  dragonfly,
  duck,
];
