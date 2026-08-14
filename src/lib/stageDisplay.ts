/**
 * 大螢幕要顯示哪一張圖。
 *
 * both 是「彩繪配簽名」——彩繪在上、簽名在下合成成一張，
 * 而不是兩個獨立的東西在河上各游各的。
 *
 * 這一份刻意獨立成一個沒有 "use client" 的模組：
 * Server Component（活動查詢）與瀏覽器端都要用到它，
 * 放在標了 "use client" 的檔案裡，伺服器端呼叫會直接爆
 * 「Attempted to call ... from the server but ... is on the client」。
 */
export type StageDisplay = "signature" | "artwork" | "both";

export function parseStageDisplay(value: unknown): StageDisplay {
  return value === "artwork" || value === "both" ? value : "signature";
}

/**
 * 依主持人設定的顯示方式，決定一位參與者要投影哪一張圖。
 *
 * 這個對應表刻意放在資料層而不是渲染層：渲染層不知道「簽名」是什麼，
 * 只知道一個角色可以由上下兩張圖組成（CharacterData.secondaryImageUrl）。
 *
 * 只簽名沒彩繪的人，image_path 在資料庫端就已經指向簽名，
 * 所以 artwork 模式對他們仍然有東西可以顯示——現場一定會有人
 * 只簽了名就入座，那些人不能因為主持人切到彩繪模式就整個消失。
 */
export function pickStageImages(
  row: {
    readonly image_path: string;
    readonly signature_path?: string | null;
  },
  display: StageDisplay,
): { readonly primary: string; readonly secondary: string | null } {
  const artwork = row.image_path;
  const signature = row.signature_path ?? null;

  if (display === "signature") {
    return { primary: signature ?? artwork, secondary: null };
  }
  if (display === "artwork") {
    return { primary: artwork, secondary: null };
  }
  // both：彩繪在上、簽名在下。兩者相同（只簽名的人）時不重複疊一次
  if (signature === null || signature === artwork) {
    return { primary: artwork, secondary: null };
  }
  return { primary: artwork, secondary: signature };
}
