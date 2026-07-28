/**
 * 划槳偵測（G1）。
 *
 * 動作設計：兩手握著手機，兩隻拇指分別壓在畫面下方的左右兩塊上，
 * 一起往下拉是「划」，一起往上回是「回槳」。全程拇指不離開螢幕。
 *
 * 為什麼是這個動作，而不是甩手機或快速點擊：
 * 1. 安全。整場三百多人同時甩手機，手機一定會飛出去。
 *    兩隻拇指都必須留在螢幕上，等於強迫雙手握持。
 * 2. 這是「同步」而不是「速度」的遊戲。拚點擊速度會變成年輕人的
 *    獨角戲；拉槳的幅度與時機是每個人都做得到的事。
 * 3. 兩手同時的要求讓單手偷吃步做不到，也讓「雙手時間差」
 *    成為一個誠實的指標。
 *
 * 這一層是純狀態機：不碰 DOM、不碰 React，時間戳由外部傳入
 * （呼叫端會傳對過時的伺服器時間）。這樣才測得起來。
 */

export type RowingSide = "left" | "right";

/** 兩手都到位才算握好；沒握好就不判定，畫面要提醒使用者 */
export type GripState = "released" | "one-hand" | "held";

/** 划到底之後要回槳才能再划，避免手指停在下方連續觸發 */
export type StrokePhase = "recovered" | "pulled";

export interface RowingStroke {
  /** 兩手各自到位時間的平均，作為這一槳的時刻 */
  readonly atMs: number;
  /** 兩手到位的時間差，越小越同步 */
  readonly handOffsetMs: number;
}

export interface RowingSnapshot {
  readonly grip: GripState;
  readonly phase: StrokePhase;
  /** 這一槳的完成度 0~1，取兩手中較落後的一手 */
  readonly progress: number;
  /** 左右手各自的完成度，用來畫出「哪一手拖到了」 */
  readonly leftProgress: number;
  readonly rightProgress: number;
}

/** 回槳所需距離相對於拉槳距離的比例。稍微放寬，回槳不該是另一個挑戰。 */
const RECOVER_RATIO = 0.7;

/**
 * 一手已到位、另一手遲遲不到，超過這個時間就視為那一下不算。
 * 沒有這道保險，玩家換手或中途停下時會留著一個「半槳」，
 * 下次隨便一動就補成一槳，判定看起來像是自己亂跳。
 */
const STALE_CROSS_MS = 900;

interface HandState {
  pointerId: number;
  y: number;
  /** 目前階段的極值：拉槳階段記最高點，回槳階段記最低點 */
  extremeY: number;
  crossedAtMs: number | null;
}

export interface RowingDetectorOptions {
  /** 一槳需要移動的像素，由呼叫端依畫面高度換算 */
  readonly strokeDistance: number;
}

export class RowingDetector {
  private strokeDistance: number;
  private phase: StrokePhase = "recovered";
  private hands: Record<RowingSide, HandState | null> = {
    left: null,
    right: null,
  };

  constructor(options: RowingDetectorOptions) {
    this.strokeDistance = Math.max(24, options.strokeDistance);
  }

  setStrokeDistance(px: number): void {
    this.strokeDistance = Math.max(24, px);
  }

  pointerDown(side: RowingSide, pointerId: number, y: number): void {
    this.hands[side] = {
      pointerId,
      y,
      extremeY: y,
      crossedAtMs: null,
    };
    // 重新握好時一律從「可以划」開始，不要讓上一次的殘留狀態影響手感
    if (this.grip === "held") {
      this.phase = "recovered";
      this.resetExtremes();
    }
  }

  pointerUp(pointerId: number): void {
    for (const side of ["left", "right"] as const) {
      if (this.hands[side]?.pointerId === pointerId) {
        this.hands[side] = null;
      }
    }
    this.phase = "recovered";
  }

  reset(): void {
    this.hands = { left: null, right: null };
    this.phase = "recovered";
  }

  /**
   * 更新一手的位置。回傳非 null 代表這一下完成了一槳。
   * atMs 必須是伺服器時間軸上的毫秒。
   */
  pointerMove(pointerId: number, y: number, atMs: number): RowingStroke | null {
    const side = this.sideOf(pointerId);
    if (side === null) {
      return null;
    }

    const hand = this.hands[side];
    const other = this.hands[side === "left" ? "right" : "left"];
    if (!hand) {
      return null;
    }

    hand.y = y;

    // 兩手沒有都在螢幕上就不判定，但位置仍要跟著更新，
    // 否則另一手放上來的瞬間會拿到一個過期的起點
    if (!other) {
      hand.extremeY = y;
      hand.crossedAtMs = null;
      return null;
    }

    this.expireStaleCross(hand, atMs);
    this.expireStaleCross(other, atMs);

    if (this.phase === "recovered") {
      // 往上移動代表還在拉開起手位置，起點跟著上移
      if (hand.crossedAtMs === null && y < hand.extremeY) {
        hand.extremeY = y;
      }
      if (hand.crossedAtMs === null && y - hand.extremeY >= this.strokeDistance) {
        hand.crossedAtMs = atMs;
      }

      if (hand.crossedAtMs !== null && other.crossedAtMs !== null) {
        const stroke: RowingStroke = {
          atMs: (hand.crossedAtMs + other.crossedAtMs) / 2,
          handOffsetMs: Math.abs(hand.crossedAtMs - other.crossedAtMs),
        };
        this.phase = "pulled";
        this.resetExtremes();
        return stroke;
      }
      return null;
    }

    // 回槳：往下移動代表還沒開始回，最低點跟著下移
    const recoverDistance = this.strokeDistance * RECOVER_RATIO;
    if (hand.crossedAtMs === null && y > hand.extremeY) {
      hand.extremeY = y;
    }
    if (hand.crossedAtMs === null && hand.extremeY - y >= recoverDistance) {
      hand.crossedAtMs = atMs;
    }

    if (hand.crossedAtMs !== null && other.crossedAtMs !== null) {
      this.phase = "recovered";
      this.resetExtremes();
    }
    return null;
  }

  get grip(): GripState {
    const count = (this.hands.left ? 1 : 0) + (this.hands.right ? 1 : 0);
    if (count === 2) {
      return "held";
    }
    return count === 1 ? "one-hand" : "released";
  }

  get snapshot(): RowingSnapshot {
    const left = this.progressOf("left");
    const right = this.progressOf("right");
    return {
      grip: this.grip,
      phase: this.phase,
      progress: Math.min(left, right),
      leftProgress: left,
      rightProgress: right,
    };
  }

  private sideOf(pointerId: number): RowingSide | null {
    if (this.hands.left?.pointerId === pointerId) {
      return "left";
    }
    if (this.hands.right?.pointerId === pointerId) {
      return "right";
    }
    return null;
  }

  private progressOf(side: RowingSide): number {
    const hand = this.hands[side];
    if (!hand || this.grip !== "held") {
      return 0;
    }
    if (hand.crossedAtMs !== null) {
      return 1;
    }

    const travelled =
      this.phase === "recovered"
        ? hand.y - hand.extremeY
        : hand.extremeY - hand.y;
    const needed =
      this.phase === "recovered"
        ? this.strokeDistance
        : this.strokeDistance * RECOVER_RATIO;

    return Math.min(Math.max(travelled / needed, 0), 1);
  }

  private expireStaleCross(hand: HandState, atMs: number): void {
    if (hand.crossedAtMs !== null && atMs - hand.crossedAtMs > STALE_CROSS_MS) {
      hand.crossedAtMs = null;
      hand.extremeY = hand.y;
    }
  }

  private resetExtremes(): void {
    for (const side of ["left", "right"] as const) {
      const hand = this.hands[side];
      if (hand) {
        hand.extremeY = hand.y;
        hand.crossedAtMs = null;
      }
    }
  }

}

/**
 * 依可用高度換算一槳的距離。
 *
 * 太短會被手指自然的抖動誤觸發，太長則拇指構不到——
 * 拇指在握持狀態下的舒適行程大約是 70 到 120 像素。
 */
export function strokeDistanceFor(padHeightPx: number): number {
  return Math.min(Math.max(padHeightPx * 0.34, 62), 118);
}
