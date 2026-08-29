"use client";

import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import type {
  GameSession,
  GameSessionStatus,
  JoinedSeat,
  PlayState,
  Team,
  TeamPlayer,
} from "@/lib/game/types";

/** 遊戲模式的資料存取（G0） */

interface SessionRow {
  readonly id: string;
  readonly game_key: string;
  readonly name: string;
  readonly status: GameSessionStatus;
  readonly round_no: number;
  readonly config: Record<string, unknown> | null;
  readonly started_at_ms: number | string | null;
  readonly team_count: number | string | null;
  readonly player_count: number | string | null;
  readonly created_at: string;
}

/** bigint 在 PostgREST 是以字串回傳的，一律過一次 Number */
function toMs(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toSession(row: SessionRow): GameSession {
  return {
    id: row.id,
    gameKey: row.game_key,
    name: row.name,
    status: row.status,
    roundNo: row.round_no,
    config: row.config ?? {},
    startedAtMs: toMs(row.started_at_ms),
    teamCount: Number(row.team_count ?? 0),
    playerCount: Number(row.player_count ?? 0),
    createdAt: row.created_at,
  };
}

export async function listGameSessions(
  eventId: string,
): Promise<GameSession[]> {
  const supabase = getSupabaseBrowserClient();
  const { data, error } = await supabase.rpc("list_event_game_sessions", {
    p_event_id: eventId,
  });

  if (error) {
    throw new Error(error.message);
  }
  return ((data ?? []) as SessionRow[]).map(toSession);
}

export interface CreateGameSessionInput {
  readonly eventId: string;
  readonly gameKey: string;
  readonly name: string;
  readonly teamCount: number;
  readonly config?: Record<string, unknown>;
}

export async function createGameSession(
  input: CreateGameSessionInput,
): Promise<string> {
  const supabase = getSupabaseBrowserClient();
  const { data, error } = await supabase.rpc("create_game_session", {
    p_event_id: input.eventId,
    p_game_key: input.gameKey,
    p_name: input.name,
    p_team_count: input.teamCount,
    p_config: input.config ?? {},
  });

  if (error) {
    throw new Error(error.message);
  }
  return (data as { id: string }).id;
}

/**
 * 刪除遊戲房間。
 *
 * 要把場次名稱一起送上去：這是不可逆的，而場次選單裡「測試」跟正式那一場
 * 長得很像。刪掉之後隊伍、玩家、分數、題目、作答、桌長票、同桌訊息
 * 全部一起消失。後端會自己再比對一次擁有者與名稱。
 */
export async function deleteGameSession(
  sessionId: string,
  name: string,
): Promise<void> {
  const supabase = getSupabaseBrowserClient();
  const { error } = await supabase.rpc("delete_game_session", {
    p_session_id: sessionId,
    p_name: name,
  });

  if (error) {
    if (error.message.includes("NAME_MISMATCH")) {
      throw new Error("場次名稱不符，沒有刪除任何東西。");
    }
    if (error.message.includes("SESSION_NOT_FOUND")) {
      throw new Error("找不到這個場次，或它不屬於你的活動。");
    }
    throw new Error(error.message);
  }
}

export async function updateSessionStatus(
  sessionId: string,
  status: GameSessionStatus,
): Promise<void> {
  const supabase = getSupabaseBrowserClient();
  const { error } = await supabase
    .from("game_sessions")
    .update({ status })
    .eq("id", sessionId);

  if (error) {
    throw new Error(error.message);
  }
}

/**
 * 更新場次設定（靈敏度、回合長度…）。
 *
 * 與既有設定合併而不是整份覆蓋：日後新增欄位時，
 * 舊版主持人端送出的設定不會把新欄位洗掉。
 */
export async function updateSessionConfig(
  sessionId: string,
  current: Record<string, unknown>,
  patch: Record<string, unknown>,
): Promise<void> {
  const supabase = getSupabaseBrowserClient();
  const { error } = await supabase
    .from("game_sessions")
    .update({ config: { ...current, ...patch } })
    .eq("id", sessionId);

  if (error) {
    throw new Error(error.message);
  }
}

/**
 * 開始新回合（G1）。
 *
 * 起始時刻只能由伺服器決定。主持人裝置的時鐘和玩家的一樣不可信，
 * 若讓前端算好時間再寫進去，全場的節拍就會整體偏掉主持人時鐘的誤差。
 *
 * leadInMs 是給手機的緩衝：收到狀態、對時、把手擺好都需要時間。
 */
export async function startRound(
  sessionId: string,
  leadInMs = 6000,
): Promise<number | null> {
  const supabase = getSupabaseBrowserClient();
  const { data, error } = await supabase.rpc("start_round", {
    p_session_id: sessionId,
    p_lead_in_ms: leadInMs,
  });

  if (error) {
    throw new Error(error.message);
  }

  const row = data as { started_at: string | null } | null;
  const startedAt = row?.started_at;
  return startedAt ? new Date(startedAt).getTime() : null;
}

/** 收回本回合，回到大廳。喊卡或要重跑一次時用。 */
export async function endRound(sessionId: string): Promise<void> {
  const supabase = getSupabaseBrowserClient();
  const { error } = await supabase.rpc("end_round", {
    p_session_id: sessionId,
  });

  if (error) {
    throw new Error(error.message);
  }
}

/** 手機端輪詢的回合狀態 */
export async function getPlayState(sessionId: string): Promise<PlayState | null> {
  const supabase = getSupabaseBrowserClient();
  const { data, error } = await supabase.rpc("get_play_state", {
    p_session_id: sessionId,
  });

  if (error) {
    throw new Error(error.message);
  }

  const rows = (data ?? []) as {
    status: GameSessionStatus;
    round_no: number;
    game_key: string;
    started_at_ms: number | string | null;
    config: Record<string, unknown> | null;
    server_ms: number | string;
  }[];
  const row = rows[0];

  if (!row) {
    return null;
  }

  return {
    status: row.status,
    roundNo: row.round_no,
    gameKey: row.game_key,
    startedAtMs: toMs(row.started_at_ms),
    config: row.config ?? {},
    serverMs: toMs(row.server_ms) ?? Date.now(),
  };
}

interface TeamRow {
  readonly id: string;
  readonly table_no: number;
  readonly name: string;
  readonly join_code: string;
  readonly color: string;
  readonly creature_key: string;
  readonly player_count: number;
}

export async function listTeams(sessionId: string): Promise<Team[]> {
  const supabase = getSupabaseBrowserClient();
  const { data, error } = await supabase.rpc("list_session_teams", {
    p_session_id: sessionId,
  });

  if (error) {
    throw new Error(error.message);
  }

  return ((data ?? []) as TeamRow[]).map((row) => ({
    id: row.id,
    tableNo: row.table_no,
    name: row.name,
    joinCode: row.join_code,
    color: row.color,
    creatureKey: row.creature_key,
    playerCount: row.player_count,
  }));
}

export async function listTeamPlayers(teamId: string): Promise<TeamPlayer[]> {
  const supabase = getSupabaseBrowserClient();
  const { data, error } = await supabase.rpc("list_team_players", {
    p_team_id: teamId,
  });

  if (error) {
    throw new Error(error.message);
  }

  return (
    (data ?? []) as {
      id: string;
      display_name: string;
      participant_id: string | null;
      is_captain: boolean | null;
    }[]
  ).map((row) => ({
    id: row.id,
    displayName: row.display_name,
    participantId: row.participant_id,
    isCaptain: row.is_captain ?? false,
  }));
}

export async function renameTeam(teamId: string, name: string): Promise<void> {
  const supabase = getSupabaseBrowserClient();
  const { error } = await supabase
    .from("teams")
    .update({ name: name.trim() })
    .eq("id", teamId);

  if (error) {
    throw new Error(error.message);
  }
}

/** 以桌卡上的加入碼入座 */
export async function joinGame(
  joinCode: string,
  deviceToken: string,
  displayName: string,
): Promise<JoinedSeat> {
  const supabase = getSupabaseBrowserClient();
  const { data, error } = await supabase.rpc("join_game", {
    p_join_code: joinCode,
    p_device_token: deviceToken,
    p_display_name: displayName,
  });

  if (error) {
    throw new Error(translateJoinError(error.message));
  }

  const rows = (data ?? []) as {
    session_id: string;
    session_status: GameSessionStatus;
    game_key: string;
    team_id: string;
    team_name: string;
    team_color: string;
    team_creature: string;
    table_no: number;
    player_id: string;
  }[];
  const row = rows[0];

  if (!row) {
    throw new Error("加入失敗，請再試一次。");
  }

  return {
    sessionId: row.session_id,
    sessionStatus: row.session_status,
    gameKey: row.game_key,
    teamId: row.team_id,
    teamName: row.team_name,
    teamColor: row.team_color,
    teamCreature: row.team_creature,
    tableNo: row.table_no,
    playerId: row.player_id,
  };
}

function translateJoinError(message: string): string {
  if (message.includes("TEAM_NOT_FOUND")) {
    return "找不到這個桌號代碼。請確認掃的是自己桌上的那張卡。";
  }
  if (message.includes("SESSION_FINISHED")) {
    return "這場遊戲已經結束了。";
  }
  return message;
}

/**
 * 把一位玩家請出場次（C27）。
 *
 * 最常用的情況是掃錯桌卡——他自己重掃沒有用，join_game 認的是裝置，
 * 同一支手機在同一場只會有一個座位。踢掉之後他重掃就能坐到對的那一桌。
 *
 * 他在這場的作答、投票、訊息會跟著走：在錯的隊伍裡拿的分數本來就不該留。
 * 回傳踢掉的是誰、以及他是不是桌長——是的話那一桌現在沒有人能按了。
 */
export async function removeGamePlayer(
  playerId: string,
): Promise<{ readonly displayName: string; readonly wasCaptain: boolean }> {
  const supabase = getSupabaseBrowserClient();
  const { data, error } = await supabase.rpc("remove_game_player", {
    p_player_id: playerId,
  });

  if (error) {
    if (error.message.includes("PLAYER_NOT_FOUND")) {
      throw new Error("找不到這位玩家，或他不屬於你的活動。");
    }
    throw new Error(error.message);
  }

  const row = (data ?? {}) as {
    display_name?: string;
    was_captain?: boolean;
  };
  return {
    displayName: row.display_name ?? "",
    wasCaptain: row.was_captain === true,
  };
}

/**
 * 把整場的人清空（C27）。
 *
 * 彩排完要做的事。所有人、所有分數、所有討論都會消失，桌子與題目留著。
 * 要把場次名稱一起送上來對過——這一下不能只靠一個「你確定嗎」。
 */
export async function resetGamePlayers(
  sessionId: string,
  name: string,
): Promise<number> {
  const supabase = getSupabaseBrowserClient();
  const { data, error } = await supabase.rpc("reset_game_players", {
    p_session_id: sessionId,
    p_name: name,
  });

  if (error) {
    if (error.message.includes("NAME_MISMATCH")) {
      throw new Error("場次名稱不符，沒有清掉任何人。");
    }
    if (error.message.includes("SESSION_NOT_FOUND")) {
      throw new Error("找不到這個場次，或它不屬於你的活動。");
    }
    throw new Error(error.message);
  }
  return typeof data === "number" ? data : 0;
}
