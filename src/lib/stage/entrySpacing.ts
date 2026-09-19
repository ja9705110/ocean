/**
 * 讓剛上傳的簽名不要疊在一起（C39）。
 *
 * 問題：新上傳的人一律放在河道最上游的同一點。進場佇列每 300 毫秒
 * 放行一個，而河速大約是每秒 67 像素——相鄰兩個只差 20 像素，
 * 簽名本身卻有 120 像素寬。報到的時候大家接連掃碼，
 * 連續五六個就黏成一團往下漂。
 *
 * 做法不是把間隔拉長（那會讓人上傳完盯著螢幕等），
 * 而是換個地方放：每次進場都給好幾個候選位置，
 * 挑一個離「剛才那幾個」最遠的。
 *
 * 只記最近幾秒。再早的那些已經順流走遠了，
 * 把它們算進來只會讓可用的位置越來越少，最後反而擠在一起。
 */

export interface EntryPoint {
  readonly x: number;
  readonly y: number;
}

export interface EntrySpacer {
  /**
   * 從候選裡挑一個離「剛才那幾個現在在哪」最遠的，並把它記下來。
   *
   * drift 是這個位置每秒會漂多少像素（河的流速向量）。
   * 少了它就會比錯對象：記下來的是出生點，但簽名早就順流走了，
   * 於是新的人被推開一個已經空掉的位置，反而擠到還有人的地方。
   * 這不是推測——第一版沒有 drift，模擬八個人連續上傳時，
   * 有挑跟沒挑一樣糟（5 像素 vs 8 像素）。
   *
   * 候選是空的時候回傳 null，呼叫端自己決定退路——
   * 這裡不猜一個座標出來，那會讓簽名落在河道外面。
   */
  pick(
    candidates: readonly EntryPoint[],
    nowSeconds: number,
    drift: EntryPoint,
  ): EntryPoint | null;
  /** 目前記著幾個點，測試用 */
  readonly remembered: number;
}

/**
 * memorySeconds 該設多久：一個簽名完全離開自己原本的位置要多久。
 *
 * 120 像素寬、每秒 67 像素，大約 1.8 秒。取 2.5 秒留一點餘裕，
 * 但不要更長——記太久會把已經走遠的位置也當成障礙。
 */
export function createEntrySpacer(memorySeconds: number): EntrySpacer {
  let recent: {
    x: number;
    y: number;
    t: number;
    dx: number;
    dy: number;
  }[] = [];

  return {
    pick(candidates, nowSeconds, drift) {
      // 走遠的就忘掉。時間倒退（換場、重新載入）時整批清掉
      recent = recent.filter(
        (p) => nowSeconds >= p.t && nowSeconds - p.t <= memorySeconds,
      );

      // 每一個都推算到「現在」在哪，而不是拿出生點來比
      const here = recent.map((p) => {
        const age = nowSeconds - p.t;
        return { x: p.x + p.dx * age, y: p.y + p.dy * age };
      });

      let best: EntryPoint | null = null;
      let bestGap = -1;

      for (const candidate of candidates) {
        let nearest = Number.POSITIVE_INFINITY;
        for (const p of here) {
          const gap = Math.hypot(candidate.x - p.x, candidate.y - p.y);
          if (gap < nearest) {
            nearest = gap;
          }
        }
        if (nearest > bestGap) {
          bestGap = nearest;
          best = candidate;
        }
      }

      if (best !== null) {
        recent.push({
          x: best.x,
          y: best.y,
          t: nowSeconds,
          dx: drift.x,
          dy: drift.y,
        });
      }
      return best;
    },

    get remembered() {
      return recent.length;
    },
  };
}
