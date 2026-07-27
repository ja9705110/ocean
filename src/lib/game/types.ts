/** 遊戲模式的共用型別（G0） */

export type GameSessionStatus =
  | "setup"
  | "lobby"
  | "countdown"
  | "playing"
  | "finished";

export const GAME_STATUS_LABEL: Record<GameSessionStatus, string> = {
  setup: "設定中",
  lobby: "等待玩家",
  countdown: "倒數中",
  playing: "進行中",
  finished: "已結束",
};

export const GAME_STATUS_HINT: Record<GameSessionStatus, string> = {
  setup: "尚未開放，玩家掃碼會看到「尚未開始」。",
  lobby: "玩家可以掃桌卡入座，大螢幕顯示各隊人數。",
  countdown: "即將開始，此時不再接受新玩家。",
  playing: "遊戲進行中。",
  finished: "已結束，可查看成績。",
};

export interface GameSession {
  readonly id: string;
  readonly gameKey: string;
  readonly name: string;
  readonly status: GameSessionStatus;
  readonly roundNo: number;
  readonly config: Record<string, unknown>;
  readonly teamCount: number;
  readonly playerCount: number;
  readonly createdAt: string;
}

export interface Team {
  readonly id: string;
  readonly tableNo: number;
  readonly name: string;
  readonly joinCode: string;
  readonly color: string;
  readonly playerCount: number;
}

export interface TeamPlayer {
  readonly id: string;
  readonly displayName: string;
  readonly participantId: string | null;
}

/** join_game RPC 的回傳：玩家加入後手機需要知道的一切 */
export interface JoinedSeat {
  readonly sessionId: string;
  readonly sessionStatus: GameSessionStatus;
  readonly gameKey: string;
  readonly teamId: string;
  readonly teamName: string;
  readonly teamColor: string;
  readonly tableNo: number;
  readonly playerId: string;
}
