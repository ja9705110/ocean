"use client";

import { useCallback, useEffect, useState } from "react";
import { generateQrSvg, playUrl } from "@/lib/qrcode";
import {
  DOWNLOAD_GAP_MS,
  downloadTableCard,
  renderTableCard,
  type TableCardMode,
} from "@/lib/game/tableCardPng";
import type { Team } from "@/lib/game/types";

/**
 * 可列印的桌卡：每桌一張，含桌號、隊名與該桌專屬的 QR Code。
 *
 * 列印樣式用 print media query 處理：螢幕上是深色預覽，
 * 送印時自動轉成白底黑字並每兩張分頁——現場印出來要能直接對折立在桌上。
 */

interface TableCardsProps {
  readonly teams: readonly Team[];
  readonly sessionName: string;
  readonly onClose: () => void;
}

export function TableCards({ teams, sessionName, onClose }: TableCardsProps) {
  const [qrByTeam, setQrByTeam] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;

    const build = async () => {
      await Promise.resolve();
      const origin = window.location.origin;
      const entries = await Promise.all(
        teams.map(async (team) => {
          try {
            const svg = await generateQrSvg(playUrl(origin, team.joinCode));
            return [team.id, svg] as const;
          } catch {
            return [team.id, ""] as const;
          }
        }),
      );
      if (!cancelled) {
        setQrByTeam(Object.fromEntries(entries));
      }
    };

    void build();
    return () => {
      cancelled = true;
    };
  }, [teams]);

  /** 正在匯出第幾張，null 表示沒在匯出 */
  const [exporting, setExporting] = useState<number | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  /**
   * 匯出成整張桌卡，還是只要 QR 本身。
   *
   * 自己另外排版桌牌、席次表的時候，桌卡上那些字會跟版面打架，
   * 那時要的是一張乾淨的方形 QR。兩種的檔名都會帶桌號——
   * 尤其是只有 QR 的那一種，圖上完全看不出來是第幾桌。
   */
  const [mode, setMode] = useState<TableCardMode>("full");

  /**
   * 一桌一個檔案（C19）。
   *
   * 不做成一張大圖或一份 PDF：桌卡是要分別交給不同的人去印、去擺的，
   * 而且常常只需要補印其中一兩張（有人把卡片弄丟、臨時加一桌）。
   * 一個檔案對一桌，檔名帶桌號，補印的時候不必再切一次圖。
   *
   * 一張一張畫、一張一張存，中間留空隙：瀏覽器會把「短時間內連續
   * 好幾個下載」當成可疑行為擋掉，不留空隙的話後面幾張會靜靜消失，
   * 而使用者只會發現資料夾裡少了幾張。
   */
  const exportAll = useCallback(async () => {
    setExportError(null);
    const origin = window.location.origin;

    try {
      for (let i = 0; i < teams.length; i += 1) {
        const team = teams[i];
        if (!team) {
          continue;
        }
        setExporting(i + 1);
        downloadTableCard(await renderTableCard(team, sessionName, origin, mode));
        if (i < teams.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, DOWNLOAD_GAP_MS));
        }
      }
    } catch (error) {
      setExportError(
        `匯出失敗：${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      setExporting(null);
    }
  }, [teams, sessionName, mode]);

  const exportOne = useCallback(
    async (team: Team) => {
      setExportError(null);
      try {
        downloadTableCard(
          await renderTableCard(team, sessionName, window.location.origin, mode),
        );
      } catch (error) {
        setExportError(
          `匯出失敗：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
    [sessionName, mode],
  );

  // 列印時忽略捲動位置，Esc 關閉
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-ink-950 print:bg-white">
      <style>{`
        @media print {
          @page { margin: 12mm; }
          .table-card { break-inside: avoid; page-break-inside: avoid; }
          .no-print { display: none !important; }
        }
      `}</style>

      <div className="no-print sticky top-0 z-10 flex items-center justify-between border-b border-ink-800 bg-ink-950/95 px-8 py-4">
        <div>
          <p className="text-sm text-ink-200">桌卡 ｜ {sessionName}</p>
          <p className="mt-1 text-xs text-ink-500">
            共 {teams.length} 張。列印後放到各桌，玩家掃自己桌上那張即入座。
            匯出 PNG 是一桌一個檔案，檔名帶桌號，補印其中一張很方便。
          </p>
          <div className="mt-2 flex items-center gap-2">
            <span className="text-xs text-ink-500">匯出樣式</span>
            {(
              [
                ["full", "整張桌卡", "桌號、隊名、QR 與說明文字"],
                ["qr", "只要 QR", "乾淨的方形 QR，檔名自動帶桌號"],
              ] as const
            ).map(([value, label, hint]) => (
              <button
                key={value}
                type="button"
                title={hint}
                disabled={exporting !== null}
                onClick={() => setMode(value)}
                className={`rounded-lg border px-3 py-1 text-xs transition-colors duration-300 ease-world disabled:opacity-40 ${
                  mode === value
                    ? "border-signal-500 bg-signal-500/15 text-signal-300"
                    : "border-ink-700 text-ink-400 hover:bg-ink-800"
                }`}
              >
                {label}
              </button>
            ))}
            <span className="text-xs text-ink-600">
              {mode === "full"
                ? "檔名 桌卡-07-隊名.png"
                : "檔名 QR-07-隊名.png"}
            </span>
          </div>
          {exportError ? (
            <p className="mt-1 text-xs text-alert-500">{exportError}</p>
          ) : null}
        </div>
        <div className="flex gap-3">
          <button
            type="button"
            disabled={exporting !== null}
            onClick={() => void exportAll()}
            className="rounded-lg bg-signal-500 px-5 py-2 text-xs font-medium text-ink-950 disabled:opacity-40"
          >
            {exporting === null
              ? `匯出 ${teams.length} 個 PNG`
              : `匯出中 ${exporting} / ${teams.length}`}
          </button>
          <button
            type="button"
            onClick={() => window.print()}
            className="rounded-lg border border-ink-700 px-5 py-2 text-xs text-ink-300 hover:bg-ink-800"
          >
            列印
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-ink-700 px-5 py-2 text-xs text-ink-300 hover:bg-ink-800"
          >
            關閉（Esc）
          </button>
        </div>
      </div>

      <div className="grid gap-6 px-8 py-8 sm:grid-cols-2 print:gap-4 print:px-0">
        {teams.map((team) => (
          <div
            key={team.id}
            className="table-card flex flex-col items-center rounded-2xl border-2 border-ink-800 bg-ink-900 px-6 py-8 text-center print:border-neutral-300 print:bg-white"
          >
            <p className="text-xs tracking-[0.3em] text-ink-500 uppercase print:text-neutral-500">
              {sessionName}
            </p>

            <p
              className="mt-4 text-5xl font-light print:text-black"
              style={{ color: team.color }}
            >
              第 {team.tableNo} 桌
            </p>
            {/* 隊名未改過時就等於桌號，重複印一次只是浪費版面 */}
            {team.name !== `第 ${team.tableNo} 桌` ? (
              <p className="mt-2 text-lg text-ink-200 print:text-neutral-700">
                {team.name}
              </p>
            ) : null}

            {qrByTeam[team.id] ? (
              <div
                className="mt-6 w-44 rounded-xl bg-white p-3"
                dangerouslySetInnerHTML={{ __html: qrByTeam[team.id] ?? "" }}
              />
            ) : (
              <div className="mt-6 aspect-square w-44 rounded-xl bg-ink-800 print:bg-neutral-100" />
            )}

            {/*
              加入碼不印了。手機上沒有可以打代碼的地方——掃碼是唯一的
              入口——印一組碼出來只會讓人拿著紙找那個不存在的輸入框。
            */}
            <p className="mt-6 text-base text-ink-200 print:text-neutral-700">
              掃我，加入這一桌
            </p>
            <p className="mt-2 text-xs text-ink-500 print:text-neutral-500">
              用手機相機對準就可以了
            </p>

            {/* 只需要補印一張的時候，不必把三十張全部再存一次 */}
            <button
              type="button"
              onClick={() => void exportOne(team)}
              className="no-print mt-4 text-xs text-ink-600 transition-colors duration-300 ease-world hover:text-signal-400"
            >
              {mode === "full" ? "只下載這一張 PNG" : "只下載這一張 QR"}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
