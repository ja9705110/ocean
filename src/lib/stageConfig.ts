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
  DEFAULT_RIVER_SHAPE,
  parseRiverShape,
  type RiverShape,
} from "@/lib/stage/riverShape";

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
  poster: EMPTY_POSTER,
  backgroundUrl: "",
  backgroundDim: 0.35,
  showQr: true,
  flowIntensity: 0.35,
  flowDebug: false,
  overlayUrl: "",
  testMode: false,
  river: DEFAULT_RIVER_SHAPE,
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
    testMode: raw.testMode === true,
    river: parseRiverShape(raw.river),
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
    backgroundUrl: config.backgroundUrl,
    backgroundDim: config.backgroundDim,
    showQr: config.showQr,
    flowIntensity: config.flowIntensity,
    flowDebug: config.flowDebug,
    overlayUrl: config.overlayUrl,
    testMode: config.testMode,
    river: { ...config.river },
    poster: { ...config.poster },
  };
}
