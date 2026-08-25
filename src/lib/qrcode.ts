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
