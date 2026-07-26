/**
 * 海洋生物範本。
 *
 * 參與者選一個「我覺得我是海洋中的…」，畫布上就先畫出那個生物的樣態，
 * 再由參與者加上表情、裝飾或自己的照片。
 *
 * 每個範本在 100×100 的正規化座標系中繪製，呼叫端負責縮放，
 * 因此同一份定義能同時用於畫布、選擇器縮圖與匯出。
 *
 * 刻意用程式繪製而非圖檔：向量在任何解析度都清晰，
 * 換顏色只是換參數，也不會多出要下載的資源。
 */

export interface OceanCreature {
  readonly key: string;
  readonly name: string;
  /** 選擇器中的預設配色 */
  readonly defaultColor: string;
  /** 在 100×100 座標系中繪製 */
  draw(ctx: CanvasRenderingContext2D, color: string): void;
}

/** 統一的線條粗細（100×100 座標系內） */
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
  ctx.arc(x + r * 0.18, y, r * 0.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

const fish: OceanCreature = {
  key: "fish",
  name: "魚",
  defaultColor: "#4fc3d9",
  draw(ctx, color) {
    setup(ctx, color);
    ctx.beginPath();
    ctx.ellipse(46, 52, 30, 21, 0, 0, Math.PI * 2);
    ctx.fill();
    // 尾鰭
    ctx.beginPath();
    ctx.moveTo(73, 52);
    ctx.lineTo(93, 34);
    ctx.lineTo(93, 70);
    ctx.closePath();
    ctx.fill();
    // 背鰭
    ctx.beginPath();
    ctx.moveTo(40, 32);
    ctx.quadraticCurveTo(48, 18, 60, 34);
    ctx.closePath();
    ctx.fill();
    eye(ctx, 30, 46, 5);
  },
};

const whale: OceanCreature = {
  key: "whale",
  name: "鯨魚",
  defaultColor: "#5f8fd0",
  draw(ctx, color) {
    setup(ctx, color);
    ctx.beginPath();
    ctx.moveTo(14, 56);
    ctx.bezierCurveTo(14, 30, 52, 26, 68, 46);
    ctx.bezierCurveTo(74, 54, 76, 62, 74, 70);
    ctx.bezierCurveTo(54, 78, 24, 74, 14, 56);
    ctx.closePath();
    ctx.fill();
    // 尾鰭
    ctx.beginPath();
    ctx.moveTo(73, 60);
    ctx.quadraticCurveTo(88, 44, 94, 40);
    ctx.quadraticCurveTo(92, 58, 86, 64);
    ctx.quadraticCurveTo(94, 70, 92, 82);
    ctx.quadraticCurveTo(80, 76, 73, 68);
    ctx.closePath();
    ctx.fill();
    // 噴水
    ctx.beginPath();
    ctx.moveTo(34, 30);
    ctx.quadraticCurveTo(30, 18, 36, 12);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(38, 30);
    ctx.quadraticCurveTo(44, 20, 48, 16);
    ctx.stroke();
    eye(ctx, 26, 50, 4.6);
  },
};

const shark: OceanCreature = {
  key: "shark",
  name: "鯊魚",
  defaultColor: "#7f8ca3",
  draw(ctx, color) {
    setup(ctx, color);
    ctx.beginPath();
    ctx.moveTo(10, 54);
    ctx.bezierCurveTo(26, 34, 60, 34, 76, 50);
    ctx.bezierCurveTo(62, 68, 28, 70, 10, 54);
    ctx.closePath();
    ctx.fill();
    // 背鰭
    ctx.beginPath();
    ctx.moveTo(40, 38);
    ctx.lineTo(48, 16);
    ctx.lineTo(60, 42);
    ctx.closePath();
    ctx.fill();
    // 腹鰭
    ctx.beginPath();
    ctx.moveTo(38, 64);
    ctx.lineTo(34, 80);
    ctx.lineTo(52, 66);
    ctx.closePath();
    ctx.fill();
    // 尾鰭
    ctx.beginPath();
    ctx.moveTo(75, 50);
    ctx.lineTo(94, 30);
    ctx.lineTo(90, 56);
    ctx.lineTo(94, 74);
    ctx.closePath();
    ctx.fill();
    eye(ctx, 24, 50, 4);
  },
};

const octopus: OceanCreature = {
  key: "octopus",
  name: "章魚",
  defaultColor: "#c06fd0",
  draw(ctx, color) {
    setup(ctx, color);
    // 圓潤飽滿的頭：與水母的傘狀做出區隔
    ctx.beginPath();
    ctx.ellipse(50, 38, 29, 27, 0, 0, Math.PI * 2);
    ctx.fill();
    // 粗而捲的腕足
    ctx.lineWidth = 9;
    for (let i = 0; i < 5; i += 1) {
      const x = 26 + i * 12;
      const dir = i % 2 === 0 ? 1 : -1;
      ctx.beginPath();
      ctx.moveTo(x, 56);
      ctx.bezierCurveTo(
        x + dir * 10,
        70,
        x - dir * 12,
        80,
        x + dir * 9,
        89,
      );
      ctx.stroke();
    }
    eye(ctx, 40, 34, 6);
    eye(ctx, 60, 34, 6);
  },
};

const jellyfish: OceanCreature = {
  key: "jellyfish",
  name: "水母",
  defaultColor: "#f083b0",
  draw(ctx, color) {
    setup(ctx, color);
    // 半圓傘蓋，下緣做扇貝狀波浪——這是與章魚圓頭最明顯的差異
    ctx.beginPath();
    ctx.ellipse(50, 40, 28, 26, 0, Math.PI, 0);
    for (let i = 0; i < 4; i += 1) {
      const x = 78 - i * 14;
      ctx.quadraticCurveTo(x - 7, 51, x - 14, 40);
    }
    ctx.closePath();
    ctx.fill();
    // 細長飄動的觸鬚
    ctx.lineWidth = 3;
    for (let i = 0; i < 6; i += 1) {
      const x = 29 + i * 8.5;
      const dir = i % 2 === 0 ? 1 : -1;
      ctx.beginPath();
      ctx.moveTo(x, 46);
      ctx.bezierCurveTo(x + dir * 7, 62, x - dir * 7, 76, x + dir * 4, 92);
      ctx.stroke();
    }
    eye(ctx, 42, 32, 4.6);
    eye(ctx, 58, 32, 4.6);
  },
};

const turtle: OceanCreature = {
  key: "turtle",
  name: "海龜",
  defaultColor: "#4caf6d",
  draw(ctx, color) {
    setup(ctx, color);
    // 四肢
    for (const [x, y, rot] of [
      [24, 34, -0.9],
      [76, 34, 0.9],
      [26, 70, -2.3],
      [74, 70, 2.3],
    ] as const) {
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(rot);
      ctx.beginPath();
      ctx.ellipse(0, 0, 13, 7, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    // 頭
    ctx.beginPath();
    ctx.ellipse(50, 20, 12, 11, 0, 0, Math.PI * 2);
    ctx.fill();
    // 龜殼
    ctx.beginPath();
    ctx.ellipse(50, 54, 28, 26, 0, 0, Math.PI * 2);
    ctx.fill();
    // 殼上的紋路
    ctx.save();
    ctx.strokeStyle = "rgba(0,0,0,0.28)";
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    ctx.ellipse(50, 54, 13, 12, 0, 0, Math.PI * 2);
    ctx.stroke();
    for (let i = 0; i < 6; i += 1) {
      const a = (Math.PI * 2 * i) / 6 + 0.3;
      ctx.beginPath();
      ctx.moveTo(50 + Math.cos(a) * 13, 54 + Math.sin(a) * 12);
      ctx.lineTo(50 + Math.cos(a) * 27, 54 + Math.sin(a) * 25);
      ctx.stroke();
    }
    ctx.restore();
    eye(ctx, 45, 18, 3.4);
    eye(ctx, 55, 18, 3.4);
  },
};

const starfish: OceanCreature = {
  key: "starfish",
  name: "海星",
  defaultColor: "#f2963a",
  draw(ctx, color) {
    setup(ctx, color);
    ctx.lineWidth = 12;
    // 外圈與內圈半徑交錯，才是星形；只連外圈的話會變成五邊形
    const outer = 34;
    const inner = 15;
    ctx.beginPath();
    for (let i = 0; i < 10; i += 1) {
      const a = (Math.PI * i) / 5 - Math.PI / 2;
      const r = i % 2 === 0 ? outer : inner;
      const x = 50 + Math.cos(a) * r;
      const y = 52 + Math.sin(a) * r;
      if (i === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.closePath();
    // 先描粗線再填色，尖角自然變圓潤
    ctx.stroke();
    ctx.fill();
    eye(ctx, 43, 50, 4.4);
    eye(ctx, 57, 50, 4.4);
  },
};

const crab: OceanCreature = {
  key: "crab",
  name: "螃蟹",
  defaultColor: "#e8574c",
  draw(ctx, color) {
    setup(ctx, color);
    // 腳
    ctx.lineWidth = 4.6;
    for (let i = 0; i < 3; i += 1) {
      const y = 56 + i * 9;
      ctx.beginPath();
      ctx.moveTo(30, y);
      ctx.quadraticCurveTo(16, y + 4, 12, y + 12);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(70, y);
      ctx.quadraticCurveTo(84, y + 4, 88, y + 12);
      ctx.stroke();
    }
    // 螯
    for (const dir of [-1, 1] as const) {
      ctx.save();
      ctx.translate(50 + dir * 34, 34);
      ctx.rotate(dir * 0.5);
      ctx.beginPath();
      ctx.ellipse(0, 0, 12, 9, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.save();
      ctx.globalCompositeOperation = "destination-out";
      ctx.beginPath();
      ctx.moveTo(dir * 2, -2);
      ctx.lineTo(dir * 16, -8);
      ctx.lineTo(dir * 16, 2);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
      ctx.restore();
    }
    // 身體
    ctx.beginPath();
    ctx.ellipse(50, 54, 26, 20, 0, 0, Math.PI * 2);
    ctx.fill();
    eye(ctx, 42, 46, 5);
    eye(ctx, 58, 46, 5);
  },
};

const seahorse: OceanCreature = {
  key: "seahorse",
  name: "海馬",
  defaultColor: "#f4d03f",
  draw(ctx, color) {
    setup(ctx, color);
    ctx.lineWidth = 14;
    ctx.beginPath();
    ctx.moveTo(56, 18);
    ctx.bezierCurveTo(38, 24, 40, 44, 52, 54);
    ctx.bezierCurveTo(64, 64, 60, 78, 46, 80);
    ctx.bezierCurveTo(38, 81, 36, 74, 42, 72);
    ctx.stroke();
    // 吻部
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.moveTo(58, 20);
    ctx.lineTo(76, 26);
    ctx.stroke();
    // 背鰭
    ctx.beginPath();
    ctx.moveTo(44, 34);
    ctx.quadraticCurveTo(30, 44, 40, 56);
    ctx.stroke();
    // 頭冠
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(54, 12);
    ctx.lineTo(50, 4);
    ctx.stroke();
    eye(ctx, 60, 22, 4.2);
  },
};

const pufferfish: OceanCreature = {
  key: "pufferfish",
  name: "河豚",
  defaultColor: "#ffb066",
  draw(ctx, color) {
    setup(ctx, color);
    // 刺
    ctx.lineWidth = 4;
    for (let i = 0; i < 14; i += 1) {
      const a = (Math.PI * 2 * i) / 14;
      ctx.beginPath();
      ctx.moveTo(48 + Math.cos(a) * 26, 52 + Math.sin(a) * 26);
      ctx.lineTo(48 + Math.cos(a) * 36, 52 + Math.sin(a) * 36);
      ctx.stroke();
    }
    // 尾
    ctx.beginPath();
    ctx.moveTo(72, 52);
    ctx.lineTo(92, 40);
    ctx.lineTo(92, 64);
    ctx.closePath();
    ctx.fill();
    // 身體
    ctx.beginPath();
    ctx.arc(48, 52, 27, 0, Math.PI * 2);
    ctx.fill();
    eye(ctx, 36, 44, 5.4);
    eye(ctx, 56, 44, 5.4);
    // 嘴
    ctx.save();
    ctx.strokeStyle = "rgba(0,0,0,0.4)";
    ctx.lineWidth = 2.6;
    ctx.beginPath();
    ctx.arc(46, 60, 7, 0.2, Math.PI - 0.2);
    ctx.stroke();
    ctx.restore();
  },
};

const seaweed: OceanCreature = {
  key: "seaweed",
  name: "海草",
  defaultColor: "#7ce0b8",
  draw(ctx, color) {
    setup(ctx, color);
    ctx.lineWidth = 11;
    for (const [x, sway] of [
      [34, -1],
      [50, 1],
      [66, -1],
    ] as const) {
      ctx.beginPath();
      ctx.moveTo(x, 92);
      ctx.bezierCurveTo(
        x + sway * 14,
        72,
        x - sway * 12,
        48,
        x + sway * 6,
        22,
      );
      ctx.stroke();
    }
    eye(ctx, 46, 34, 4.6);
    eye(ctx, 58, 30, 4.6);
  },
};

export const OCEAN_CREATURES: readonly OceanCreature[] = [
  fish,
  whale,
  shark,
  octopus,
  jellyfish,
  turtle,
  starfish,
  crab,
  seahorse,
  pufferfish,
  seaweed,
];

export function findCreature(key: string): OceanCreature | undefined {
  return OCEAN_CREATURES.find((creature) => creature.key === key);
}

/**
 * 把範本畫進一張透明畫布，供 DrawingCanvas 當底層使用。
 * size 為輸出畫布的邊長（像素）。
 */
export function renderCreatureLayer(
  creature: OceanCreature,
  color: string,
  size: number,
): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;

  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return canvas;
  }

  ctx.scale(size / 100, size / 100);
  creature.draw(ctx, color);
  return canvas;
}
