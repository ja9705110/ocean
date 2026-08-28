"use client";

import { generateQrPngDataUrl, playUrl } from "@/lib/qrcode";
import type { Team } from "@/lib/game/types";

/**
 * 把一張桌卡畫成 PNG（C19）。
 *
 * 為什麼是自己在 canvas 上畫，而不是把畫面上的那張卡截圖：
 * 截圖要多裝一套 DOM 轉圖的函式庫，而且轉出來的字會跟著螢幕的
 * 縮放與字型設定跑。桌卡是要印出來擺在桌上的東西，一張一張都得
 * 一樣大、一樣清楚。這裡的每一個尺寸都是固定的像素，印幾次都一樣。
 *
 * 白底黑字：印表機吃的是紙，不是投影幕。螢幕上那張深色的預覽好看，
 * 但用碳粉印出來會是一整片黑。
 */

/** 成品尺寸。約等於 300dpi 的 A6，印出來對折立在桌上剛好。 */
const WIDTH = 1240;
const HEIGHT = 1748;

const QR_SIZE = 760;

/** 中文字型：印出來要是黑體，不要變成襯線或方框 */
const SANS =
  '"Noto Sans TC", "PingFang TC", "Microsoft JhengHei", sans-serif';

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("QR_LOAD_FAILED"));
    img.src = src;
  });
}

export interface TableCardImage {
  readonly team: Team;
  readonly blob: Blob;
  readonly fileName: string;
}

/**
 * 畫出一張桌卡。
 *
 * origin 用來組 QR 的網址；實際指向哪裡由 playUrl 決定——
 * 設了 NEXT_PUBLIC_SITE_URL 就一律指向正式站，不會印到預覽網址上。
 */
export async function renderTableCard(
  team: Team,
  sessionName: string,
  origin: string,
): Promise<TableCardImage> {
  const canvas = document.createElement("canvas");
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("CANVAS_UNAVAILABLE");
  }

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  // 桌子的顏色只用在框線與桌號上。整張鋪色印起來太耗碳粉，
  // 而且淺色的桌號壓在深色底上會糊掉。
  ctx.strokeStyle = team.color;
  ctx.lineWidth = 10;
  ctx.strokeRect(40, 40, WIDTH - 80, HEIGHT - 80);

  ctx.textAlign = "center";

  ctx.fillStyle = "#8a8a8a";
  ctx.font = `36px ${SANS}`;
  ctx.fillText(sessionName, WIDTH / 2, 160);

  ctx.fillStyle = team.color;
  ctx.font = `bold 150px ${SANS}`;
  ctx.fillText(`第 ${team.tableNo} 桌`, WIDTH / 2, 330);

  // 隊名沒改過時就等於桌號，再印一次只是浪費版面
  let qrTop = 430;
  if (team.name !== `第 ${team.tableNo} 桌`) {
    ctx.fillStyle = "#3a3a3a";
    ctx.font = `56px ${SANS}`;
    ctx.fillText(team.name, WIDTH / 2, 420);
    qrTop = 500;
  }

  const qr = await loadImage(
    await generateQrPngDataUrl(playUrl(origin, team.joinCode), QR_SIZE),
  );
  ctx.drawImage(qr, (WIDTH - QR_SIZE) / 2, qrTop, QR_SIZE, QR_SIZE);

  // 加入碼不印。手機上沒有可以打代碼的地方，印出來只會讓人
  // 拿著紙找那個輸入框——掃碼是唯一的入口，就只講掃碼。
  ctx.fillStyle = "#3a3a3a";
  ctx.font = `52px ${SANS}`;
  ctx.fillText("掃我，加入這一桌", WIDTH / 2, qrTop + QR_SIZE + 110);

  ctx.fillStyle = "#8a8a8a";
  ctx.font = `34px ${SANS}`;
  ctx.fillText("用手機相機對準就可以了", WIDTH / 2, qrTop + QR_SIZE + 175);

  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, "image/png");
  });
  if (!blob) {
    throw new Error("ENCODE_FAILED");
  }

  return {
    team,
    blob,
    fileName: `桌卡-${String(team.tableNo).padStart(2, "0")}-${team.name}.png`,
  };
}

/** 把一張畫好的桌卡存成檔案 */
export function downloadTableCard(card: TableCardImage): void {
  const url = URL.createObjectURL(card.blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = card.fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // 立刻撤銷會讓部分瀏覽器來不及開始下載
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/**
 * 連續下載多張時每張之間的間隔。
 *
 * 瀏覽器會把「短時間內連續好幾個下載」當成可疑行為擋掉。
 * 三十桌就是三十個檔案，中間不留空隙的話後面幾張會靜靜地消失，
 * 而使用者只會發現資料夾裡少了幾張。
 */
export const DOWNLOAD_GAP_MS = 350;
