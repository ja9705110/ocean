/**
 * 頒獎台的排法（C37）。
 *
 * 純計算，不碰畫面：給它一份已經照分數排好的名單，
 * 它回答三件事——誰是第幾名、站在左右哪一格、台子要多高。
 *
 * 抽出來的理由跟餅乾照片牆一樣：這裡真正容易錯的是
 * 「同分怎麼辦」與「不足五名怎麼排」，那兩件事在 JSX 裡看不出對錯，
 * 在這裡則可以直接跑測試。
 */

/** 頒獎台最多放幾位。再多就變成排行榜，那是另一個畫面。 */
export const PODIUM_MAX = 5;

/** 一位得獎者。名次與位置由這個檔案算，呼叫端只要把資料整理成這樣。 */
export interface PodiumEntry {
  readonly key: string;
  readonly name: string;
  /** 名字底下那一行小字，例如「8 人 ｜ 答對 12」 */
  readonly sub: string;
  readonly color: string;
  /** 分組賽畫生物，個人賽沒有就是 null */
  readonly creatureKey: string | null;
  readonly points: number;
}

export interface PodiumPlace {
  readonly entry: PodiumEntry;
  /** 名次。同分同名次（1, 2, 2, 4, 5） */
  readonly rank: number;
  /** 由左至右的位置，0 起算 */
  readonly slot: number;
  /** 台子高度佔最高那一座的比例 */
  readonly heightRatio: number;
  /** 揭曉順序，0 最先出現（也就是名次最後的那一位） */
  readonly revealOrder: number;
}

/**
 * 各名次的台子高度。
 *
 * 不是等差：第一名要明顯高出一截，那是整個畫面的重心；
 * 四五名之間差多少其實沒有人在看，所以下面幾階收得比較緊。
 */
const HEIGHT_BY_RANK: readonly number[] = [1, 0.76, 0.58, 0.44, 0.34];

export function podiumHeightRatio(rank: number): number {
  const clamped = Math.min(Math.max(rank, 1), HEIGHT_BY_RANK.length);
  return HEIGHT_BY_RANK[clamped - 1] ?? 1;
}

/**
 * 站位：第一名在正中央，第二名在他左邊，第三名右邊，
 * 第四名再往左、第五名再往右。
 *
 * 也就是名單的索引 3, 1, 0, 2, 4 由左至右。
 * 不足五位時同一個規則照樣成立，而且中心永遠是第一名——
 * 三位就是 1, 0, 2，兩位就是 1, 0。
 */
export function podiumSlotOrder(count: number): readonly number[] {
  const left: number[] = [];
  const right: number[] = [];

  for (let i = 1; i < count; i += 1) {
    if (i % 2 === 1) {
      left.push(i);
    } else {
      right.push(i);
    }
  }

  // 左邊要由外而內：索引大的離中心遠
  left.reverse();
  return count > 0 ? [...left, 0, ...right] : [];
}

/**
 * 算出每一位的名次、站位與台高。
 *
 * entries 必須已經照分數由高到低排好——排序是資料庫的工作，
 * 這裡只負責「同分要同名次」這件前端才看得到的事。
 *
 * 同分的處理是一般競賽的算法：1, 2, 2, 4。兩桌都是 3000 分，
 * 螢幕上卻一個寫第二、一個寫第三，在現場是會被抗議的。
 * 台子高度跟著名次走，所以同分的兩座一樣高。
 */
export function rankPodium(
  entries: readonly PodiumEntry[],
): readonly PodiumPlace[] {
  const top = entries.slice(0, PODIUM_MAX);
  const order = podiumSlotOrder(top.length);

  // 索引 → 由左至右的第幾格
  const slotOf = new Map<number, number>();
  order.forEach((index, slot) => slotOf.set(index, slot));

  const ranks: number[] = [];
  top.forEach((entry, index) => {
    const previous = top[index - 1];
    const previousRank = ranks[index - 1];
    ranks.push(
      previous !== undefined &&
        previousRank !== undefined &&
        previous.points === entry.points
        ? previousRank
        : index + 1,
    );
  });

  return top.map((entry, index) => {
    const rank = ranks[index] ?? index + 1;
    return {
      entry,
      rank,
      slot: slotOf.get(index) ?? index,
      heightRatio: podiumHeightRatio(rank),
      // 由後往前揭曉：最後一名先上台，第一名壓軸
      revealOrder: top.length - 1 - index,
    };
  });
}

/** 名次的顏色。金銀銅之後就不再給金屬色，那會削弱前三名。 */
export interface PodiumMedal {
  /** 台子正面 */
  readonly block: string;
  /** 台面與邊光 */
  readonly edge: string;
  /** 名次數字 */
  readonly numeral: string;
}

/** 第六名以後不會上台，但有了它 podiumMedal 就不必回傳可能是 undefined */
const PLAIN_MEDAL: PodiumMedal = {
  block: "#cfd8dd",
  edge: "#e8eef1",
  numeral: "#5a666e",
};

const MEDALS: readonly PodiumMedal[] = [
  { block: "#e8be5e", edge: "#f6dfa4", numeral: "#6b4a06" },
  { block: "#b9c2ca", edge: "#dfe5ea", numeral: "#3f4a54" },
  { block: "#c98a4f", edge: "#e6b689", numeral: "#5b3413" },
  PLAIN_MEDAL,
  PLAIN_MEDAL,
];

export function podiumMedal(rank: number): PodiumMedal {
  const clamped = Math.min(Math.max(rank, 1), MEDALS.length);
  // MEDALS 一定有這個索引，?? 只是為了讓型別不必靠斷言
  return MEDALS[clamped - 1] ?? PLAIN_MEDAL;
}

/** 每一位之間隔多久上台。五位剛好六秒多，主持人講得完一句話。 */
export const PODIUM_REVEAL_STEP_MS = 1200;

/** 第一位上台前的靜默。畫面切過來就立刻有東西冒出來會像沒切過。 */
export const PODIUM_REVEAL_DELAY_MS = 600;

export function podiumRevealDelayMs(revealOrder: number): number {
  return PODIUM_REVEAL_DELAY_MS + revealOrder * PODIUM_REVEAL_STEP_MS;
}
