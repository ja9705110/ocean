/**
 * 大螢幕的可調設定（C2）。
 *
 * 存在 events.stage_config（jsonb），主持人在後台改，大螢幕自己輪詢。
 *
 * 這一份沒有 "use client"：Server Component 的活動查詢與瀏覽器端
 * 都要用到解析函式。放進標了 "use client" 的檔案裡，
 * 伺服器端呼叫會直接爆「Attempted to call ... from the server」。
 */

import {
  DEFAULT_COOKIE_DISPLAY,
  DEFAULT_RIVER_LOOK,
  DEFAULT_RIVER_SHAPE,
  parseCookieDisplay,
  parseRiverLook,
  parseRiverShape,
  type CookieDisplay,
  type RiverLook,
  type RiverShape,
} from "@/lib/stage/riverShape";
import { VISUAL_HEIGHT, VISUAL_WIDTH } from "@/lib/stage/visualAssets";

/**
 * 大螢幕的比例（C38）。
 *
 *   native   寬度貼齊畫面，高度照主視覺比例、但不超過畫面。預設。
 *   contain  完整塞進畫面，該留邊就留邊。完全不變形也不裁切。
 *   cover    維持比例撐到蓋滿畫面，超出去的邊緣裁掉。不變形。
 *   stretch  直接拉滿整個畫面。不留黑邊也不裁切，但主視覺會變形。
 *   16:9／16:10／4:3  固定成指定的比例，不管視窗多大。
 *
 * native 就是這個設定加進來之前的行為，一個像素都不差，所以它是預設。
 * 它的特別之處在於「寬度一定貼齊畫面」：視窗比主視覺更扁的時候
 * （瀏覽器沒有全螢幕，上面那排網址列就會讓它更扁），
 * 它寧可上下拉一點點也不肯在左右留黑邊。
 *
 * 一度把預設改成嚴格的 contain，結果就是視窗一不是 16:9，
 * 左右立刻各出現一大條黑邊，畫面整個縮小。那在投影幕上是很明顯的退步，
 * 所以 contain 留成一個選項，預設退回 native。
 *
 * 每一種都有代價，沒有一個是「對」的：留黑邊浪費投影面積、
 * 裁切會切掉邊緣的東西、拉伸會讓燙金的字變形。哪一個能接受
 * 要看現場那台投影機，所以這裡不替主持人決定，只把路都鋪好。
 */
export type ScreenFit =
  | "native"
  | "contain"
  | "cover"
  | "stretch"
  | "16:9"
  | "16:10"
  | "4:3";

export interface ScreenFitOption {
  readonly key: ScreenFit;
  readonly name: string;
  readonly hint: string;
}

export const SCREEN_FIT_OPTIONS: readonly ScreenFitOption[] = [
  {
    key: "native",
    name: "貼齊畫面寬度（預設）",
    hint: "一直以來的樣子。寬度一定貼齊整個畫面，高度照主視覺的比例；畫面比主視覺更扁的時候，寧可上下拉一點點也不在左右留黑邊。",
  },
  {
    key: "contain",
    name: "完整顯示・不裁切不拉伸",
    hint: "整張主視覺完整擺進畫面，比例一個像素都不動，該留邊就留邊。想確認原圖長什麼樣子的時候用，但投影機比例不合時黑邊會很明顯。",
  },
  {
    key: "cover",
    name: "填滿畫面・裁切邊緣",
    hint: "維持比例撐到蓋滿整面牆，超出去的部分裁掉。不會變形，但上下或左右會被切掉一點——投影機比例跟主視覺差不多時最好用。",
  },
  {
    key: "stretch",
    name: "填滿畫面・拉伸",
    hint: "整面牆完全填滿，不留黑邊也不裁切，代價是主視覺會被拉長或壓扁。差得不多的時候看不太出來。",
  },
  {
    key: "16:9",
    name: "固定 16:9",
    hint: "不管視窗多大都照 16:9 擺。最常見的投影機比例。",
  },
  {
    key: "16:10",
    name: "固定 16:10",
    hint: "不管視窗多大都照 16:10 擺。部分商用投影機與筆電是這個比例。",
  },
  {
    key: "4:3",
    name: "固定 4:3",
    hint: "不管視窗多大都照 4:3 擺。舊型投影機常見。主視覺會被壓得比較明顯。",
  },
];

export function parseScreenFit(value: unknown): ScreenFit {
  return SCREEN_FIT_OPTIONS.some((option) => option.key === value)
    ? (value as ScreenFit)
    : "native";
}

/** 主視覺本身的長寬比。native 與 cover 都照它擺。 */
const NATIVE_RATIO = VISUAL_WIDTH / VISUAL_HEIGHT;

const RATIO: Record<Exclude<ScreenFit, "stretch">, number> = {
  native: NATIVE_RATIO,
  contain: NATIVE_RATIO,
  cover: NATIVE_RATIO,
  "16:9": 16 / 9,
  "16:10": 16 / 10,
  "4:3": 4 / 3,
};

/** 畫框的尺寸，直接展開成 style 用 */
export interface ScreenFrameSize {
  readonly width: string;
  readonly height: string;
  /**
   * 不准被 flex 壓回來。
   *
   * 畫框的外層是 flex 置中容器，而 flex 項目預設 flex-shrink 是 1——
   * 「填滿畫面・裁切邊緣」算出來的寬度本來就比視窗大，
   * 沒有這一行會被 flex 直接壓回視窗大小，結果跟拉伸一模一樣。
   * 量到過一次，所以寫進這裡而不是交給每個呼叫端自己記得加。
   */
  readonly flexShrink: number;
}

/**
 * 算出畫框要多大。
 *
 * 用視窗單位而不是百分比：百分比在兩個方向上的基準不一樣，
 * 沒辦法在同一個 min()／max() 裡比較，而「寬高比固定」這件事
 * 本來就是兩個方向要一起看的。
 *
 * min 就是塞進視窗裡（可能留邊），max 就是撐出視窗外（超出的裁掉）。
 * 外層的 overflow-hidden 負責裁。
 */
export function screenFrameSize(fit: ScreenFit): ScreenFrameSize {
  if (fit === "stretch") {
    return { width: "100vw", height: "100dvh", flexShrink: 0 };
  }

  /*
    預設：寬度貼齊畫面，高度照比例但不超過畫面。

    這是原本那串 class（w-full max-w-full max-h-full aspect-[1672/941]）
    算出來的東西，一個像素都不差——寬度來自 w-full，高度由比例決定
    再被 max-h-full 夾住。夾到的時候比例就被打破了，畫面會被上下拉，
    但它換來的是「左右永遠不留黑邊」。

    看起來像是將就，實際上在投影幕上是對的取捨：多數視窗都比
    主視覺更扁（瀏覽器的網址列一佔就是幾十像素），嚴格照比例的話
    左右會各出現一大條黑邊，整張圖縮掉一大圈。
  */
  if (fit === "native") {
    return {
      width: "100vw",
      height: `min(100dvh, calc(100vw / ${NATIVE_RATIO}))`,
      flexShrink: 0,
    };
  }

  const ratio = RATIO[fit];
  const bound = fit === "cover" ? "max" : "min";

  return {
    width: `${bound}(100vw, calc(100dvh * ${ratio}))`,
    height: `${bound}(100dvh, calc(100vw / ${ratio}))`,
    flexShrink: 0,
  };
}

/**
 * 主視覺的固定文字。
 *
 * 這幾行對應活動海報上的排版，在大螢幕上是不動的——
 * 河在流、簽名在流，但標題、日期、場地要像海報一樣定在那裡。
 *
 * 全部可留空，留空的那一行就不顯示。整塊都空的時候不畫任何東西，
 * 沒有設定過的活動不會突然多出一塊空框。
 */
export interface StagePoster {
  /** 標題上方的小字，例如主辦單位 */
  readonly eyebrow: string;
  /** 主標，例如「流嚮」 */
  readonly title: string;
  /** 主標下的外文，例如 FLOW TOGETHER。用換行分成兩行 */
  readonly titleEn: string;
  /** 標語，例如「每一條河，都有自己的方向」 */
  readonly tagline: string;
  /** 場地 */
  readonly venue: string;
  /** 日期與時間，直接照你想顯示的樣子填 */
  readonly dateText: string;
  /** 關鍵字列，例如「流動 × 連結 × 承載 × 匯聚」 */
  readonly keywords: string;
  /** 右下角的落款，例如「匯聚同行・流嚮未來」 */
  readonly footer: string;
}

export interface StageConfig {
  /**
   * 流速倍率。1 是模板的原始速度。
   *
   * 上下限刻意收得很窄：低於 0.2 看起來像停住（會被當成當機），
   * 高於 2.5 則是簽名還沒看清楚就流掉了，兩邊都不是有用的設定。
   */
  readonly flowSpeed: number;
  /**
   * 光粒子的流速倍率，跟簽名彩繪分開（C28）。
   *
   * 兩者要的東西不一樣：粒子是背景的水流感，快一點才像活水；
   * 簽名彩繪是要讓人看清楚「那是我」，太快就只剩一片閃過去的色塊。
   * 綁在同一個數字上，調快了看不清簽名，調慢了整條河像結凍。
   */
  readonly particleSpeed: number;
  readonly poster: StagePoster;
  /**
   * 主持人自己上傳的背景圖，通常就是活動主視覺本身。
   *
   * 設了之後，程式繪製的河道背景整層關掉，改由這張圖當底，
   * 光粒與大家的簽名照樣在上面流。程式畫得再像，都不會比原圖本身更像。
   */
  readonly backgroundUrl: string;
  /**
   * 背景圖上的暗幕強度（0~0.85）。
   *
   * 主視覺本身很亮，簽名蓋上去會看不清楚是誰。壓一層暗幕之後，
   * 圖還在、簽名也讀得到。
   */
  readonly backgroundDim: number;
  /** 大螢幕右側要不要顯示 QR Code 與人數 */
  readonly showQr: boolean;
  /**
   * 背景圖上河道流動層的強度（0.25~0.45）。
   *
   * 上限是刻意的：再高金色會過曝變白，主視覺的燙金質感就沒了。
   */
  readonly flowIntensity: number;
  /** 把遮罩範圍畫出來，用來確認有沒有蓋到 logo 或文字 */
  readonly flowDebug: boolean;
  /**
   * 去背主視覺 PNG：logo、全部文字、主標、日期、右下角的 25。
   *
   * 設了之後這張圖固定蓋在所有動畫的最上層，以原始座標完整覆蓋畫布，
   * 不裁切、不拉伸、不重新排版。底下的參考圖會把文字區抹掉，
   * 避免同一段文字出現兩次。
   */
  readonly overlayUrl: string;
  /**
   * 大螢幕的比例（C38）。
   *
   * 畫面本來固定照主視覺的比例擺，投影機不是這個比例時四周留黑邊。
   * 那是最安全的預設，但現場的投影機不見得是 16:9，
   * 而黑邊到底能不能接受、要不要為了填滿而裁掉一點或拉一下，
   * 是站在那面牆前面才決定得了的事，所以做成當場可以切換。
   */
  readonly screen: ScreenFit;
  /**
   * 測試版：只顯示河流背景與去背主視覺，不顯示 QR Code 與參與者。
   *
   * 用來單獨確認河道的走向、大小、寬度與位置對不對，
   * 不被其他東西干擾。
   */
  readonly testMode: boolean;
  /**
   * 程式繪製河道的形狀：角度、彎曲、長度、寬度、位置。
   *
   * 只有在沒有上傳背景圖的時候才有作用——有背景圖的話，河道是從
   * 那張圖的像素量出來的，形狀由圖決定，這裡調什麼都不會變。
   */
  readonly river: RiverShape;
  /**
   * 程式繪製河道的外觀：亮度與光粒。
   *
   * 跟形狀分開：形狀是活動前排版時決定的，亮度是投影打上去、
   * 簽名蓋上去之後才知道要壓多少。
   */
  readonly riverLook: RiverLook;
  /**
   * 餅乾馬賽克：大家彩繪的餅乾照片密鋪在河道裡跟著水流走。
   *
   * 開著的時候大螢幕不顯示簽名——那是活動的另一個段落，
   * 兩種東西同時在河上只會互相蓋住。
   */
  readonly cookies: CookieDisplay;
}

export const MIN_FLOW_SPEED = 0.2;
export const MAX_FLOW_SPEED = 2.5;

export const EMPTY_POSTER: StagePoster = {
  eyebrow: "",
  title: "",
  titleEn: "",
  tagline: "",
  venue: "",
  dateText: "",
  keywords: "",
  footer: "",
};

export const MAX_BACKGROUND_DIM = 0.85;
export const MIN_FLOW_INTENSITY = 0.25;
export const MAX_FLOW_INTENSITY = 0.45;

export const DEFAULT_STAGE_CONFIG: StageConfig = {
  flowSpeed: 1,
  particleSpeed: 1,
  poster: EMPTY_POSTER,
  backgroundUrl: "",
  backgroundDim: 0.35,
  showQr: true,
  flowIntensity: 0.35,
  flowDebug: false,
  overlayUrl: "",
  screen: "native",
  testMode: false,
  river: DEFAULT_RIVER_SHAPE,
  riverLook: DEFAULT_RIVER_LOOK,
  cookies: DEFAULT_COOKIE_DISPLAY,
};

function clampSpeed(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_STAGE_CONFIG.flowSpeed;
  }
  return Math.min(MAX_FLOW_SPEED, Math.max(MIN_FLOW_SPEED, parsed));
}

/** 只取字串，並砍掉過長的內容——投影幕上塞不下一整段文章 */
function text(value: unknown, max = 60): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

/**
 * 從資料庫的 jsonb 解析成設定。
 *
 * 任何形狀的髒資料都要能安全落地成預設值：這份設定是手打的，
 * 而大螢幕在活動當下不能因為某一欄型別不對就整頁白掉。
 */
export function parseStageConfig(value: unknown): StageConfig {
  if (typeof value !== "object" || value === null) {
    return DEFAULT_STAGE_CONFIG;
  }

  const raw = value as Record<string, unknown>;
  const poster =
    typeof raw.poster === "object" && raw.poster !== null
      ? (raw.poster as Record<string, unknown>)
      : {};

  return {
    flowSpeed: clampSpeed(raw.flowSpeed),
    // 沒設定過就跟著簽名的流速走——這樣既有的活動看起來完全不變，
    // 主持人想分開調的時候再拉開
    particleSpeed:
      raw.particleSpeed === undefined || raw.particleSpeed === null
        ? clampSpeed(raw.flowSpeed)
        : clampSpeed(raw.particleSpeed),
    // 只收 http(s)：這個值會直接進 <img src>，不能讓 javascript: 之類的東西進來
    backgroundUrl: /^https?:\/\//.test(String(raw.backgroundUrl ?? ""))
      ? String(raw.backgroundUrl)
      : "",
    backgroundDim: Number.isFinite(Number(raw.backgroundDim))
      ? Math.min(MAX_BACKGROUND_DIM, Math.max(0, Number(raw.backgroundDim)))
      : DEFAULT_STAGE_CONFIG.backgroundDim,
    showQr: raw.showQr !== false,
    flowIntensity: Number.isFinite(Number(raw.flowIntensity))
      ? Math.min(
          MAX_FLOW_INTENSITY,
          Math.max(MIN_FLOW_INTENSITY, Number(raw.flowIntensity)),
        )
      : DEFAULT_STAGE_CONFIG.flowIntensity,
    flowDebug: raw.flowDebug === true,
    // 只收 http(s)：這個值會直接進 <img src>
    overlayUrl: /^https?:\/\//.test(String(raw.overlayUrl ?? ""))
      ? String(raw.overlayUrl)
      : "",
    // 沒設定過就是 native，也就是這個設定加進來之前的行為
    screen: parseScreenFit(raw.screen),
    testMode: raw.testMode === true,
    river: parseRiverShape(raw.river),
    riverLook: parseRiverLook(raw.riverLook),
    cookies: parseCookieDisplay(raw.cookies),
    poster: {
      eyebrow: text(poster.eyebrow, 40),
      title: text(poster.title, 12),
      titleEn: text(poster.titleEn, 40),
      tagline: text(poster.tagline, 40),
      venue: text(poster.venue, 40),
      dateText: text(poster.dateText, 40),
      keywords: text(poster.keywords, 40),
      footer: text(poster.footer, 40),
    },
  };
}

/** 整塊主視覺文字都沒填時不畫任何東西 */
export function posterIsEmpty(poster: StagePoster): boolean {
  return Object.values(poster).every((line) => line === "");
}

/** 寫回資料庫的形狀 */
export function toStageConfigJson(config: StageConfig): Record<string, unknown> {
  return {
    flowSpeed: clampSpeed(config.flowSpeed),
    particleSpeed: clampSpeed(config.particleSpeed),
    backgroundUrl: config.backgroundUrl,
    backgroundDim: config.backgroundDim,
    showQr: config.showQr,
    flowIntensity: config.flowIntensity,
    flowDebug: config.flowDebug,
    overlayUrl: config.overlayUrl,
    screen: config.screen,
    testMode: config.testMode,
    river: { ...config.river },
    riverLook: { ...config.riverLook },
    cookies: { ...config.cookies },
    poster: { ...config.poster },
  };
}
