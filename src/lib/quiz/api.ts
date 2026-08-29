"use client";

import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { parseQuizMode } from "@/lib/quiz/types";
import { quizTheme } from "@/lib/quiz/themes";
import type { QuizTheme } from "@/lib/quiz/themes";
import type {
  IndividualScore,
  LobbyTeam,
  QuizPhase,
  QuizPlayState,
  QuizQuestion,
  QuizQuestionInput,
  QuizStageState,
  TeamScore,
} from "@/lib/quiz/types";

/** 問答的資料存取（Q0） */

/**
 * 把 PostgREST 的「找不到函式」翻成看得懂的下一步。
 *
 * 原始訊息是英文的 Could not find the function ... in the schema cache，
 * 看起來像程式壞了，實際上幾乎都是「問答的 SQL 還沒安裝到這個資料庫」。
 * 現場看到這行字的人需要知道要做什麼，不是需要知道 PostgREST 的內部名詞。
 */
function translateRpcError(message: string): string {
  if (
    message.includes("schema cache") ||
    message.includes("Could not find the function")
  ) {
    return "這個資料庫還沒安裝問答功能。請到 Supabase 的 SQL Editor 執行 setup_quiz.sql（貼上後按 Ctrl/Cmd + A 全選再 Run），完成後重新整理這一頁。";
  }
  return message;
}

function toNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * 取得場次的主題。
 *
 * 直接查資料表而不是走 RPC：主題只是 config 裡的一個字串，
 * 為它多改一支 RPC 就多一次「函式快取找不到」的風險，
 * 而 game_sessions 本來就對匿名端開放唯讀（大螢幕也要看得到）。
 *
 * 主題在一場遊戲中不會變，所以只在畫面掛載時查一次。
 */
export async function getSessionTheme(sessionId: string): Promise<QuizTheme> {
  const supabase = getSupabaseBrowserClient();
  const { data, error } = await supabase
    .from("game_sessions")
    .select("config")
    .eq("id", sessionId)
    .maybeSingle();

  if (error) {
    // 查不到就用預設主題，不要為了配色讓整個畫面開不起來
    return quizTheme(null);
  }

  const config = (data?.config ?? {}) as Record<string, unknown>;
  return quizTheme(config.theme);
}

// ============================================================
// 出題（主持人）
// ============================================================

interface QuestionRow {
  readonly id: string;
  readonly ordinal: number;
  readonly prompt: string;
  readonly image_url: string | null;
  readonly options: string[];
  readonly correct_index: number;
  readonly prep_seconds: number;
  readonly answer_seconds: number;
  readonly reveal_seconds: number;
  readonly points: number;
  readonly answer_count: number | string;
}

export async function listQuizQuestions(
  sessionId: string,
): Promise<QuizQuestion[]> {
  const supabase = getSupabaseBrowserClient();
  const { data, error } = await supabase.rpc("list_quiz_questions", {
    p_session_id: sessionId,
  });

  if (error) {
    throw new Error(translateRpcError(error.message));
  }

  return ((data ?? []) as QuestionRow[]).map((row) => ({
    id: row.id,
    ordinal: row.ordinal,
    prompt: row.prompt,
    imageUrl: row.image_url,
    options: row.options,
    correctIndex: row.correct_index,
    prepSeconds: row.prep_seconds,
    answerSeconds: row.answer_seconds,
    revealSeconds: row.reveal_seconds,
    points: row.points,
    answerCount: toNumber(row.answer_count),
  }));
}

export async function saveQuizQuestion(
  sessionId: string,
  input: QuizQuestionInput,
): Promise<void> {
  const supabase = getSupabaseBrowserClient();
  const { error } = await supabase.rpc("upsert_quiz_question", {
    p_session_id: sessionId,
    p_question_id: input.id,
    p_prompt: input.prompt,
    p_options: input.options,
    p_correct_index: input.correctIndex,
    p_prep_seconds: input.prepSeconds,
    p_answer_seconds: input.answerSeconds,
    p_points: input.points,
    p_image_url: input.imageUrl,
    p_reveal_seconds: input.revealSeconds,
  });

  if (error) {
    throw new Error(translateRpcError(error.message));
  }
}

export async function deleteQuizQuestion(questionId: string): Promise<void> {
  const supabase = getSupabaseBrowserClient();
  const { error } = await supabase.rpc("delete_quiz_question", {
    p_question_id: questionId,
  });

  if (error) {
    throw new Error(translateRpcError(error.message));
  }
}

export async function moveQuizQuestion(
  questionId: string,
  direction: -1 | 1,
): Promise<void> {
  const supabase = getSupabaseBrowserClient();
  const { error } = await supabase.rpc("move_quiz_question", {
    p_question_id: questionId,
    p_direction: direction,
  });

  if (error) {
    throw new Error(translateRpcError(error.message));
  }
}

// ============================================================
// 進行（主持人）
// ============================================================

export async function startQuizQuestion(
  sessionId: string,
  questionId: string,
): Promise<void> {
  const supabase = getSupabaseBrowserClient();
  const { error } = await supabase.rpc("start_quiz_question", {
    p_session_id: sessionId,
    p_question_id: questionId,
  });

  if (error) {
    throw new Error(translateRpcError(error.message));
  }
}

/**
 * 提前結束作答。
 *
 * 之後的公布與排行榜一樣由時間自動推進，主持人不需要再按任何東西。
 */
export async function endAnswerEarly(sessionId: string): Promise<void> {
  const supabase = getSupabaseBrowserClient();
  const { error } = await supabase.rpc("end_answer_early", {
    p_session_id: sessionId,
  });

  if (error) {
    throw new Error(translateRpcError(error.message));
  }
}

/**
 * 讓大螢幕與手機立刻跳到某一段（C22）。
 *
 * 不要改用 set_quiz_phase：那支只寫 game_sessions.phase 那一欄，
 * 但兩端看到的階段是 quiz_phase_at() 依 started_at 推算的，
 * 而它只認 'idle'，其他一律看時間。寫了那一欄，畫面完全不動。
 *
 * jump_quiz_phase 改成把 started_at 往回挪，讓時間軸本身落在要的那一段
 * ——跟「提早收答案」同一個做法。
 */
export async function jumpQuizPhase(
  sessionId: string,
  phase: QuizPhase,
): Promise<void> {
  const supabase = getSupabaseBrowserClient();
  const { error } = await supabase.rpc("jump_quiz_phase", {
    p_session_id: sessionId,
    p_phase: phase,
  });

  if (error) {
    throw new Error(translateRpcError(error.message));
  }
}

// ============================================================
// 作答（手機）
// ============================================================

/**
 * 搶當本桌的隊長。先按先贏，搶輸了不算錯誤——
 * 現場兩個人同時按是常態，跳錯誤只會讓人以為壞掉。
 */
export async function claimCaptain(
  sessionId: string,
  deviceToken: string,
): Promise<{ readonly captainName: string | null; readonly iAmCaptain: boolean }> {
  const supabase = getSupabaseBrowserClient();
  const { data, error } = await supabase.rpc("claim_captain", {
    p_session_id: sessionId,
    p_device_token: deviceToken,
  });

  if (error) {
    throw new Error(translateRpcError(error.message));
  }

  const row = ((data ?? []) as {
    captain_name: string | null;
    i_am_captain: boolean;
  }[])[0];

  return {
    captainName: row?.captain_name ?? null,
    iAmCaptain: row?.i_am_captain ?? false,
  };
}

/** 主持人改派隊長。隊長手機沒電或臨時離席時用。 */
export async function setTeamCaptain(playerId: string): Promise<void> {
  const supabase = getSupabaseBrowserClient();
  const { error } = await supabase.rpc("set_team_captain", {
    p_player_id: playerId,
  });

  if (error) {
    throw new Error(translateRpcError(error.message));
  }
}

/**
 * 清掉一題的所有作答（C19）。
 *
 * 只在那一題真的作廢時用：題目打錯、選項貼錯、或搶答時網路出問題
 * 整桌沒送出去。單純想再放一次題目不要用這支——重新顯示不該讓
 * 已經答對的人失去分數，直接再 startQuizQuestion 一次就好。
 *
 * 回傳清掉幾筆，讓主持人知道剛才動到多少人。
 */
export async function resetQuizQuestion(questionId: string): Promise<number> {
  const supabase = getSupabaseBrowserClient();
  const { data, error } = await supabase.rpc("reset_quiz_question", {
    p_question_id: questionId,
  });

  if (error) {
    throw new Error(translateRpcError(error.message));
  }
  return toNumber(data);
}

export async function submitQuizAnswer(
  questionId: string,
  deviceToken: string,
  choiceIndex: number,
): Promise<void> {
  const supabase = getSupabaseBrowserClient();
  const { error } = await supabase.rpc("submit_quiz_answer", {
    p_question_id: questionId,
    p_device_token: deviceToken,
    p_choice_index: choiceIndex,
  });

  if (error) {
    throw new Error(translateAnswerError(error.message));
  }
}

function translateAnswerError(message: string): string {
  if (message.includes("schema cache")) {
    return translateRpcError(message);
  }
  if (message.includes("ANSWER_NOT_OPEN")) {
    return "還在讀題時間，等一下就可以按了。";
  }
  if (message.includes("TOO_LATE")) {
    return "這一題的時間到了。";
  }
  if (message.includes("NOT_SEATED")) {
    return "這台手機還沒入座，請重新掃桌卡。";
  }
  if (message.includes("QUESTION_NOT_ACTIVE")) {
    return "題目已經換了，等下一題。";
  }
  if (message.includes("NOT_CAPTAIN")) {
    return "這一場由隊長代表作答。";
  }
  return message;
}

interface PlayStateRow {
  readonly phase: QuizPhase;
  readonly mode: string | null;
  readonly i_am_captain: boolean | null;
  readonly captain_name: string | null;
  readonly question_id: string | null;
  readonly question_no: number | null;
  readonly question_total: number | string;
  readonly prompt: string | null;
  readonly image_url: string | null;
  readonly options: string[] | null;
  readonly prep_seconds: number | null;
  readonly answer_seconds: number | null;
  readonly reveal_seconds: number | null;
  readonly started_at_ms: number | string | null;
  readonly server_ms: number | string;
  readonly my_choice: number | null;
  readonly correct_index: number | null;
  readonly my_points: number | null;
  readonly my_total: number | string | null;
  /** 舊版的 SQL 還沒裝上去時這三欄會是 undefined */
  readonly show_prompt?: boolean;
  readonly show_options?: boolean;
  readonly show_chat?: boolean;
}

export async function getQuizPlayState(
  sessionId: string,
  deviceToken: string,
): Promise<QuizPlayState | null> {
  const supabase = getSupabaseBrowserClient();
  const { data, error } = await supabase.rpc("get_quiz_play_state", {
    p_session_id: sessionId,
    p_device_token: deviceToken,
  });

  if (error) {
    throw new Error(translateRpcError(error.message));
  }

  const row = ((data ?? []) as PlayStateRow[])[0];
  if (!row) {
    return null;
  }

  return {
    phase: row.phase,
    mode: parseQuizMode(row.mode),
    iAmCaptain: row.i_am_captain ?? false,
    captainName: row.captain_name,
    questionId: row.question_id,
    questionNo: row.question_no,
    questionTotal: toNumber(row.question_total),
    prompt: row.prompt,
    imageUrl: row.image_url,
    options: row.options,
    prepSeconds: toNumber(row.prep_seconds, 5),
    answerSeconds: toNumber(row.answer_seconds, 20),
    revealSeconds: toNumber(row.reveal_seconds, 6),
    startedAtMs: toNullableNumber(row.started_at_ms),
    serverMs: toNumber(row.server_ms, Date.now()),
    myChoice: row.my_choice,
    correctIndex: row.correct_index,
    myPoints: row.my_points,
    myTotal: toNumber(row.my_total),
    // 舊的 SQL 還沒裝上去時這三欄是 undefined，退回原本的行為
    showPrompt: row.show_prompt === true,
    showOptions: row.show_options !== false,
    showChat: row.show_chat !== false,
  };
}

// ============================================================
// 大螢幕
// ============================================================

interface StageStateRow extends PlayStateRow {
  readonly session_name: string;
  readonly mode: string;
  readonly answered_count: number | string;
  readonly player_count: number | string;
  readonly option_counts: number[] | null;
}

export async function getQuizStageState(
  sessionId: string,
): Promise<QuizStageState | null> {
  const supabase = getSupabaseBrowserClient();
  const { data, error } = await supabase.rpc("get_quiz_stage_state", {
    p_session_id: sessionId,
  });

  if (error) {
    throw new Error(translateRpcError(error.message));
  }

  const row = ((data ?? []) as StageStateRow[])[0];
  if (!row) {
    return null;
  }

  return {
    phase: row.phase,
    sessionName: row.session_name,
    mode: parseQuizMode(row.mode),
    questionId: row.question_id,
    questionNo: row.question_no,
    questionTotal: toNumber(row.question_total),
    prompt: row.prompt,
    imageUrl: row.image_url,
    options: row.options,
    prepSeconds: toNumber(row.prep_seconds, 5),
    answerSeconds: toNumber(row.answer_seconds, 20),
    revealSeconds: toNumber(row.reveal_seconds, 6),
    startedAtMs: toNullableNumber(row.started_at_ms),
    serverMs: toNumber(row.server_ms, Date.now()),
    answeredCount: toNumber(row.answered_count),
    playerCount: toNumber(row.player_count),
    correctIndex: row.correct_index,
    optionCounts: row.option_counts,
  };
}

// ============================================================
// 排行榜
// ============================================================

export async function getIndividualScores(
  sessionId: string,
  limit = 10,
): Promise<IndividualScore[]> {
  const supabase = getSupabaseBrowserClient();
  const { data, error } = await supabase.rpc("quiz_individual_leaderboard", {
    p_session_id: sessionId,
    p_limit: limit,
  });

  if (error) {
    throw new Error(translateRpcError(error.message));
  }

  return (
    (data ?? []) as {
      player_id: string;
      display_name: string;
      team_name: string;
      team_color: string;
      total_points: number;
      correct_count: number;
    }[]
  ).map((row) => ({
    playerId: row.player_id,
    displayName: row.display_name,
    teamName: row.team_name,
    teamColor: row.team_color,
    totalPoints: toNumber(row.total_points),
    correctCount: toNumber(row.correct_count),
  }));
}

export async function getTeamScores(sessionId: string): Promise<TeamScore[]> {
  const supabase = getSupabaseBrowserClient();
  const { data, error } = await supabase.rpc("quiz_team_leaderboard", {
    p_session_id: sessionId,
  });

  if (error) {
    throw new Error(translateRpcError(error.message));
  }

  return (
    (data ?? []) as {
      team_id: string;
      table_no: number;
      name: string;
      color: string;
      creature_key: string;
      player_count: number;
      total_points: number;
      correct_count: number;
    }[]
  ).map((row) => ({
    teamId: row.team_id,
    tableNo: row.table_no,
    name: row.name,
    color: row.color,
    creatureKey: row.creature_key,
    playerCount: toNumber(row.player_count),
    totalPoints: toNumber(row.total_points),
    correctCount: toNumber(row.correct_count),
  }));
}

/**
 * 開場等待時的各桌狀態（C16）。
 *
 * 大螢幕在還沒出題的時候一直問這個。它比排行榜輕：只讀 teams 那一列
 * 加上一次桌長查詢，沒有作答的彙總，兩秒一次不會有負擔。
 */
export async function getLobbyBoard(sessionId: string): Promise<LobbyTeam[]> {
  const supabase = getSupabaseBrowserClient();
  const { data, error } = await supabase.rpc("get_lobby_board", {
    p_session_id: sessionId,
  });

  if (error) {
    throw new Error(translateRpcError(error.message));
  }

  return (
    (data ?? []) as {
      id: string;
      table_no: number;
      name: string;
      color: string;
      creature_key: string;
      player_count: number;
      captain_name: string | null;
    }[]
  ).map((row) => ({
    teamId: row.id,
    tableNo: row.table_no,
    name: row.name,
    color: row.color,
    creatureKey: row.creature_key,
    playerCount: toNumber(row.player_count),
    captainName: row.captain_name,
  }));
}

// ============================================================
// 同桌聊天（C13 的資料層 ＋ C22 的畫面）
// ============================================================

export interface TableMessage {
  readonly id: string;
  readonly kind: "text" | "sticker";
  readonly body: string;
  readonly playerId: string;
  readonly displayName: string;
  readonly isCaptain: boolean;
  readonly createdAtMs: number;
}

export interface TableChat {
  readonly teamId: string;
  readonly myPlayerId: string;
  readonly iAmCaptain: boolean;
  /** true 表示 messages 只是「新的那幾則」，要接在既有的後面而不是取代 */
  readonly incremental: boolean;
  readonly messages: readonly TableMessage[];
}

/**
 * 讀同桌的訊息。
 *
 * 只看得到自己那一桌——別桌的討論在問答裡就是答案。
 * 後端從 device_token 認人，前端傳不了「我想看第 3 桌」。
 */
export async function listTableMessages(
  sessionId: string,
  deviceToken: string,
  /**
   * 只要這個時間之後的訊息（C25）。
   *
   * 保險輪詢一定要帶它。不帶的話每六秒都會把整整 50 則重送一次——
   * 量過是 9.3 KB，280 支手機就是每秒 436 KB，而且內容通常一個字都沒變。
   * 帶了之後常態的回應是空陣列，大約 100 位元組。
   */
  sinceMs?: number | null,
): Promise<TableChat | null> {
  const supabase = getSupabaseBrowserClient();
  const { data, error } = await supabase.rpc("list_table_messages", {
    p_session_id: sessionId,
    p_device_token: deviceToken,
    p_since:
      sinceMs === undefined || sinceMs === null
        ? null
        : new Date(sinceMs).toISOString(),
  });

  if (error) {
    // 還沒入座就沒有桌可以看，這不是錯誤，是還沒輪到
    if (error.message.includes("NOT_SEATED")) {
      return null;
    }
    throw new Error(translateRpcError(error.message));
  }

  const row = data as {
    team_id: string;
    my_player_id: string;
    i_am_captain: boolean;
    incremental?: boolean;
    messages: {
      id: string;
      kind: string;
      body: string;
      player_id: string;
      display_name: string;
      is_captain: boolean;
      created_at: string;
    }[];
  } | null;

  if (!row) {
    return null;
  }

  return {
    teamId: row.team_id,
    myPlayerId: row.my_player_id,
    iAmCaptain: row.i_am_captain,
    incremental: row.incremental === true,
    messages: (row.messages ?? []).map((m) => ({
      id: m.id,
      kind: m.kind === "sticker" ? "sticker" : "text",
      body: m.body,
      playerId: m.player_id,
      displayName: m.display_name,
      isCaptain: m.is_captain,
      createdAtMs: new Date(m.created_at).getTime(),
    })),
  };
}

/**
 * 送一則訊息。
 *
 * 後端有 1.2 秒的間隔限制。那不是為了防呆，是為了三百支手機——
 * 一桌十個人搶著按貼圖，沒有間隔就是每秒好幾十次寫入。
 * 撞到限制時不要跳錯誤打斷討論，安靜地不送就好。
 */
export async function sendTableMessage(
  sessionId: string,
  deviceToken: string,
  kind: "text" | "sticker",
  body: string,
): Promise<boolean> {
  const supabase = getSupabaseBrowserClient();
  const { error } = await supabase.rpc("send_table_message", {
    p_session_id: sessionId,
    p_device_token: deviceToken,
    p_kind: kind,
    p_body: body,
  });

  if (error) {
    if (error.message.includes("TOO_FAST")) {
      return false;
    }
    if (error.message.includes("EMPTY_MESSAGE")) {
      return false;
    }
    throw new Error(translateRpcError(error.message));
  }
  return true;
}
