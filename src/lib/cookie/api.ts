"use client";

import { getSupabaseBrowserClient } from "@/lib/supabase/client";

/**
 * 餅乾照片（C14）。
 *
 * 上傳的路徑跟角色圖同一套：先把檔案放進 Storage，再登記一列。
 * 分兩步而不是走一支「連檔案一起送」的函式，是因為 Storage 的上傳
 * 可以自己重試，而重試一個大檔案比重試一次資料庫寫入值得得多。
 */

export interface MyCookie {
  readonly id: string;
  readonly imagePath: string;
  readonly displayName: string | null;
  readonly isVisible: boolean;
}

export interface CookieRow {
  readonly id: string;
  readonly imagePath: string;
  readonly displayName: string | null;
  /** 上傳時間。照片當成角色丟進河裡時，用它決定分到哪一帶。 */
  readonly createdAt: string;
}

/** Storage 上的路徑換成看得到的網址 */
export function cookieUrl(imagePath: string): string {
  const supabase = getSupabaseBrowserClient();
  return supabase.storage.from("cookies").getPublicUrl(imagePath).data
    .publicUrl;
}

function translate(message: string): string {
  if (message.includes("EVENT_CLOSED")) {
    return "這場活動已經不接受上傳了。";
  }
  if (message.includes("BAD_IMAGE_PATH")) {
    return "圖片路徑不正確，請重新拍一次。";
  }
  if (message.includes("IMAGE_REQUIRED")) {
    return "還沒有選到照片。";
  }
  if (message.includes("exceeded the maximum allowed size")) {
    return "照片太大了，請重新拍一次（系統會自動壓縮，通常不會發生）。";
  }
  return message;
}

export async function submitCookie(input: {
  readonly eventId: string;
  readonly deviceToken: string;
  readonly blob: Blob;
  readonly extension: string;
  readonly displayName?: string;
  readonly onStatus?: (message: string) => void;
}): Promise<{ readonly replaced: boolean }> {
  const supabase = getSupabaseBrowserClient();

  // 每次都用新的檔名。覆蓋既有的檔案需要 update 權限，而那個權限
  // 一旦開放，任何人都能改掉別人的照片。
  const name = `${crypto.randomUUID()}.${input.extension}`;
  const path = `${input.eventId}/${name}`;

  input.onStatus?.("正在上傳照片");

  const { error: uploadError } = await supabase.storage
    .from("cookies")
    .upload(path, input.blob, {
      contentType: input.blob.type,
      upsert: false,
    });

  if (uploadError) {
    throw new Error(translate(uploadError.message));
  }

  input.onStatus?.("照片上傳完成，正在登記");

  const { data, error } = await supabase.rpc("submit_cookie", {
    p_event_id: input.eventId,
    p_device_token: input.deviceToken,
    p_image_path: path,
    p_display_name: input.displayName ?? null,
  });

  if (error) {
    throw new Error(translate(error.message));
  }

  const row = data as { replaced?: boolean } | null;
  return { replaced: row?.replaced === true };
}

export async function getMyCookie(
  eventId: string,
  deviceToken: string,
): Promise<MyCookie | null> {
  const supabase = getSupabaseBrowserClient();
  const { data, error } = await supabase.rpc("get_my_cookie", {
    p_event_id: eventId,
    p_device_token: deviceToken,
  });

  if (error) {
    throw new Error(translate(error.message));
  }
  if (!data) {
    return null;
  }

  const row = data as {
    id: string;
    image_path: string;
    display_name: string | null;
    is_visible: boolean;
  };
  return {
    id: row.id,
    imagePath: row.image_path,
    displayName: row.display_name,
    isVisible: row.is_visible,
  };
}

export async function listCookies(eventId: string): Promise<CookieRow[]> {
  const supabase = getSupabaseBrowserClient();
  const { data, error } = await supabase.rpc("list_cookies", {
    p_event_id: eventId,
  });

  if (error) {
    throw new Error(translate(error.message));
  }

  const rows = (data ?? []) as {
    id: string;
    image_path: string;
    display_name: string | null;
    created_at: string;
  }[];

  return rows.map((row) => ({
    id: row.id,
    imagePath: row.image_path,
    displayName: row.display_name,
    createdAt: row.created_at,
  }));
}

/** 主持人看到的一列，含被藏起來的那些 */
export interface AdminCookieRow {
  readonly id: string;
  readonly imagePath: string;
  readonly displayName: string | null;
  readonly isVisible: boolean;
  readonly createdAt: string;
}

/**
 * 主持人的完整清單（C32）。
 *
 * 跟 listCookies 分開的原因是它一定要含被藏起來的那幾張：
 * 按了隱藏之後那張就從大螢幕消失，後台再看不到的話就叫不回來了。
 */
export async function listAllCookies(
  eventId: string,
): Promise<AdminCookieRow[]> {
  const supabase = getSupabaseBrowserClient();
  const { data, error } = await supabase.rpc("list_cookies_admin", {
    p_event_id: eventId,
  });

  if (error) {
    throw new Error(translate(error.message));
  }

  const rows = (data ?? []) as {
    id: string;
    image_path: string;
    display_name: string | null;
    is_visible: boolean;
    created_at: string;
  }[];

  return rows.map((row) => ({
    id: row.id,
    imagePath: row.image_path,
    displayName: row.display_name,
    isVisible: row.is_visible,
    createdAt: row.created_at,
  }));
}

/**
 * 主持人：改掉署名（C34）。
 *
 * 現場遇到的是「打錯字」與「根本沒填」。照片牆上寫的就是這一欄，
 * 主持人看得到牆、也知道是誰，補一個名字比請那個人重拍快得多。
 * 空字串等於清掉署名。
 */
export async function setCookieName(
  cookieId: string,
  name: string,
): Promise<void> {
  const supabase = getSupabaseBrowserClient();
  const { error } = await supabase.rpc("set_cookie_name", {
    p_cookie_id: cookieId,
    p_name: name,
  });
  if (error) {
    if (error.message.includes("NAME_TOO_LONG")) {
      throw new Error("名字太長了，最多 30 個字。");
    }
    throw new Error(translate(error.message));
  }
}

/**
 * 主持人：真的刪掉一張（C34）。
 *
 * 分兩步：先刪資料庫那一列（拿回檔案路徑），再刪 Storage 上的檔案。
 * 順序不能反——先刪檔案的話，中間出錯就會留下一列指向不存在的圖，
 * 而那在大螢幕上是一個破圖。反過來則最多留下一個沒有人找得到的檔案。
 */
export async function deleteCookie(cookieId: string): Promise<void> {
  const supabase = getSupabaseBrowserClient();
  const { data, error } = await supabase.rpc("delete_cookie", {
    p_cookie_id: cookieId,
  });
  if (error) {
    throw new Error(translate(error.message));
  }

  const path = (data as { image_path?: string } | null)?.image_path;
  if (path) {
    // 檔案刪不掉不算失敗：那一列已經不見了，照片在任何地方都不會再出現
    await supabase.storage.from("cookies").remove([path]);
  }
}

/** 主持人：把不該出現的照片藏起來（不刪，那個人問起時查得到） */
export async function setCookieVisible(
  cookieId: string,
  visible: boolean,
): Promise<void> {
  const supabase = getSupabaseBrowserClient();
  const { error } = await supabase.rpc("set_cookie_visible", {
    p_cookie_id: cookieId,
    p_visible: visible,
  });
  if (error) {
    throw new Error(translate(error.message));
  }
}
