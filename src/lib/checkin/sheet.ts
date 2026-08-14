"use client";

import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { characterImageUrl } from "@/lib/characterImages";
import type { CsvSignatureRow } from "@/lib/checkin/csv";

export { formatCheckedInAt, toCsv } from "@/lib/checkin/csv";

/**
 * 簽到表（C1）。
 *
 * 活動成果要留一份「誰來了、簽名長什麼樣」的紀錄。
 * 這裡只負責取資料與轉成 CSV；版面在 /host/[code]/signatures。
 */

export interface SignatureRow extends CsvSignatureRow {
  readonly id: string;
  readonly isVisible: boolean;
}

interface SignatureApiRow {
  readonly id: string;
  readonly display_name: string;
  readonly organization: string | null;
  readonly roster_title: string | null;
  readonly seat_no: string | null;
  readonly image_path: string;
  readonly signature_path: string | null;
  readonly is_visible: boolean;
  readonly joined_at: string;
}

export async function listSignatures(
  eventId: string,
): Promise<SignatureRow[]> {
  const supabase = getSupabaseBrowserClient();
  const { data, error } = await supabase.rpc("list_event_signatures", {
    p_event_id: eventId,
  });

  if (error) {
    throw new Error(error.message);
  }

  return ((data ?? []) as SignatureApiRow[]).map((row) => ({
    id: row.id,
    displayName: row.display_name,
    organization: row.organization,
    title: row.roster_title,
    seatNo: row.seat_no,
    imageUrl: characterImageUrl(row.image_path),
    signatureUrl:
      row.signature_path === null
        ? null
        : characterImageUrl(row.signature_path),
    isVisible: row.is_visible,
    checkedInAt: row.joined_at,
  }));
}

/** 讓瀏覽器下載一份 CSV */
export function downloadCsv(fileName: string, content: string): void {
  const blob = new Blob([content], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  // 立刻釋放會讓部分瀏覽器來不及開始下載
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
