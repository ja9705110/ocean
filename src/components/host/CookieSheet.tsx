"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { listMyEvents } from "@/lib/host/api";
import type { HostEvent } from "@/lib/host/api";
import {
  cookieUrl,
  listAllCookies,
  setCookieVisible,
  type AdminCookieRow,
} from "@/lib/cookie/api";
import { buildZip, safeFileName, type ZipEntry } from "@/lib/zip";
import { COOKIE_ASPECT } from "@/lib/stage/cookieBelt";

/**
 * 餅乾照片（C32）。
 *
 * 三件以前做不到的事：
 *
 *   看   全部的照片在一頁上，含被藏起來的那幾張
 *   藏   現場一定會有一兩張拍到桌面、拍到別人的臉。
 *        set_cookie_visible 從 C14 就寫好了，只是一直沒有介面按它。
 *   存   打成一個 ZIP 下載。那是大家自己畫的東西，活動結束該給得回去。
 *
 * 為什麼是 ZIP 而不是一張一張存：兩百八十張就是兩百八十個下載，
 * 瀏覽器會把連續下載當成可疑行為擋掉，而且散在下載資料夾裡等於沒整理過。
 */

interface CookieSheetProps {
  readonly code: string;
}

/** 一次抓幾張。太多會讓瀏覽器同時開幾百條連線，反而更慢。 */
const FETCH_BATCH = 6;

function stampFor(iso: string): string {
  const date = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
}

export function CookieSheet({ code }: CookieSheetProps) {
  const [event, setEvent] = useState<HostEvent | null>(null);
  const [rows, setRows] = useState<AdminCookieRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  /** 打包進度：已經抓下來幾張 */
  const [packed, setPacked] = useState<number | null>(null);

  const load = useCallback(async () => {
    const all = await listMyEvents();
    const found = all.find((item) => item.code === code) ?? null;
    setEvent(found);
    if (!found) {
      setError("找不到這場活動，或它不是你建立的。");
      return;
    }
    setRows(await listAllCookies(found.id));
  }, [code]);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      try {
        await load();
      } catch (loadError) {
        if (!cancelled) {
          setError(
            loadError instanceof Error ? loadError.message : String(loadError),
          );
        }
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [load]);

  const toggle = useCallback(
    async (row: AdminCookieRow) => {
      setError(null);
      setBusy(row.id);
      try {
        await setCookieVisible(row.id, !row.isVisible);
        setRows(
          (prev) =>
            prev?.map((item) =>
              item.id === row.id
                ? { ...item, isVisible: !row.isVisible }
                : item,
            ) ?? null,
        );
      } catch (toggleError) {
        setError(
          toggleError instanceof Error
            ? toggleError.message
            : String(toggleError),
        );
      } finally {
        setBusy(null);
      }
    },
    [],
  );

  /**
   * 打包下載。
   *
   * 檔名帶三位數的序號：跟大螢幕上的排列同一個順序，
   * 而且落到資料夾裡之後照樣排得整齊（不會 1、10、11、2）。
   * 序號之後才是署名——沒署名的人也還是有一個能講的編號。
   */
  const downloadAll = useCallback(async () => {
    if (!rows || rows.length === 0) {
      return;
    }
    setError(null);
    setPacked(0);

    try {
      const entries: ZipEntry[] = [];

      for (let i = 0; i < rows.length; i += FETCH_BATCH) {
        const slice = rows.slice(i, i + FETCH_BATCH);
        const fetched = await Promise.all(
          slice.map(async (row, offset) => {
            const response = await fetch(cookieUrl(row.imagePath));
            if (!response.ok) {
              throw new Error(`第 ${i + offset + 1} 張下載失敗（${response.status}）`);
            }
            const buffer = await response.arrayBuffer();
            const extension = row.imagePath.split(".").pop() ?? "webp";
            const no = String(i + offset + 1).padStart(3, "0");
            const who = safeFileName(row.displayName ?? "");
            // 被藏起來的那幾張仍然收進去，但檔名標出來
            const hidden = row.isVisible ? "" : "-已隱藏";
            return {
              name: `餅乾-${no}-${who}${hidden}.${extension}`,
              data: new Uint8Array(buffer),
            };
          }),
        );
        entries.push(...fetched);
        setPacked(entries.length);
      }

      const blob = buildZip(entries);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${event?.name ?? "活動"}-餅乾照片-${stampFor(new Date().toISOString())}.zip`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 20000);
    } catch (zipError) {
      setError(zipError instanceof Error ? zipError.message : String(zipError));
    } finally {
      setPacked(null);
    }
  }, [rows, event]);

  const downloadOne = useCallback((row: AdminCookieRow, index: number) => {
    const link = document.createElement("a");
    link.href = cookieUrl(row.imagePath);
    const extension = row.imagePath.split(".").pop() ?? "webp";
    link.download = `餅乾-${String(index + 1).padStart(3, "0")}-${safeFileName(
      row.displayName ?? "",
    )}.${extension}`;
    // Storage 是跨網域的，target 不設的話有些瀏覽器會直接開新分頁而不是下載
    link.rel = "noopener";
    document.body.appendChild(link);
    link.click();
    link.remove();
  }, []);

  const visible = rows?.filter((row) => row.isVisible).length ?? 0;
  const named = rows?.filter((row) => (row.displayName ?? "") !== "").length ?? 0;

  return (
    <main className="min-h-dvh bg-white text-neutral-900">
      <style>{`
        @media print {
          @page { margin: 12mm; }
          .no-print { display: none !important; }
          .cookie-card { break-inside: avoid; page-break-inside: avoid; }
        }
      `}</style>

      <div className="mx-auto max-w-6xl px-8 py-10">
        <div className="no-print flex items-baseline justify-between">
          <Link href="/host" className="text-xs text-neutral-500 hover:underline">
            ← 回後台
          </Link>
          {event ? (
            <p className="text-xs text-neutral-500">{event.name}</p>
          ) : null}
        </div>

        <h1 className="mt-6 text-2xl font-light">餅乾照片</h1>
        {rows ? (
          <p className="mt-2 text-sm text-neutral-600">
            共 {rows.length} 張，其中 {visible} 張顯示在大螢幕上、{named} 張有署名。
          </p>
        ) : null}

        {error ? (
          <p className="mt-4 rounded-lg border border-red-200 bg-red-50 px-5 py-4 text-sm text-red-700">
            {error}
          </p>
        ) : null}

        {rows && rows.length > 0 ? (
          <div className="no-print mt-6 flex flex-wrap items-center gap-3">
            <button
              type="button"
              disabled={packed !== null}
              onClick={() => void downloadAll()}
              className="rounded-lg bg-neutral-900 px-5 py-2.5 text-sm text-white disabled:opacity-40"
            >
              {packed === null
                ? `下載全部（ZIP，${rows.length} 張）`
                : `打包中 ${packed} / ${rows.length}`}
            </button>
            <button
              type="button"
              onClick={() => window.print()}
              className="rounded-lg border border-neutral-300 px-5 py-2.5 text-sm"
            >
              列印
            </button>
            <p className="text-xs text-neutral-500">
              檔名帶三位數序號與署名，順序跟大螢幕上一樣。
            </p>
          </div>
        ) : null}

        {rows === null && !error ? (
          <p className="mt-10 text-sm text-neutral-500">載入中…</p>
        ) : null}

        {rows && rows.length === 0 ? (
          <p className="mt-10 text-sm text-neutral-500">
            還沒有人上傳。上傳的入口是大螢幕上那個 QR Code，
            或後台「大螢幕」分頁裡的同一組。
          </p>
        ) : null}

        <div className="mt-8 grid gap-6 sm:grid-cols-3 lg:grid-cols-5">
          {rows?.map((row, index) => (
            <div key={row.id} className="cookie-card">
              <div
                className={`overflow-hidden rounded-xl border ${
                  row.isVisible
                    ? "border-neutral-200"
                    : "border-red-300 opacity-45"
                }`}
                style={{ aspectRatio: `${COOKIE_ASPECT}` }}
              >
                {/* Storage 上的原圖，不經過最佳化管線 */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={cookieUrl(row.imagePath)}
                  alt={row.displayName ?? `第 ${index + 1} 張`}
                  className="size-full object-cover"
                  loading="lazy"
                />
              </div>

              <p className="mt-2 text-sm">
                <span className="text-neutral-400 tabular-nums">
                  {String(index + 1).padStart(3, "0")}
                </span>{" "}
                {row.displayName ?? (
                  <span className="text-neutral-400">未署名</span>
                )}
              </p>
              <p className="text-xs text-neutral-500">{stampFor(row.createdAt)}</p>

              <div className="no-print mt-1 flex gap-3 text-xs">
                <button
                  type="button"
                  disabled={busy === row.id}
                  onClick={() => void toggle(row)}
                  className={
                    row.isVisible
                      ? "text-neutral-500 hover:underline disabled:opacity-40"
                      : "text-red-600 hover:underline disabled:opacity-40"
                  }
                >
                  {row.isVisible ? "隱藏" : "已隱藏，恢復"}
                </button>
                <button
                  type="button"
                  onClick={() => downloadOne(row, index)}
                  className="text-neutral-500 hover:underline"
                >
                  下載
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}
