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

/**
 * QR Code 要指向的正式網域。
 *
 * 原本每個地方都直接用 window.location.origin，這在活動當天會出事：
 * 桌卡是活動前印的，如果那時候後台開的是 Vercel 的預覽網址
 * （每推一次分支就產生一個 ...-git-xxx.vercel.app），或是開發用的
 * localhost，印出來的 QR 就指到那個網址。
 *
 * 預覽網址預設是受保護的——掃進去會看到「請登入」，
 * 而不是入座畫面。三百個人拿著手機站在那裡的時候才發現，來不及了。
 *
 * 設了 NEXT_PUBLIC_SITE_URL 就一律用它，不管後台現在開在哪。
 * 沒設就退回目前的網域，跟以前的行為一樣。
 */
export function publicOrigin(fallback: string): string {
  const configured = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (!configured) {
    return fallback;
  }
  // 結尾的斜線會讓網址變成 https://example.com//join/XXX
  return configured.replace(/\/+$/, "");
}

/** 參與者掃碼後前往的網址 */
export function joinUrl(origin: string, code: string): string {
  return `${publicOrigin(origin)}/join/${code}`;
}

/** 桌卡上的入座網址：掃到哪張就進哪一桌 */
export function playUrl(origin: string, joinCode: string): string {
  return `${publicOrigin(origin)}/play/${joinCode}`;
}

/**
 * 上傳糖霜餅乾照片的網址。
 *
 * 跟報到用同一組活動代碼，只是換一個路徑——現場不必再記第二組代碼，
 * 印一張 QR 放在彩繪桌上就好。
 */
export function cookieUploadUrl(origin: string, code: string): string {
  return `${publicOrigin(origin)}/cookie/${code}`;
}
