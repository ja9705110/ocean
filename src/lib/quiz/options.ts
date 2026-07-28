/**
 * 問答的四個選項（Q0）。
 *
 * 四種海洋生物是固定的，每一題都一樣——就像 Kahoot 的紅三角與藍菱形
 * 永遠在同樣的位置。玩兩題之後大家就記住了，之後可以只盯著大螢幕，
 * 手不用看就按得到。每題換不同的生物會毀掉這件事。
 *
 * 挑選的標準是「隔著三十公尺看得出來」：
 * 剪影要差很多（大／圓／橫／飄），顏色要跨開色相，
 * 而且不能有兩個相鄰的顏色在紅綠色盲下變成同一個。
 * 因此除了顏色，位置與形狀本身也是辨識線索。
 */

export interface QuizOption {
  /** 對應 OCEAN_CREATURES 的 key */
  readonly creatureKey: string;
  readonly name: string;
  /** 主色，明亮背景上要夠飽和 */
  readonly color: string;
  /** 按鈕背景 */
  readonly surface: string;
}

export const QUIZ_OPTIONS: readonly QuizOption[] = [
  { creatureKey: "whale", name: "鯨魚", color: "#1c6fd0", surface: "#e3efff" },
  { creatureKey: "turtle", name: "海龜", color: "#1f9d5c", surface: "#e2f7ec" },
  { creatureKey: "crab", name: "螃蟹", color: "#e0492f", surface: "#ffe9e4" },
  {
    creatureKey: "jellyfish",
    name: "水母",
    color: "#8244c9",
    surface: "#f2e9fd",
  },
];

export function quizOption(index: number): QuizOption {
  return QUIZ_OPTIONS[index] ?? QUIZ_OPTIONS[0]!;
}
