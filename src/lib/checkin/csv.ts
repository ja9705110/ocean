/**
 * 簽到表的純資料轉換。
 *
 * 刻意與 sheet.ts 分開：那一支標了 "use client" 且會 import Supabase client，
 * 在 Node 裡跑不起來。CSV 的跳脫規則與 BOM 是最容易靜靜壞掉的東西
 * （壞掉的表現是「Excel 開起來是亂碼」或「欄位錯位」，不會有任何錯誤訊息），
 * 所以要能被 npm run check:game 直接測到。
 */

/** 一列簽到紀錄，只取 CSV 需要的欄位 */
export interface CsvSignatureRow {
  readonly displayName: string;
  readonly organization: string | null;
  readonly title: string | null;
  readonly seatNo: string | null;
  readonly imageUrl: string;
  readonly signatureUrl: string | null;
  readonly checkedInAt: string;
}

/** 報到時間顯示成本地時間，秒不重要 */
export function formatCheckedInAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return date.toLocaleString("zh-TW", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/**
 * CSV 的欄位跳脫。
 *
 * 逗號、引號、換行都必須包引號，否則 Excel 會把一個欄位拆成兩欄——
 * 服務單位裡有逗號在台灣的名冊裡並不罕見。
 */
function csvCell(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/**
 * 轉成 CSV。
 *
 * 開頭的 BOM 是給 Excel 看的：沒有它，Excel 會用系統預設編碼開檔，
 * 中文姓名全部變成亂碼。
 */
export function toCsv(rows: readonly CsvSignatureRow[]): string {
  const header = [
    "序號",
    "桌次",
    "姓名",
    "服務單位",
    "職稱",
    "報到時間",
    "簽名圖網址",
    "彩繪圖網址",
  ];

  const lines = [header.join(",")];

  rows.forEach((row, index) => {
    lines.push(
      [
        String(index + 1),
        row.seatNo ?? "",
        row.displayName,
        row.organization ?? "",
        row.title ?? "",
        formatCheckedInAt(row.checkedInAt),
        row.signatureUrl ?? "",
        row.signatureUrl === row.imageUrl ? "" : row.imageUrl,
      ]
        .map(csvCell)
        .join(","),
    );
  });

  return `﻿${lines.join("\r\n")}\r\n`;
}
