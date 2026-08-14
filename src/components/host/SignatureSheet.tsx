"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { listMyEvents } from "@/lib/host/api";
import type { HostEvent } from "@/lib/host/api";
import {
  downloadCsv,
  formatCheckedInAt,
  listSignatures,
  toCsv,
} from "@/lib/checkin/sheet";
import type { SignatureRow } from "@/lib/checkin/sheet";

/**
 * 活動成果用的簽到表。
 *
 * 這一頁是為了列印設計的，不是為了在螢幕上瀏覽：
 * 版面固定用白底黑字（投影用的深色在紙上會印成一片黑），
 * 每一列一位與會者，簽名以圖片原樣呈現，跟紙本簽到簿一樣。
 *
 * 匯出成 PDF 的方式就是瀏覽器的列印 → 另存 PDF。
 * 刻意不引入 PDF 產生器：多一個相依套件、多一份中文字型要打包，
 * 而瀏覽器的列印本來就會把中文排得比任何前端套件都好。
 */

const ROWS_PER_PAGE = 12;

interface SignatureSheetProps {
  readonly code: string;
}

export function SignatureSheet({ code }: SignatureSheetProps) {
  const [event, setEvent] = useState<HostEvent | null>(null);
  const [rows, setRows] = useState<SignatureRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hiddenToo, setHiddenToo] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const all = await listMyEvents();
        const found = all.find((item) => item.code === code) ?? null;
        if (cancelled) {
          return;
        }
        setEvent(found);

        if (!found) {
          setError("找不到這場活動，或它不是你建立的。");
          return;
        }

        const signatures = await listSignatures(found.id);
        if (!cancelled) {
          setRows(signatures);
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(
            loadError instanceof Error ? loadError.message : String(loadError),
          );
        }
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [code]);

  const shown = (rows ?? []).filter((row) => hiddenToo || row.isVisible);

  const handleCsv = useCallback(() => {
    if (!event) {
      return;
    }
    downloadCsv(`${event.code}-簽到表.csv`, toCsv(shown));
  }, [event, shown]);

  if (error) {
    return (
      <main className="mx-auto max-w-2xl px-8 py-20">
        <h1 className="text-2xl font-light text-ink-100">簽到表</h1>
        <p className="mt-4 text-sm text-alert-500">{error}</p>
        <Link
          href={`/host/${code}`}
          className="mt-10 inline-block text-xs text-ink-500 underline-offset-4 hover:underline"
        >
          回到控制台
        </Link>
      </main>
    );
  }

  if (!event || rows === null) {
    return (
      <main className="mx-auto max-w-2xl px-8 py-20">
        <p className="text-sm text-ink-500">正在讀取簽到表…</p>
      </main>
    );
  }

  const signedCount = shown.filter((row) => row.signatureUrl !== null).length;

  return (
    <>
      {/* 工具列只在螢幕上出現，印出來不該有按鈕 */}
      <div className="print:hidden">
        <div className="mx-auto flex max-w-4xl flex-wrap items-center gap-4 px-8 py-8">
          <Link
            href={`/host/${code}`}
            className="text-xs text-ink-500 underline-offset-4 hover:underline"
          >
            回到控制台
          </Link>
          <span className="text-sm text-ink-300">
            共 {shown.length} 位，其中 {signedCount} 位有簽名
          </span>
          <div className="ml-auto flex items-center gap-3">
            <label className="flex items-center gap-2 text-xs text-ink-400">
              <input
                type="checkbox"
                checked={hiddenToo}
                onChange={(e) => setHiddenToo(e.target.checked)}
                className="accent-signal-500"
              />
              含已隱藏的人
            </label>
            <button
              type="button"
              onClick={handleCsv}
              className="rounded-lg border border-ink-700 px-4 py-2 text-sm text-ink-200"
            >
              下載 CSV
            </button>
            <button
              type="button"
              onClick={() => window.print()}
              className="rounded-lg bg-signal-500 px-5 py-2 text-sm font-medium text-ink-950"
            >
              列印／存成 PDF
            </button>
          </div>
        </div>
        <p className="mx-auto max-w-4xl px-8 pb-6 text-xs leading-relaxed text-ink-500">
          列印時在瀏覽器的列印視窗選「另存為 PDF」即可得到電子檔。
          背景圖片預設不會印出來，請在列印設定裡打開「背景圖形」，
          簽名才會出現在紙上。
        </p>
      </div>

      {/* 這一段是要印出來的。白底黑字，不跟著站台的深色主題。 */}
      <div className="mx-auto max-w-4xl bg-white px-10 py-10 text-black print:max-w-none print:px-0 print:py-0">
        <header className="border-b-2 border-black pb-4">
          <h1 className="text-2xl font-bold">{event.name}</h1>
          <p className="mt-1 text-sm">
            {event.subtitle ? `${event.subtitle}　` : ""}簽到表
          </p>
          <p className="mt-1 text-xs">
            共 {shown.length} 位　列印時間 {formatCheckedInAt(new Date().toISOString())}
          </p>
        </header>

        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-black">
              <th className="w-10 py-2 text-left font-medium">#</th>
              <th className="w-14 py-2 text-left font-medium">桌次</th>
              <th className="w-28 py-2 text-left font-medium">姓名</th>
              <th className="py-2 text-left font-medium">服務單位</th>
              <th className="w-24 py-2 text-left font-medium">報到時間</th>
              <th className="w-48 py-2 text-left font-medium">簽名</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((row, index) => (
              <tr
                key={row.id}
                className="border-b border-neutral-300"
                // 每頁固定筆數，避免一列被切成兩半跨頁
                style={
                  index > 0 && index % ROWS_PER_PAGE === 0
                    ? { breakBefore: "page" }
                    : undefined
                }
              >
                <td className="py-3 align-middle">{index + 1}</td>
                <td className="py-3 align-middle">{row.seatNo ?? ""}</td>
                <td className="py-3 align-middle font-medium">
                  {row.displayName}
                  {row.title ? (
                    <span className="ml-1 text-xs font-normal">
                      {row.title}
                    </span>
                  ) : null}
                </td>
                <td className="py-3 align-middle text-xs">
                  {row.organization ?? ""}
                </td>
                <td className="py-3 align-middle text-xs">
                  {formatCheckedInAt(row.checkedInAt)}
                </td>
                <td className="py-3 align-middle">
                  {row.signatureUrl ? (
                    // 簽名是暖金色的（配大螢幕的深藍河道），印在白紙上會看不見，
                    // 用 invert 反相成深色。圖是透明背景，反相只會影響筆畫本身。
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={row.signatureUrl}
                      alt={`${row.displayName} 的簽名`}
                      crossOrigin="anonymous"
                      className="h-12 w-auto max-w-full object-contain invert"
                    />
                  ) : (
                    <span className="text-xs text-neutral-500">未簽名</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {shown.length === 0 ? (
          <p className="py-10 text-center text-sm text-neutral-500">
            還沒有人報到。
          </p>
        ) : null}
      </div>
    </>
  );
}
