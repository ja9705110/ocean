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
  /** 本回合第 0 拍的伺服器時刻（epoch 毫秒）；尚未開始為 null */
  readonly startedAtMs: number | null;
  readonly teamCount: number;
  readonly playerCount: number;
  readonly createdAt: string;
}

/**
 * 手機在遊戲進行前後輪詢的最小狀態（G1）。
 *
 * 一律用 epoch 毫秒而不是時間字串：手機端拿到的每一個時刻
 * 都要能直接跟對過時的時鐘相減，中間多一層時區解析就多一個出錯的地方。
 * serverMs 是伺服器回應當下的時間，可以當成一次順便的對時檢查。
 */
export interface PlayState {
  readonly status: GameSessionStatus;
  readonly roundNo: number;
  readonly gameKey: string;
  readonly startedAtMs: number | null;
  readonly config: Record<string, unknown>;
  readonly serverMs: number;
}

export interface Team {
  readonly id: string;
  readonly tableNo: number;
  readonly name: string;
  readonly joinCode: string;
  readonly color: string;
  /** 這一隊在大螢幕上的海洋生物，對應 OCEAN_CREATURES 的 key */
  readonly creatureKey: string;
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
  readonly teamCreature: string;
  readonly tableNo: number;
  readonly playerId: string;
}
