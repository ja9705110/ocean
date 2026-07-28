/**
 * 要被救的貓。
 *
 * 與海洋生物同一套約定：在 100×100 的正規化座標系中繪製，
 * 呼叫端負責縮放，因此手機的預覽與大螢幕可以共用同一份定義。
 *
 * 牠站在一塊漂流木上，耳朵往後壓、尾巴翹著——
 * 要讓人一眼看出「這隻貓有麻煩」，救援才有意義。
 */

const LINE = 3.2;

export function drawCat(
  ctx: CanvasRenderingContext2D,
  color = "#f2c185",
  raftColor = "#8a6a4a",
): void {
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.lineWidth = LINE;

  // 漂流木
  ctx.fillStyle = raftColor;
  ctx.beginPath();
  ctx.roundRect(14, 74, 72, 12, 6);
  ctx.fill();

  ctx.fillStyle = color;
  ctx.strokeStyle = color;

  // 身體
  ctx.beginPath();
  ctx.ellipse(50, 60, 20, 15, 0, 0, Math.PI * 2);
  ctx.fill();

  // 尾巴：翹起來的鉤狀，是「緊張」最省事的表達
  ctx.beginPath();
  ctx.moveTo(69, 60);
  ctx.quadraticCurveTo(84, 56, 80, 40);
  ctx.stroke();

  // 頭
  ctx.beginPath();
  ctx.arc(46, 38, 17, 0, Math.PI * 2);
  ctx.fill();

  // 耳朵：往後壓
  ctx.beginPath();
  ctx.moveTo(34, 28);
  ctx.lineTo(28, 14);
  ctx.lineTo(43, 23);
  ctx.closePath();
  ctx.fill();

  ctx.beginPath();
  ctx.moveTo(58, 28);
  ctx.lineTo(64, 14);
  ctx.lineTo(49, 23);
  ctx.closePath();
  ctx.fill();

  // 眼睛
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.arc(40, 37, 4.6, 0, Math.PI * 2);
  ctx.arc(53, 37, 4.6, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = "#12161f";
  ctx.beginPath();
  ctx.arc(40, 37, 2.3, 0, Math.PI * 2);
  ctx.arc(53, 37, 2.3, 0, Math.PI * 2);
  ctx.fill();

  // 鼻子與嘴
  ctx.strokeStyle = "#12161f";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(46.5, 44);
  ctx.lineTo(46.5, 47);
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(43.5, 48, 3, 0, Math.PI);
  ctx.arc(49.5, 48, 3, 0, Math.PI);
  ctx.stroke();

  // 鬍鬚
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.6;
  for (const [y, spread] of [
    [43, 0],
    [47, 3],
  ] as const) {
    ctx.beginPath();
    ctx.moveTo(34, y);
    ctx.lineTo(20, y - 3 + spread);
    ctx.moveTo(59, y);
    ctx.lineTo(73, y - 3 + spread);
    ctx.stroke();
  }

  ctx.restore();
}
