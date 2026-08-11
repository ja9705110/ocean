/**
 * 問答的主題（Q4）。
 *
 * 原本四個選項是寫死的海洋生物，配色也寫死在 CSS token 裡。
 * 活動主題一改（海洋 → 河流），整套就得動程式碼——那是設計缺陷。
 *
 * 現在主題是一份資料：四個符號、一組配色、一個名字。
 * 換主題只是換一個字串，不必動任何畫面程式碼。
 *
 * 三個不變的約束，換主題也不能破壞：
 *
 * 1. 四個符號在整場活動中固定不變、位置也固定。玩家玩兩題就記住位置，
 *    之後可以只盯著大螢幕、手不用看。每題換符號會毀掉這件事。
 * 2. 四個符號要「隔著三十公尺看得出來」：剪影差很多、色相跨開，
 *    而且不能只靠顏色分辨——紅綠色盲的人也要認得出來。
 * 3. 配色是淺色的。內容是要讓兩三百人在三十公尺外讀完的文字，
 *    深底淺字投到牆上會糊掉。
 */

import { OCEAN_CREATURES, type OceanCreature } from "@/lib/creatures/ocean";
import { RIVER_CREATURES } from "@/lib/creatures/river";

export interface QuizOption {
  /** 對應符號登記表的 key */
  readonly creatureKey: string;
  readonly name: string;
  /** 主色，淺色背景上要夠飽和 */
  readonly color: string;
  /** 按鈕底色 */
  readonly surface: string;
}

/**
 * 一套配色。全部是實際色碼而不是 Tailwind class，
 * 因為要在執行期依主題套用——class 名稱在編譯期就固定了，換不了。
 */
export interface QuizPalette {
  /** 頁面底色 */
  readonly bg: string;
  /** 卡片、面板底色 */
  readonly surface: string;
  /** 進度條、分隔線 */
  readonly line: string;
  /** 主要文字 */
  readonly text: string;
  /** 次要文字 */
  readonly textSoft: string;
  /** 強調色：計時條、按鈕 */
  readonly accent: string;
  /** 背景漸層的兩個端點，用在大螢幕的水面 */
  readonly waveTop: string;
  readonly waveBottom: string;
}

export interface QuizTheme {
  readonly key: string;
  /** 顯示給主持人看的名稱 */
  readonly name: string;
  /** 預設的場次名稱，主持人可以改 */
  readonly defaultSessionName: string;
  readonly palette: QuizPalette;
  /** 固定四個，順序就是畫面上的順序 */
  readonly options: readonly [QuizOption, QuizOption, QuizOption, QuizOption];
}

export const RIVER_THEME: QuizTheme = {
  key: "river",
  name: "河流",
  defaultSessionName: "流向問答",
  palette: {
    bg: "#f3fbf7",
    surface: "#e2f4ec",
    line: "#bde3d4",
    text: "#0d3d2f",
    textSoft: "#3f7a67",
    accent: "#1d8a68",
    waveTop: "#d3efe3",
    waveBottom: "#a9dfc9",
  },
  options: [
    { creatureKey: "carp", name: "鯉魚", color: "#d1541f", surface: "#ffe9de" },
    { creatureKey: "frog", name: "青蛙", color: "#2f8c44", surface: "#e0f6e4" },
    {
      creatureKey: "dragonfly",
      name: "蜻蜓",
      color: "#1f6fc4",
      surface: "#e2eeff",
    },
    { creatureKey: "duck", name: "水鴨", color: "#7a45bd", surface: "#f1e8fd" },
  ],
};

export const OCEAN_THEME: QuizTheme = {
  key: "ocean",
  name: "海洋",
  defaultSessionName: "海洋問答",
  palette: {
    bg: "#f4fbfe",
    surface: "#e3f4fb",
    line: "#c3e8f5",
    text: "#072e3e",
    textSoft: "#16749b",
    accent: "#2494bd",
    waveTop: "#c3e8f5",
    waveBottom: "#93d5ec",
  },
  options: [
    { creatureKey: "whale", name: "鯨魚", color: "#1c6fd0", surface: "#e3efff" },
    { creatureKey: "turtle", name: "海龜", color: "#1f9d5c", surface: "#e2f7ec" },
    { creatureKey: "crab", name: "螃蟹", color: "#e0492f", surface: "#ffe9e4" },
    {
      creatureKey: "jellyfish",
      name: "水母",
      color: "#8244c9",
      surface: "#f2e9fd",
    },
  ],
};

export const QUIZ_THEMES: readonly QuizTheme[] = [RIVER_THEME, OCEAN_THEME];

/** 找不到就用河流：現在的活動主題是流向 */
export function quizTheme(key: unknown): QuizTheme {
  return QUIZ_THEMES.find((t) => t.key === key) ?? RIVER_THEME;
}

/** 所有主題的符號都在這裡查得到，畫面不必知道符號屬於哪個主題 */
const ALL_SYMBOLS: readonly OceanCreature[] = [
  ...RIVER_CREATURES,
  ...OCEAN_CREATURES,
];

export function findSymbol(key: string): OceanCreature | undefined {
  return ALL_SYMBOLS.find((c) => c.key === key);
}

/**
 * 把配色轉成 CSS 變數，掛在頁面最外層。
 *
 * 用變數而不是 Tailwind 的 class：class 在編譯期就決定了，
 * 沒辦法在執行期依主題切換。
 */
export function paletteVars(palette: QuizPalette): React.CSSProperties {
  return {
    "--q-bg": palette.bg,
    "--q-surface": palette.surface,
    "--q-line": palette.line,
    "--q-text": palette.text,
    "--q-text-soft": palette.textSoft,
    "--q-accent": palette.accent,
    "--q-wave-top": palette.waveTop,
    "--q-wave-bottom": palette.waveBottom,
  } as React.CSSProperties;
}
