/**
 * 餅乾照片牆（C30）。
 *
 * 原本的輸送帶是把照片密鋪在河道裡跟著水流走。實際投出來太密、
 * 又一直在動，看久了不舒服，也沒有人找得到自己的那一張。
 *
 * 這一版改成一面牆：全部的照片同時排在畫面上，不流動。
 * 有人上傳就多一格，整面牆重新排一次——像頒獎典禮最後把所有人
 * 一次放上去的那個畫面。
 *
 * 三件事決定了這裡的數學：
 *
 * 1. 格子要盡可能大。同樣的照片數量，直的排跟橫的排差很多：
 *    十六張排成 4×4 的格子，比排成 8×2 大了一倍以上。
 *    所以欄數不是給定的，是試過每一種欄數之後挑格子最大的那一種。
 *
 * 2. 小於某個尺寸就不要再擠了。兩百八十張全部塞進 16:9 的畫面裡，
 *    一格只剩下五十像素——投影出來就是一片馬賽克，那正是要修掉的問題。
 *    所以有一個最小尺寸，塞不下就分頁輪播，而不是繼續縮小。
 *
 * 3. 一格是「照片＋名字」。名字要不要顯示會改變格子的長寬比，
 *    而長寬比會改變最佳欄數。兩者一起算，不能事後再補一條字上去。
 *
 * 沒有 DOM：這一段的數學要能直接在 Node 裡驗證。
 */

import { COOKIE_ASPECT } from "@/lib/stage/cookieBelt";

export interface CookieWallInput {
  /** 可用的畫面區域（像素），已經扣掉標題與邊界 */
  readonly width: number;
  readonly height: number;
  readonly count: number;
  /**
   * 格子之間的間距，以「格寬的幾倍」表示（0.12 = 格寬的 12%）。
   *
   * 不用絕對像素：同一個 20px 的間距，在三張照片的時候看不出來，
   * 在兩百八十張的時候會吃掉整整四分之一的畫面寬度，
   * 逼得格子小到必須分頁。比例才是「看起來密不密」真正對應的量。
   */
  readonly gapRatio: number;
  /** 格子的最小寬度。低於這個就分頁，不再縮小。 */
  readonly minTile: number;
  /** 格子的最大寬度。人少的時候不要把三張照片撐滿整個投影幕。 */
  readonly maxTile: number;
  /** 名字那一條的高度佔格寬的幾倍；不顯示名字時給 0 */
  readonly labelRatio: number;
}

export interface CookieWallPlan {
  readonly width: number;
  readonly height: number;
  readonly columns: number;
  readonly rows: number;
  /** 照片本身的尺寸 */
  readonly tileWidth: number;
  readonly tileHeight: number;
  /** 照片加上名字之後，一整格佔的高度 */
  readonly cellHeight: number;
  /** 換算出來的實際間距（像素） */
  readonly gap: number;
  /** 一頁放幾張。等於 count 就是「全部同時在畫面上」。 */
  readonly perPage: number;
  readonly pages: number;
}

export interface CookieWallCell {
  /** 在整份清單裡的位置 */
  readonly index: number;
  readonly x: number;
  readonly y: number;
}

export const EMPTY_WALL_PLAN: CookieWallPlan = {
  width: 0,
  height: 0,
  columns: 0,
  rows: 0,
  tileWidth: 0,
  tileHeight: 0,
  cellHeight: 0,
  gap: 0,
  perPage: 0,
  pages: 0,
};

/**
 * 一整格的寬高比（寬 ÷ 高）。
 *
 * 照片是 1:1.4 的直式長方形，名字再往下接一條。
 */
export function cellRatio(labelRatio: number): number {
  return 1 / (1 / COOKIE_ASPECT + Math.max(0, labelRatio));
}

/**
 * 在給定的框裡塞 count 格，回傳格子最大的那一種排法。
 *
 * 逐一試每一種欄數而不是用公式推：格子受寬與高兩邊夾擊，
 * 最佳解落在哪一邊由 count 與框的比例共同決定，
 * 而 count 最多也就三百，全部試一遍是幾百次乘除。
 */
function fitGrid(
  width: number,
  height: number,
  count: number,
  gapRatio: number,
  ratio: number,
): { columns: number; rows: number; tileWidth: number } {
  let best = { columns: 1, rows: count, tileWidth: 0 };

  for (let columns = 1; columns <= count; columns += 1) {
    const rows = Math.ceil(count / columns);
    // 間距是格寬的倍數，所以格寬同時出現在等式兩邊，直接解出來：
    //   columns * t + (columns - 1) * gapRatio * t = width
    const byWidth = width / (columns + gapRatio * (columns - 1));
    const byHeight = height / (rows / ratio + gapRatio * (rows - 1));
    const tileWidth = Math.min(byWidth, byHeight);

    if (tileWidth > best.tileWidth) {
      best = { columns, rows, tileWidth };
    }
  }

  return best;
}

/** 算出這面牆要怎麼排 */
export function planCookieWall(input: CookieWallInput): CookieWallPlan {
  const count = Math.max(0, Math.floor(input.count));
  const gapRatio = Math.max(0, input.gapRatio);
  const ratio = cellRatio(input.labelRatio);
  const minTile = Math.max(1, input.minTile);
  const maxTile = Math.max(minTile, input.maxTile);

  if (count === 0 || input.width <= 0 || input.height <= 0) {
    return { ...EMPTY_WALL_PLAN, width: input.width, height: input.height };
  }

  const shape = (
    columns: number,
    rows: number,
    rawTile: number,
    perPage: number,
  ): CookieWallPlan => {
    const tileWidth = Math.max(1, Math.min(rawTile, maxTile));
    return {
      width: input.width,
      height: input.height,
      columns,
      rows,
      tileWidth,
      tileHeight: tileWidth / COOKIE_ASPECT,
      cellHeight: tileWidth / ratio,
      gap: tileWidth * gapRatio,
      perPage,
      pages: Math.max(1, Math.ceil(count / perPage)),
    };
  };

  const all = fitGrid(input.width, input.height, count, gapRatio, ratio);
  if (all.tileWidth >= minTile) {
    // 全部同時放得下，而且還看得清楚——這是最想要的情況
    return shape(all.columns, all.rows, all.tileWidth, count);
  }

  // 擠不下了。先問「用最小尺寸的話一頁能放幾張」，
  // 再用那個張數重新排一次——分頁之後格子通常還能比最小尺寸再大一些。
  const minGap = minTile * gapRatio;
  const columns = Math.max(
    1,
    Math.floor((input.width + minGap) / (minTile + minGap)),
  );
  const rows = Math.max(
    1,
    Math.floor((input.height + minGap) / (minTile / ratio + minGap)),
  );
  const perPage = Math.max(1, columns * rows);

  const page = fitGrid(input.width, input.height, perPage, gapRatio, ratio);
  return shape(page.columns, page.rows, page.tileWidth, perPage);
}

/**
 * 算出某一頁每一格在哪裡。
 *
 * 整體置中，最後一排若沒排滿也置中：靠左對齊的話，
 * 最後一排會孤零零地黏在左邊，整面牆看起來像沒做完。
 */
export function wallCells(
  plan: CookieWallPlan,
  page: number,
  count: number,
): readonly CookieWallCell[] {
  const out: CookieWallCell[] = [];
  if (plan.perPage <= 0 || plan.columns <= 0 || count <= 0) {
    return out;
  }

  const safePage = Math.min(Math.max(0, Math.floor(page)), plan.pages - 1);
  const start = safePage * plan.perPage;
  const end = Math.min(count, start + plan.perPage);
  const shown = end - start;
  if (shown <= 0) {
    return out;
  }

  const rowsUsed = Math.ceil(shown / plan.columns);
  const gridHeight =
    rowsUsed * plan.cellHeight + (rowsUsed - 1) * plan.gap;
  const originY = (plan.height - gridHeight) / 2;

  for (let i = 0; i < shown; i += 1) {
    const row = Math.floor(i / plan.columns);
    const column = i % plan.columns;

    // 這一排實際有幾格：最後一排可能不滿
    const inRow = Math.min(plan.columns, shown - row * plan.columns);
    const rowWidth = inRow * plan.tileWidth + (inRow - 1) * plan.gap;
    const originX = (plan.width - rowWidth) / 2;

    out.push({
      index: start + i,
      x: originX + column * (plan.tileWidth + plan.gap),
      y: originY + row * (plan.cellHeight + plan.gap),
    });
  }

  return out;
}

/**
 * 某一張照片在第幾頁。
 *
 * 有人剛上傳的時候要立刻跳到他那一頁——不然他會在台下盯著一面
 * 沒有自己的牆，而那正是「立即呈現」要解決的事。
 */
export function pageOfIndex(plan: CookieWallPlan, index: number): number {
  if (plan.perPage <= 0) {
    return 0;
  }
  return Math.min(plan.pages - 1, Math.max(0, Math.floor(index / plan.perPage)));
}
