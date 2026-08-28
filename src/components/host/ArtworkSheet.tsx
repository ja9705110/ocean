"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { listMyEvents } from "@/lib/host/api";
import type { HostEvent } from "@/lib/host/api";
import {
  downloadCsv,
  formatCheckedInAt,
  listArtworks,
  stencilTally,
  toArtworkCsv,
} from "@/lib/checkin/sheet";
import type { ArtworkRow } from "@/lib/checkin/sheet";

/**
 * 彩繪成果（C23）。
 *
 * 活動結束之後要回答的問題不是「誰來了」——那是簽到表——
 * 而是「有多少人真的畫了、他們挑了什麼、畫成什麼樣」。
 * 這些以前一個都查不到：資料庫裡只有一個 image_path，
 * 而那一欄在只簽名的人身上放的是簽名，光看它分不出誰畫了。
 *
 * 版面跟簽到表一樣是為了列印設計的：白底黑字，圖片原樣呈現。
 * 螢幕上瀏覽只是順便。
 */

interface ArtworkSheetProps {
  readonly code: string;
}

export function ArtworkSheet({ code }: ArtworkSheetProps) {
  const [event, setEvent] = useState<HostEvent | null>(null);
  const [rows, setRows] = useState<ArtworkRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

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

        const artworks = await listArtworks(found.id);
        if (!cancelled) {
          setRows(artworks);
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

  const tally = rows === null ? [] : stencilTally(rows);
  const redrawn =
    rows === null ? 0 : rows.filter((row) => row.artworkCount >= 2).length;

  return (
    <main className="min-h-dvh bg-white text-neutral-900">
      <style>{`
        @media print {
          @page { margin: 12mm; }
          .no-print { display: none !important; }
          .art-card { break-inside: avoid; page-break-inside: avoid; }
        }
      `}</style>

      <div className="no-print sticky top-0 z-10 flex flex-wrap items-center justify-between gap-3 border-b border-neutral-200 bg-white/95 px-8 py-4">
        <div>
          <p className="text-sm text-neutral-800">
            彩繪成果 ｜ {event?.name ?? code}
          </p>
          <p className="mt-1 text-xs text-neutral-500">
            {rows === null
              ? "載入中"
              : `${rows.length} 人畫了，其中 ${redrawn} 人用掉重畫的機會`}
          </p>
        </div>
        <div className="flex gap-3">
          <button
            type="button"
            disabled={rows === null || rows.length === 0}
            onClick={() =>
              downloadCsv(
                `彩繪成果-${code}.csv`,
                toArtworkCsv(rows ?? []),
              )
            }
            className="rounded-lg border border-neutral-300 px-5 py-2 text-xs text-neutral-700 disabled:opacity-40"
          >
            下載 CSV
          </button>
          <button
            type="button"
            onClick={() => window.print()}
            className="rounded-lg bg-neutral-900 px-5 py-2 text-xs font-medium text-white"
          >
            列印／存 PDF
          </button>
          <Link
            href={`/host/${code}`}
            className="rounded-lg border border-neutral-300 px-5 py-2 text-xs text-neutral-700"
          >
            返回控制台
          </Link>
        </div>
      </div>

      {error ? (
        <p className="px-8 py-8 text-sm text-red-700">{error}</p>
      ) : rows === null ? (
        <p className="px-8 py-8 text-sm text-neutral-500">載入中</p>
      ) : rows.length === 0 ? (
        <p className="px-8 py-8 text-sm leading-relaxed text-neutral-500">
          還沒有人畫。彩繪要在後台「大螢幕」那一頁把顯示方式切成會收彩繪的
          模式，報到的人簽完名才會走到畫畫那一步。
        </p>
      ) : (
        <>
          {/* 哪幾張線稿最受歡迎：成果報告裡最常被問到的一句 */}
          <section className="px-8 pt-8">
            <h2 className="text-sm text-neutral-500">線稿統計</h2>
            <ul className="mt-3 flex flex-wrap gap-x-6 gap-y-2">
              {tally.map((item) => (
                <li key={item.name} className="text-sm text-neutral-800">
                  {item.name}
                  <span className="ml-2 tabular-nums text-neutral-500">
                    {item.count}
                  </span>
                </li>
              ))}
            </ul>
          </section>

          <div className="grid gap-6 px-8 py-8 sm:grid-cols-2 lg:grid-cols-3">
            {rows.map((row) => (
              <div
                key={row.id}
                className="art-card rounded-xl border border-neutral-200 p-4"
              >
                <div className="flex aspect-square items-center justify-center overflow-hidden rounded-lg bg-neutral-50">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={row.imageUrl}
                    alt={`${row.displayName} 的彩繪`}
                    className="max-h-full max-w-full object-contain"
                  />
                </div>
                <p className="mt-3 text-base text-neutral-900">
                  {row.displayName}
                  {row.isVisible ? null : (
                    <span className="ml-2 text-xs text-neutral-400">
                      已隱藏
                    </span>
                  )}
                </p>
                <p className="mt-1 text-xs text-neutral-500">
                  {row.organization ?? "未填執業單位"}
                  {row.seatNo ? ` ・ 桌次 ${row.seatNo}` : ""}
                </p>
                <p className="mt-1 text-xs text-neutral-500">
                  {row.stencilName ?? "空白畫布"}
                  {row.artworkCount >= 2 ? " ・ 重畫過" : ""}
                </p>
                <p className="mt-1 text-xs text-neutral-400">
                  {formatCheckedInAt(row.artworkAt)}
                </p>
              </div>
            ))}
          </div>
        </>
      )}
    </main>
  );
}
