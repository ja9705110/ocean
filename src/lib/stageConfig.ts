/**
 * 大螢幕的可調設定（C2）。
 *
 * 存在 events.stage_config（jsonb），主持人在後台改，大螢幕自己輪詢。
 *
 * 這一份沒有 "use client"：Server Component 的活動查詢與瀏覽器端
 * 都要用到解析函式。放進標了 "use client" 的檔案裡，
 * 伺服器端呼叫會直接爆「Attempted to call ... from the server」。
 */

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

export const DEFAULT_STAGE_CONFIG: StageConfig = {
  flowSpeed: 1,
  poster: EMPTY_POSTER,
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
    poster: { ...config.poster },
  };
}
