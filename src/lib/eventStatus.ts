/** 活動狀態機（規格第 5 節） */
export type EventStatus =
  | "draft"
  | "open"
  | "locked"
  | "drawing"
  | "finished";

export const EVENT_STATUS_LABEL: Record<EventStatus, string> = {
  draft: "草稿",
  open: "開放報名",
  locked: "已鎖定",
  drawing: "抽獎中",
  finished: "已結束",
};

/** 每個狀態的一句話說明，讓主持人在現場不必記規則 */
export const EVENT_STATUS_HINT: Record<EventStatus, string> = {
  draft: "尚未公開，參與者掃碼會看到「找不到活動」。",
  open: "參與者可以掃碼加入並送出角色。",
  locked: "已停止收件，世界維持顯示，可以開始抽獎。",
  drawing: "抽獎進行中。",
  finished: "活動已結束，僅供回顧。",
};
