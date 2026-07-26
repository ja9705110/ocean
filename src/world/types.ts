import type { Application, Container, Sprite } from "pixi.js";

/**
 * 世界模板的公開介面（規格第 8 節）。
 *
 * 這份檔案是整個渲染層的契約，在 M0 就先釘死，理由是：
 * 渲染核心（WorldRenderer / LayoutEngine / DrawSequence）只認識這裡的型別，
 * 不認識「海洋」。新增世界只需新增一個 templates/*.ts 檔並註冊，
 * 不修改 engine/ 底下任何一行程式碼。
 *
 * 同樣地，這裡的型別完全不依賴 Supabase。渲染層可以用假資料離線跑，
 * 這是 M5 進行 350 隻壓力測試的前提。
 */

/** GSAP 的 timeline。gsap 以全域 namespace 宣告型別，此處取別名以利閱讀。 */
export type Timeline = gsap.core.Timeline;

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** 世界配色 */
export interface Palette {
  /** 背景漸層色階，由上而下 */
  readonly bg: readonly string[];
  /** 強調色：中獎光暈、UI 重點 */
  readonly accent: string;
}

/**
 * 佈局帶（規格第 10 節）。
 * 畫面垂直切成數層，各層縮放與速度不同以製造景深。
 * top / bottom 為畫面高度的比例（0 = 最上緣，1 = 最下緣）。
 */
export interface LayoutBand {
  readonly key: string;
  readonly top: number;
  readonly bottom: number;
  /** 該帶角色的基準縮放，近大遠小 */
  readonly scale: number;
  /** 水平漂移速度，單位為「每秒畫面寬度的比例」，可為負值 */
  readonly speed: number;
  /** 該帶的基準透明度，越遠越淡 */
  readonly alpha: number;
}

/**
 * 單一角色的運動狀態。
 * 這是每幀被大量讀寫的物件，刻意設計成可變的扁平結構（不用 readonly），
 * 避免 350 隻角色每幀產生大量短命物件造成 GC 壓力。
 */
export interface CharacterMotionState {
  x: number;
  y: number;
  /** 水平速度，單位為每秒像素 */
  vx: number;
  /** 垂直速度，單位為每秒像素 */
  vy: number;
  rotation: number;
  scale: number;
  alpha: number;
  /** 個體相位差，用來讓同帶角色的擺動不同步 */
  phase: number;
  /** 所屬佈局帶在 WorldTemplate.bands 中的索引 */
  bandIndex: number;
}

/** 每幀傳給行為函式的環境資訊 */
export interface WorldFrameContext {
  /** 距離上一幀的秒數，行為必須以此計算位移，不可假設固定 60fps */
  readonly deltaSeconds: number;
  /** 世界啟動至今的秒數，用於週期性動作 */
  readonly elapsedSeconds: number;
  /** 可用的畫面範圍（像素） */
  readonly bounds: Rect;
  /** 該角色所屬的佈局帶 */
  readonly band: LayoutBand;
  /** 該角色目前的顯示半徑（像素），用於邊界判斷與避讓 */
  readonly radius: number;
}

/**
 * 角色的常態行為：如何游動、漂浮、呼吸。
 *
 * 約束一：這兩個函式每幀會對 350 個角色各呼叫一次，
 * 因此不得在其中建立 GSAP timeline、套用 filter 或配置新物件。
 * 一次性的進場演出請放在 WorldTemplate.entrance。
 *
 * 約束二：角色圖片是參與者手繪或含個人照片的，
 * 程式無從得知「哪一邊是頭」。行為實作絕對不可依移動方向水平鏡像
 * ——猜錯會變成倒退游，照片中的人臉與文字也會被翻反。
 * 方向感應以擺動、傾斜等不改變左右的方式表現。
 *
 * 約束三：角色必須留在畫面框內。世界是一個看得見邊界的水族箱，
 * 不做穿越迴繞——那需要角色有明確朝向才成立。
 */
export interface CharacterBehavior {
  readonly key: string;
  /** 角色加入世界時初始化運動狀態，在此賦予個體差異（相位、速度微擾） */
  init(state: CharacterMotionState, ctx: WorldFrameContext): void;
  /** 每幀更新運動狀態 */
  update(state: CharacterMotionState, ctx: WorldFrameContext): void;
}

/** 已實作與規劃中的世界模板 key（規格第 8 節的實作順序） */
export type WorldTemplateKey =
  | "ocean"
  | "forest"
  | "space"
  | "farm"
  | "jungle"
  | "dinosaur"
  | "candy"
  | "christmas"
  | "halloween"
  | "pirate"
  | "magic"
  | "future-city";

/** 世界模板 */
export interface WorldTemplate {
  readonly key: WorldTemplateKey;
  /** 顯示名稱，例如「海洋」 */
  readonly name: string;
  readonly palette: Palette;
  /** 背景層：漸層、光暈、遠景 */
  buildBackground(app: Application): Container;
  /** 環境裝飾：海草、泡泡、星塵等與參與者無關的氛圍物件 */
  buildAmbient(app: Application): Container;
  /** 參與者角色的常態行為 */
  readonly characterBehavior: CharacterBehavior;
  /** 角色進場：從哪個邊緣、用什麼曲線游進來 */
  entrance(sprite: Sprite, bounds: Rect): Timeline;
  /** 佈局帶，由遠至近排列 */
  readonly bands: readonly LayoutBand[];
  /** 抽獎時的聚集動畫 */
  gatherAnimation(sprites: readonly Sprite[], center: Point): Timeline;
}

/**
 * 渲染層看到的角色資料。
 *
 * 這是資料層與渲染層的邊界：不含 device_token 等敏感欄位，
 * 也不含圖片位元，只有一個可直接載入的 URL（規格第 5 節）。
 */
export interface CharacterData {
  readonly id: string;
  readonly displayName: string;
  readonly characterName: string | null;
  /** 角色圖片的完整 URL，由 Storage 路徑解析而來 */
  readonly imageUrl: string;
  /** ISO 8601 時間字串，決定角色分配到哪一帶 */
  readonly joinedAt: string;
}
