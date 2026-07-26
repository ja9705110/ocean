"use client";

/**
 * 裝置識別與「已加入」紀錄，皆存於 localStorage。
 *
 * device_token 搭配資料庫的 unique (event_id, device_token) 雙重防守
 * 重複送出（規格第 16 節第 5 點）。這擋得住重整與誤觸，
 * 擋不住無痕視窗——那是可接受的取捨，主持人端可事後刪除。
 */

const DEVICE_TOKEN_KEY = "iwd:device-token";
const JOIN_RECORD_PREFIX = "iwd:joined:";

export interface JoinRecord {
  readonly participantId: string;
  readonly displayName: string;
  readonly characterName: string | null;
  readonly imagePath: string;
}

function safeStorage(): Storage | null {
  // Safari 無痕模式等環境可能直接拋錯，統一退化成「不可用」
  try {
    const storage = window.localStorage;
    const probe = "iwd:probe";
    storage.setItem(probe, "1");
    storage.removeItem(probe);
    return storage;
  } catch {
    return null;
  }
}

export function getOrCreateDeviceToken(): string {
  const storage = safeStorage();
  const existing = storage?.getItem(DEVICE_TOKEN_KEY);

  if (existing) {
    return existing;
  }

  const token = crypto.randomUUID();
  storage?.setItem(DEVICE_TOKEN_KEY, token);
  return token;
}

export function loadJoinRecord(eventId: string): JoinRecord | null {
  const raw = safeStorage()?.getItem(JOIN_RECORD_PREFIX + eventId);

  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw) as JoinRecord;
  } catch {
    return null;
  }
}

export function saveJoinRecord(eventId: string, record: JoinRecord): void {
  safeStorage()?.setItem(JOIN_RECORD_PREFIX + eventId, JSON.stringify(record));
}
