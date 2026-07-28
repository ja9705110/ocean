"use client";

import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import type {
  IndividualScore,
  QuizPhase,
  QuizPlayState,
  QuizQuestion,
  QuizQuestionInput,
  QuizStageState,
  TeamScore,
} from "@/lib/quiz/types";

/** 問答的資料存取（Q0） */

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
    throw new Error(error.message);
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
    throw new Error(error.message);
  }
}

export async function deleteQuizQuestion(questionId: string): Promise<void> {
  const supabase = getSupabaseBrowserClient();
  const { error } = await supabase.rpc("delete_quiz_question", {
    p_question_id: questionId,
  });

  if (error) {
    throw new Error(error.message);
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
    throw new Error(error.message);
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
    throw new Error(error.message);
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
    throw new Error(error.message);
  }
}

export async function setQuizPhase(
  sessionId: string,
  phase: QuizPhase,
): Promise<void> {
  const supabase = getSupabaseBrowserClient();
  const { error } = await supabase.rpc("set_quiz_phase", {
    p_session_id: sessionId,
    p_phase: phase,
  });

  if (error) {
    throw new Error(error.message);
  }
}

// ============================================================
// 作答（手機）
// ============================================================

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
  return message;
}

interface PlayStateRow {
  readonly phase: QuizPhase;
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
    throw new Error(error.message);
  }

  const row = ((data ?? []) as PlayStateRow[])[0];
  if (!row) {
    return null;
  }

  return {
    phase: row.phase,
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
    throw new Error(error.message);
  }

  const row = ((data ?? []) as StageStateRow[])[0];
  if (!row) {
    return null;
  }

  return {
    phase: row.phase,
    sessionName: row.session_name,
    mode: row.mode === "individual" ? "individual" : "team",
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
    throw new Error(error.message);
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
    throw new Error(error.message);
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
