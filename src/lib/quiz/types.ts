/** 問答的共用型別（Q0） */

export type QuizPhase = "idle" | "prep" | "answer" | "reveal" | "scoreboard";

export const QUIZ_PHASE_LABEL: Record<QuizPhase, string> = {
  idle: "待機",
  prep: "讀題中",
  answer: "作答中",
  reveal: "公布答案",
  scoreboard: "排行榜",
};

/**
 * 三種玩法。題目、計時、公布流程完全共用，
 * 差別只在「誰能按」與「分數怎麼加總」。
 */
export type QuizMode = "individual" | "team" | "captain";

export const QUIZ_MODE_LABEL: Record<QuizMode, string> = {
  individual: "個人賽",
  team: "分組賽",
  captain: "隊長代表賽",
};

export const QUIZ_MODE_HINT: Record<QuizMode, string> = {
  individual: "每個人都在自己手機上作答，排行榜看個人。",
  team: "每個人都在自己手機上作答，同桌分數加總。",
  captain: "每桌推派一位隊長，只有隊長的手機能按，隊長的分數就是全桌的分數。",
};

/**
 * 預設是隊長代表賽：現在的活動就是以一桌為單位、由桌長統籌意見後作答。
 * 沒有明確設定時走這一個，才不會有人建了場次卻發現變成個人賽。
 */
export function parseQuizMode(value: unknown): QuizMode {
  return value === "individual" || value === "team" ? value : "captain";
}

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
  /** 公布正確答案停留多久才跳到分數 */
  readonly revealSeconds: number;
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
  readonly revealSeconds: number;
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
  revealSeconds: 6,
  points: 1000,
};

/** 手機端的狀態。correct_index 只在公布之後才有值。 */
export interface QuizPlayState {
  readonly phase: QuizPhase;
  readonly mode: QuizMode;
  /** 隊長代表賽時，只有這個人的按鈕會生效 */
  readonly iAmCaptain: boolean;
  /** 本桌隊長的姓名，還沒推派就是 null */
  readonly captainName: string | null;
  readonly questionId: string | null;
  readonly questionNo: number | null;
  readonly questionTotal: number;
  readonly prompt: string | null;
  readonly imageUrl: string | null;
  readonly options: readonly string[] | null;
  readonly prepSeconds: number;
  readonly answerSeconds: number;
  readonly revealSeconds: number;
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
  readonly revealSeconds: number;
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
 * 作答截止之後的寬限期，必須與資料庫的 quiz_answer_grace_ms() 一致。
 * 有人壓線按下去、封包晚兩百毫秒才到，那一下不該被丟掉；
 * 而正解要等寬限期過了才准出現，否則畫面已經公布卻還收得到答案。
 */
export const ANSWER_GRACE_MS = 1500;

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
