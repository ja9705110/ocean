"use client";

import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { withRetry } from "@/lib/retry";
import type { ProcessedCharacter } from "@/lib/image/processCharacter";
import type { PublicEvent } from "@/lib/join/api";

/**
 * 電子簽到（C0）。
 *
 * 簽名跟手繪角色走同一條管線：圖上 Storage 的 characters bucket、
 * 資料列進 participants、大螢幕用同一個世界渲染器顯示。
 * 差別只在「圖是簽名而不是角色」以及多了確認資料這一步。
 */

/** 名冊上的一筆，供本人確認 */
export interface RosterMatch {
  readonly id: string;
  readonly displayName: string;
  readonly organization: string | null;
  readonly title: string | null;
  readonly seatNo: string | null;
  /** 這一列已經有人簽過了 */
  readonly checkedIn: boolean;
}

interface RosterRow {
  readonly id: string;
  readonly display_name: string;
  readonly organization: string | null;
  readonly title: string | null;
  readonly seat_no: string | null;
  readonly checked_in: boolean;
}

/**
 * 以完整姓名查名冊。
 *
 * 後端只接受完整相符，打一個字查不到東西——那是刻意的，
 * 名冊是完整的與會者名單，不能讓人用前綴一個一個撈出來。
 * 查不到不代表不能簽到，只是要自己填服務單位與桌次。
 */
export async function lookupRoster(
  eventId: string,
  name: string,
): Promise<RosterMatch[]> {
  const supabase = getSupabaseBrowserClient();
  const { data, error } = await supabase.rpc("lookup_roster", {
    p_event_id: eventId,
    p_name: name,
  });

  if (error) {
    throw new Error(error.message);
  }

  return ((data ?? []) as RosterRow[]).map((row) => ({
    id: row.id,
    displayName: row.display_name,
    organization: row.organization,
    title: row.title,
    seatNo: row.seat_no,
    checkedIn: row.checked_in,
  }));
}

/** 已經報到過的那一筆，讓本人確認是不是自己 */
export interface ExistingCheckin {
  readonly id: string;
  readonly displayName: string;
  readonly organization: string | null;
  readonly seatNo: string | null;
  readonly imagePath: string;
  readonly signaturePath: string | null;
  readonly joinedAtMs: number;
}

/**
 * 這個名字報到過了嗎（C18）。
 *
 * 同一支手機重掃會靠瀏覽器裡的紀錄直接跳到完成頁，但手機換了、
 * 用無痕開、清了瀏覽資料、或報到台先用平板代簽過一次，
 * 瀏覽器裡就什麼都沒有——同一個人會被簽進去第二次。
 *
 * 後端只接受完整姓名相符（大小寫與前後空白不計），
 * 打一個字查不到東西：participants 對匿名端是關閉的，
 * 不能讓人用前綴把整份名單撈出來。
 */
export async function findCheckinByName(
  eventId: string,
  name: string,
): Promise<ExistingCheckin[]> {
  const supabase = getSupabaseBrowserClient();
  const { data, error } = await supabase.rpc("find_checkin_by_name", {
    p_event_id: eventId,
    p_name: name,
  });

  if (error) {
    throw new Error(error.message);
  }

  return (
    (data ?? []) as {
      id: string;
      display_name: string;
      organization: string | null;
      seat_no: string | null;
      image_path: string;
      signature_path: string | null;
      joined_at: string;
    }[]
  ).map((row) => ({
    id: row.id,
    displayName: row.display_name,
    organization: row.organization,
    seatNo: row.seat_no,
    imagePath: row.image_path,
    signaturePath: row.signature_path,
    joinedAtMs: new Date(row.joined_at).getTime(),
  }));
}

export interface CheckInInput {
  readonly event: PublicEvent;
  /** 名冊上對應的那一列，自己填的話是 null */
  readonly rosterId: string | null;
  readonly displayName: string;
  readonly organization: string | null;
  readonly seatNo: string | null;
  readonly deviceToken: string;
  /** 簽名。回頭只補彩繪時是 null */
  readonly signature: ProcessedCharacter | null;
  /** 彩繪塗鴉。主持人沒有要收彩繪時是 null */
  readonly artwork: ProcessedCharacter | null;
  /** 挑了哪一張線稿。空白畫布自己畫時是 null。只拿來做成果統計。 */
  readonly stencil?: string | null;
  readonly onStatus?: (message: string) => void;
}

export interface CheckInResult {
  readonly participantId: string;
  readonly imagePath: string;
  readonly signaturePath: string | null;
  /** true 表示這台裝置早就簽過了，這次是補資料 */
  readonly alreadyJoined: boolean;
  /**
   * 送出過幾次彩繪。第一次是 1，重畫一次變成 2，上限就是 2。
   * 完成頁靠它決定還要不要顯示「重畫」那個入口。
   */
  readonly artworkCount: number;
}

interface CheckInRow {
  readonly participant_id: string;
  readonly image_path: string;
  readonly signature_path: string | null;
  readonly already_joined: boolean;
  /** 舊版的 SQL 還沒裝上去時這一欄會是 undefined */
  readonly artwork_count?: number;
}

/** Storage 對重複路徑回傳 409，重試時第一次可能已經傳成功了 */
function isAlreadyExists(error: { readonly statusCode?: string | number }) {
  return String(error.statusCode) === "409";
}

/** 後端的錯誤代碼轉成看得懂的話 */
const ERROR_MESSAGES: Record<string, string> = {
  EVENT_NOT_FOUND: "找不到這場活動。",
  EVENT_NOT_OPEN: "報到已經結束了，請找工作人員協助。",
  NO_IMAGE: "請先簽名或畫一張圖再送出。",
  BAD_IMAGE_PATH: "簽名上傳的位置不對，請重新整理再試一次。",
  BAD_NAME: "請填寫姓名。",
  REDRAW_USED: "重畫的機會已經用完了，一支手機只能重畫一次。",
};

function friendlyError(message: string): string {
  for (const [code, text] of Object.entries(ERROR_MESSAGES)) {
    if (message.includes(code)) {
      return text;
    }
  }
  return message;
}
/**
 * 完成簽到：先上傳圖片，再登記參與者。
 *
 * 順序是刻意的，跟手繪角色同一個道理：圖先上去、資料列後寫入，
 * 大螢幕才不會收到一個沒有圖的人。整段可重試且冪等——
 * 圖片路徑帶前端產生的 id，Storage 的 409 與後端的 already_joined
 * 都視為成功。
 *
 * 簽名與彩繪可以分兩次送：先簽名入座，中場再回來畫彩繪。
 * 後端會把第二次帶來的圖補在同一位身上，不會變成兩個人。
 */
export async function submitSignature(
  input: CheckInInput,
): Promise<CheckInResult> {
  const supabase = getSupabaseBrowserClient();

  if (input.signature === null && input.artwork === null) {
    throw new Error("沒有可以送出的圖片。");
  }

  const uploadOne = async (
    path: string,
    blob: Blob,
    contentType: string,
  ): Promise<void> => {
    const { error } = await supabase.storage
      .from("characters")
      .upload(path, blob, { contentType, upsert: false });

    if (error && !isAlreadyExists(error as { statusCode?: string | number })) {
      throw new Error(error.message);
    }
  };

  /** 上傳一組（512 與 256）圖片，回傳 512 的路徑 */
  const uploadPair = async (
    image: ProcessedCharacter,
    suffix: string,
    label: string,
  ): Promise<string> => {
    // 路徑帶自己的 uuid：同一位參與者可能分兩次送（先簽名、後彩繪），
    // 兩者不能互相覆蓋，重畫時也要是新的路徑才不會被 CDN 快取住
    const fileId = crypto.randomUUID();
    const basePath = `${input.event.id}/${fileId}-${suffix}.${image.extension}`;
    const smallPath = `${input.event.id}/${fileId}-${suffix}@256.${image.extension}`;
    const contentType = image.primary.type;

    await withRetry(() => uploadOne(basePath, image.primary, contentType), {
      onRetry: (attempt) =>
        input.onStatus?.(`網路不穩，正在重新上傳${label}（第 ${attempt} 次）`),
    });
    await withRetry(() => uploadOne(smallPath, image.small, contentType), {
      onRetry: (attempt) =>
        input.onStatus?.(`網路不穩，正在重新上傳${label}（第 ${attempt} 次）`),
    });

    return basePath;
  };

  const signaturePath =
    input.signature === null
      ? null
      : await uploadPair(input.signature, "sig", "簽名");
  const artworkPath =
    input.artwork === null
      ? null
      : await uploadPair(input.artwork, "art", "彩繪");

  input.onStatus?.("圖片已送出，正在完成報到");

  let row: CheckInRow | null = null;

  await withRetry(
    async () => {
      const { data, error } = await supabase.rpc("check_in_signature", {
        p_event_id: input.event.id,
        p_participant_id: crypto.randomUUID(),
        p_display_name: input.displayName,
        p_organization: input.organization,
        p_seat_no: input.seatNo,
        p_image_path: artworkPath,
        p_device_token: input.deviceToken,
        p_roster_id: input.rosterId,
        p_signature_path: signaturePath,
        p_stencil: input.stencil ?? null,
      });

      if (error) {
        throw new Error(friendlyError(error.message));
      }
      row = data as CheckInRow;
    },
    {
      onRetry: (attempt) =>
        input.onStatus?.(`網路不穩，正在重新登記（第 ${attempt} 次）`),
    },
  );

  const result = row as CheckInRow | null;
  if (!result) {
    throw new Error("報到沒有完成，請再試一次。");
  }

  return {
    participantId: result.participant_id,
    imagePath: result.image_path,
    signaturePath: result.signature_path,
    alreadyJoined: result.already_joined,
    artworkCount: result.artwork_count ?? 0,
  };
}
