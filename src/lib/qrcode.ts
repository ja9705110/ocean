import QRCode from "qrcode";

/**
 * QR Code 產生。
 *
 * 輸出 SVG 而非 PNG：待機畫面會把 QR Code 放大到整個投影幕，
 * 向量圖在任何尺寸都清晰，也不必為不同解析度各產一份。
 *
 * 容錯等級固定為 M：現場投影可能有梯形校正或反光，
 * L 級在鏡頭歪斜時辨識率明顯下降。
 */
export async function generateQrSvg(text: string): Promise<string> {
  return QRCode.toString(text, {
    type: "svg",
    errorCorrectionLevel: "M",
    margin: 0,
    color: {
      dark: "#04060c",
      light: "#ffffff",
    },
  });
}

/**
 * 同一組 QR Code 的 PNG 版本。
 *
 * SVG 貼不進 LINE、Messenger、簡報，也貼不進大部分的公告系統——
 * 主持人要把碼發給大家的時候，需要的是一張圖。
 *
 * 兩個地方跟螢幕版刻意不同：
 *
 * margin 給到 4 個模組（QR 規格的標準留白）。螢幕版是 0，
 * 因為外面那層白色卡片就是留白；但 PNG 會被貼到誰也不知道的背景上，
 * 沒有自己的留白就掃不到。
 *
 * 預設 1024px 是給「印出來貼在桌上」用的。太小的圖被 LINE 二次壓縮
 * 之後模組邊緣會糊掉，1024 有足夠的餘裕。
 */
export async function generateQrPngDataUrl(
  text: string,
  width = 1024,
): Promise<string> {
  return QRCode.toDataURL(text, {
    type: "image/png",
    errorCorrectionLevel: "M",
    margin: 4,
    width,
    color: {
      dark: "#04060c",
      light: "#ffffff",
    },
  });
}

/** 參與者掃碼後前往的網址 */
export function joinUrl(origin: string, code: string): string {
  return `${origin}/join/${code}`;
}

/**
 * 上傳糖霜餅乾照片的網址。
 *
 * 跟報到用同一組活動代碼，只是換一個路徑——現場不必再記第二組代碼，
 * 印一張 QR 放在彩繪桌上就好。
 */
export function cookieUploadUrl(origin: string, code: string): string {
  return `${origin}/cookie/${code}`;
}
