"use client";

import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import type {
  GameSession,
  GameSessionStatus,
  JoinedSeat,
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
  readonly team_count: number | string | null;
  readonly player_count: number | string | null;
  readonly created_at: string;
}

function toSession(row: SessionRow): GameSession {
  return {
    id: row.id,
    gameKey: row.game_key,
    name: row.name,
    status: row.status,
    roundNo: row.round_no,
    config: row.config ?? {},
    // count(*) 在 PostgREST 是 bigint，會以字串回傳
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

interface TeamRow {
  readonly id: string;
  readonly table_no: number;
  readonly name: string;
  readonly join_code: string;
  readonly color: string;
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
    }[]
  ).map((row) => ({
    id: row.id,
    displayName: row.display_name,
    participantId: row.participant_id,
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
