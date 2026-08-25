/**
 * 餅乾輸送帶（C14）。
 *
 * 大家彩繪的餅乾照片密鋪在整條河道裡，跟著水流一直走。
 * 每個人的餅乾就是河的一段。
 *
 * 為什麼是輸送帶而不是「拼成流嚮25」：算過了。中文字筆畫細，
 * 兩百到三百五十張照片每一筆畫分不到一格，遠看讀不出是字；
 * 要拼到好讀需要兩千四百張。而且把字放大沒有用——格子是
 * 「用 N 張鋪滿著墨面積」算出來的，字變大格子跟著變大，比例不變。
 *
 * 密鋪的座標系是河道自己的：沿河的位置（弧長）與離中心線的距離。
 * 這樣不管河怎麼彎，餅乾都是貼著水流排的，而不是貼著螢幕排的。
 *
 * 三個要成立的性質：
 *
 * 1. 迴圈看不到接縫。輸送帶的總長度必須「剛好等於河道全長」，
 *    所以格數是由河道長度除以格距算出來的整數，不是使用者直接給的。
 *    差一點點就會在某個位置看到一條縫，而那條縫會一直在同一個地方
 *    重複出現，非常明顯。
 *
 * 2. 永遠鋪滿。人少的時候照片會重複使用，河道不會開天窗——
 *    現場看到的是一條完整的河，不是一條有破洞的河。
 *
 * 3. 每個人的餅乾固定在自己的格子上。格子會繞回來，但不會換人，
 *    否則沒有人找得到自己的那一張。
 *
 * 沒有 DOM：這一段的數學要能直接在 Node 裡驗證。
 */

/** 餅乾的長寬比（寬 : 高）。實際量出來大約 1 : 1.4 的直式長方形。 */
export const COOKIE_ASPECT = 1 / 1.4;

export interface CookieBeltInput {
  /** 河道的全長（像素，含畫面外的延伸段） */
  readonly pathLength: number;
  /** 河道半寬（像素）：餅乾會鋪滿正負這個範圍 */
  readonly halfWidth: number;
  /** 一格的寬度（像素）。高度由長寬比推算。 */
  readonly tileWidth: number;
  /** 實際有幾張照片 */
  readonly photoCount: number;
}

export interface CookieBelt {
  /** 橫向幾排 */
  readonly rows: number;
  /** 沿河幾格 */
  readonly columns: number;
  /** 總格數 */
  readonly slots: number;
  /** 沿河方向的格距（像素）。乘上格數剛好等於河道全長。 */
  readonly spacing: number;
  /** 一格的尺寸 */
  readonly tileWidth: number;
  readonly tileHeight: number;
  /** 每張照片平均被用到幾次。1 表示剛好一人一格。 */
  readonly repeats: number;
}

/** 排數與格數的上限：再多就是把三千個貼圖丟給投影機那台機器 */
export const MAX_ROWS = 12;
export const MAX_SLOTS = 1600;

/**
 * 算出輸送帶的格局。
 *
 * 格距刻意由「河道全長 ÷ 格數」反推，而不是直接用格高：
 * 只有整除才不會在迴圈的接點留下一條縫。反推出來的格距會比格高
 * 略大或略小一點點，那個差在畫面上看不出來，接縫看得出來。
 */
export function planCookieBelt(input: CookieBeltInput): CookieBelt {
  const tileWidth = Math.max(8, input.tileWidth);
  const tileHeight = tileWidth / COOKIE_ASPECT;

  const rows = Math.max(
    1,
    Math.min(MAX_ROWS, Math.round((input.halfWidth * 2) / tileWidth)),
  );

  const rawColumns = Math.max(1, Math.round(input.pathLength / tileHeight));
  const columns = Math.max(
    1,
    Math.min(rawColumns, Math.floor(MAX_SLOTS / rows)),
  );

  const slots = rows * columns;

  return {
    rows,
    columns,
    slots,
    // 整除：接縫的位置剛好等於起點，也就是畫面外
    spacing: input.pathLength / columns,
    tileWidth,
    tileHeight,
    repeats: input.photoCount > 0 ? slots / input.photoCount : 0,
  };
}

export interface CookieSlot {
  /** 沿河的位置，0~1（可以直接餵給河道的取樣函式） */
  readonly t: number;
  /** 離中心線的距離（像素），負是一邊、正是另一邊 */
  readonly lateral: number;
  /** 這一格要放第幾張照片 */
  readonly photoIndex: number;
}

/**
 * 算出某一刻每一格在哪裡。
 *
 * scroll 是輸送帶目前推進了多少（像素）。它會一直增加，
 * 這裡自己取餘數繞回來——呼叫端不必處理迴繞，也就不會在某一幀
 * 因為忘了取餘而讓整條河跳一下。
 */
export function cookieSlots(
  belt: CookieBelt,
  scroll: number,
  photoCount: number,
): readonly CookieSlot[] {
  const out: CookieSlot[] = [];
  if (photoCount <= 0) {
    return out;
  }

  const beltLength = belt.spacing * belt.columns;
  // 排跟排之間平均分佈，而且不貼著邊：貼邊的那一排會有一半在河道外面
  const rowStep = belt.rows > 1 ? 1 / (belt.rows - 1) : 0.5;

  for (let row = 0; row < belt.rows; row += 1) {
    const across = belt.rows > 1 ? row * rowStep * 2 - 1 : 0;

    for (let column = 0; column < belt.columns; column += 1) {
      // 隔排錯開半格：磚牆式的排法，格子之間才不會排出一條直的縫
      const stagger = row % 2 === 0 ? 0 : belt.spacing * 0.5;
      const along =
        (((column * belt.spacing + stagger + scroll) % beltLength) +
          beltLength) %
        beltLength;

      out.push({
        t: along / beltLength,
        lateral: across,
        // 每一格固定對應同一張照片：格子會繞回來，但不會換人，
        // 否則沒有人找得到自己的那一張
        photoIndex: (row * belt.columns + column) % photoCount,
      });
    }
  }

  return out;
}

/**
 * 輸送帶推進的速度（像素／秒）。
 *
 * 用「幾秒鐘走完一整圈」來表達而不是直接給像素速度：
 * 河道的長度會隨著設定變，給像素速度的話，河一改長就變慢，
 * 而那是主持人不會預期的連動。
 */
export function beltSpeed(pathLength: number, loopSeconds: number): number {
  return pathLength / Math.max(1, loopSeconds);
}
