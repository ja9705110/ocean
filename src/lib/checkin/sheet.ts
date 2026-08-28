"use client";

import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { characterImageUrl } from "@/lib/characterImages";
import { findStencil } from "@/lib/creatures/riverStencils";
import type { CsvArtworkRow, CsvSignatureRow } from "@/lib/checkin/csv";

export { formatCheckedInAt, toArtworkCsv, toCsv } from "@/lib/checkin/csv";

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

// ============================================================
// 彩繪成果（C23）
// ============================================================

export interface ArtworkRow extends CsvArtworkRow {
  readonly id: string;
  readonly stencilKey: string | null;
  readonly isVisible: boolean;
}

interface ArtworkApiRow {
  readonly id: string;
  readonly display_name: string;
  readonly organization: string | null;
  readonly seat_no: string | null;
  readonly artwork_path: string;
  readonly artwork_stencil: string | null;
  readonly artwork_at: string;
  readonly artwork_count: number;
  readonly is_visible: boolean;
}

/**
 * 誰畫了、挑了哪一張、什麼時候畫的。
 *
 * 只回傳真的畫過的人。線稿的 key 在這裡翻成中文名字——
 * key 是給程式看的，成果報告要給人看。認不得的 key（線稿改過名字、
 * 或以前的資料）就原樣顯示，不要變成空白。
 */
export async function listArtworks(eventId: string): Promise<ArtworkRow[]> {
  const supabase = getSupabaseBrowserClient();
  const { data, error } = await supabase.rpc("list_event_artworks", {
    p_event_id: eventId,
  });

  if (error) {
    throw new Error(error.message);
  }

  return ((data ?? []) as ArtworkApiRow[]).map((row) => ({
    id: row.id,
    displayName: row.display_name,
    organization: row.organization,
    seatNo: row.seat_no,
    stencilKey: row.artwork_stencil,
    stencilName:
      row.artwork_stencil === null
        ? null
        : (findStencil(row.artwork_stencil)?.name ?? row.artwork_stencil),
    imageUrl: characterImageUrl(row.artwork_path),
    artworkAt: row.artwork_at,
    artworkCount: row.artwork_count,
    isVisible: row.is_visible,
  }));
}

/** 哪幾張線稿最受歡迎。成果報告裡最常被問到的一句。 */
export function stencilTally(
  rows: readonly ArtworkRow[],
): readonly { readonly name: string; readonly count: number }[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const name = row.stencilName ?? "空白畫布";
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}
