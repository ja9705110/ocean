"use client";

import { getSupabaseBrowserClient } from "@/lib/supabase/client";

/**
 * 名冊管理（主持人端）。
 *
 * 這裡刻意全部用資料表操作而不是 RPC：名冊的四種操作都在 RLS 政策
 * 涵蓋範圍內，多開函式只會多一次「在模式快取中找不到函式」的風險。
 */

export interface RosterEntry {
  readonly id: string;
  readonly displayName: string;
  readonly organization: string | null;
  readonly title: string | null;
  readonly seatNo: string | null;
  readonly checkedInAt: string | null;
}

interface RosterRow {
  readonly id: string;
  readonly display_name: string;
  readonly organization: string | null;
  readonly title: string | null;
  readonly seat_no: string | null;
  readonly checked_in_at: string | null;
}

function toEntry(row: RosterRow): RosterEntry {
  return {
    id: row.id,
    displayName: row.display_name,
    organization: row.organization,
    title: row.title,
    seatNo: row.seat_no,
    checkedInAt: row.checked_in_at,
  };
}

export async function listRoster(eventId: string): Promise<RosterEntry[]> {
  const supabase = getSupabaseBrowserClient();
  const { data, error } = await supabase
    .from("event_roster")
    .select("id,display_name,organization,title,seat_no,checked_in_at")
    .eq("event_id", eventId)
    .order("seat_no", { ascending: true, nullsFirst: false })
    .order("display_name", { ascending: true });

  if (error) {
    throw new Error(error.message);
  }

  return ((data ?? []) as RosterRow[]).map(toEntry);
}

/** 一行文字解析出來的一位與會者 */
export interface ParsedRosterRow {
  readonly displayName: string;
  readonly organization: string | null;
  readonly title: string | null;
  readonly seatNo: string | null;
}

/**
 * 把貼上來的名冊文字解析成資料列。
 *
 * 接受逗號、全形逗號、Tab 分隔——主持人多半是從 Excel 複製過來的，
 * 貼進 textarea 會變成 Tab；有人則是自己打逗號。要求對方統一格式
 * 只會讓名冊在活動前一天匯不進去。
 *
 * 欄位順序：姓名, 服務單位, 職稱, 桌次。後面三欄都可以省略。
 */
export function parseRosterText(text: string): ParsedRosterRow[] {
  const rows: ParsedRosterRow[] = [];

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") {
      continue;
    }

    const cells = trimmed
      .split(/[\t,，]/)
      .map((cell) => cell.trim());

    const displayName = cells[0] ?? "";
    if (displayName === "") {
      continue;
    }

    // 表頭那一行不是與會者
    if (displayName === "姓名" || displayName.toLowerCase() === "name") {
      continue;
    }

    rows.push({
      displayName: displayName.slice(0, 30),
      organization: cells[1] ? cells[1].slice(0, 60) : null,
      title: cells[2] ? cells[2].slice(0, 40) : null,
      seatNo: cells[3] ? cells[3].slice(0, 20) : null,
    });
  }

  return rows;
}

/**
 * 匯入名冊：清掉尚未報到的舊資料，再寫入新的。
 *
 * 為什麼要清：主持人多半會改好幾版名冊（有人取消、有人換桌），
 * 每次匯入都疊加只會產生一堆重複的名字，現場查名字時全是雜訊。
 * 已經報到的那幾列不動——那是已經發生的事實，不能被一次貼上洗掉。
 */
export async function importRoster(
  eventId: string,
  rows: readonly ParsedRosterRow[],
): Promise<number> {
  const supabase = getSupabaseBrowserClient();

  const { error: deleteError } = await supabase
    .from("event_roster")
    .delete()
    .eq("event_id", eventId)
    .is("checked_in_at", null);

  if (deleteError) {
    throw new Error(deleteError.message);
  }

  if (rows.length === 0) {
    return 0;
  }

  // 分批送出：一次塞幾百列會撞到請求大小上限，也讓失敗時的重試更便宜
  const BATCH_SIZE = 200;
  let inserted = 0;

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE).map((row) => ({
      event_id: eventId,
      display_name: row.displayName,
      organization: row.organization,
      title: row.title,
      seat_no: row.seatNo,
    }));

    const { error } = await supabase.from("event_roster").insert(batch);
    if (error) {
      throw new Error(error.message);
    }
    inserted += batch.length;
  }

  return inserted;
}

/** 清空名冊，含已報到的紀錄。給「匯錯了要重來」用。 */
export async function clearRoster(eventId: string): Promise<void> {
  const supabase = getSupabaseBrowserClient();
  const { error } = await supabase
    .from("event_roster")
    .delete()
    .eq("event_id", eventId);

  if (error) {
    throw new Error(error.message);
  }
}
