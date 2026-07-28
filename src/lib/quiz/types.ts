/** 問答的共用型別（Q0） */

export type QuizPhase = "idle" | "prep" | "answer" | "reveal" | "scoreboard";

export const QUIZ_PHASE_LABEL: Record<QuizPhase, string> = {
  idle: "待機",
  prep: "讀題中",
  answer: "作答中",
  reveal: "公布答案",
  scoreboard: "排行榜",
};

/** 個人賽或分組賽。作答方式完全相同，差別只在排行榜怎麼加總。 */
export type QuizMode = "individual" | "team";

export const QUIZ_MODE_LABEL: Record<QuizMode, string> = {
  individual: "個人賽",
  team: "分組賽",
};

export interface QuizQuestion {
  readonly id: string;
  readonly ordinal: number;
  readonly prompt: string;
  /** 題目配圖的公開網址，沒有就是 null */
  readonly imageUrl: string | null;
  /** 固定四個，順序對應四種海洋生物 */
  readonly options: readonly string[];
  readonly correctIndex: number;
  readonly prepSeconds: number;
  readonly answerSeconds: number;
  readonly points: number;
  /** 這一題已經有幾個人答過 */
  readonly answerCount: number;
}

export interface QuizQuestionInput {
  readonly id: string | null;
  readonly prompt: string;
  readonly imageUrl: string | null;
  readonly options: readonly string[];
  readonly correctIndex: number;
  readonly prepSeconds: number;
  readonly answerSeconds: number;
  readonly points: number;
}

export const NEW_QUESTION: QuizQuestionInput = {
  id: null,
  prompt: "",
  imageUrl: null,
  options: ["", "", "", ""],
  correctIndex: 0,
  prepSeconds: 5,
  answerSeconds: 20,
  points: 1000,
};

/** 手機端的狀態。correct_index 只在公布之後才有值。 */
export interface QuizPlayState {
  readonly phase: QuizPhase;
  readonly questionId: string | null;
  readonly questionNo: number | null;
  readonly questionTotal: number;
  readonly prompt: string | null;
  readonly imageUrl: string | null;
  readonly options: readonly string[] | null;
  readonly prepSeconds: number;
  readonly answerSeconds: number;
  readonly startedAtMs: number | null;
  readonly serverMs: number;
  readonly myChoice: number | null;
  readonly correctIndex: number | null;
  readonly myPoints: number | null;
  readonly myTotal: number;
}

/** 大螢幕的狀態 */
export interface QuizStageState {
  readonly phase: QuizPhase;
  readonly sessionName: string;
  readonly mode: QuizMode;
  readonly questionId: string | null;
  readonly questionNo: number | null;
  readonly questionTotal: number;
  readonly prompt: string | null;
  readonly imageUrl: string | null;
  readonly options: readonly string[] | null;
  readonly prepSeconds: number;
  readonly answerSeconds: number;
  readonly startedAtMs: number | null;
  readonly serverMs: number;
  readonly answeredCount: number;
  readonly playerCount: number;
  readonly correctIndex: number | null;
  readonly optionCounts: readonly number[] | null;
}

export interface IndividualScore {
  readonly playerId: string;
  readonly displayName: string;
  readonly teamName: string;
  readonly teamColor: string;
  readonly totalPoints: number;
  readonly correctCount: number;
}

export interface TeamScore {
  readonly teamId: string;
  readonly tableNo: number;
  readonly name: string;
  readonly color: string;
  readonly creatureKey: string;
  readonly playerCount: number;
  readonly totalPoints: number;
  readonly correctCount: number;
}

/**
 * 從 started_at 推算目前在哪個階段。
 *
 * 手機與大螢幕都自己算，不必為了「準備時間結束了沒」去問伺服器——
 * 那會讓三百支手機每秒打一次資料庫。真正需要輪詢的只有
 * 「換題了沒」與「公布了沒」。
 */
export function timeline(
  serverMs: number,
  startedAtMs: number | null,
  prepSeconds: number,
  answerSeconds: number,
): {
  readonly stage: "prep" | "answer" | "closed";
  /** 這個階段還剩幾秒，向上取整 */
  readonly secondsLeft: number;
  /** 0~1，這個階段走了多少 */
  readonly progress: number;
} {
  if (startedAtMs === null) {
    return { stage: "prep", secondsLeft: prepSeconds, progress: 0 };
  }

  const prepMs = prepSeconds * 1000;
  const answerMs = answerSeconds * 1000;
  const elapsed = serverMs - startedAtMs;

  if (elapsed < prepMs) {
    return {
      stage: "prep",
      secondsLeft: Math.ceil((prepMs - elapsed) / 1000),
      progress: prepMs === 0 ? 1 : elapsed / prepMs,
    };
  }

  const answerElapsed = elapsed - prepMs;
  if (answerElapsed < answerMs) {
    return {
      stage: "answer",
      secondsLeft: Math.ceil((answerMs - answerElapsed) / 1000),
      progress: answerElapsed / answerMs,
    };
  }

  return { stage: "closed", secondsLeft: 0, progress: 1 };
}
