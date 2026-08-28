"use client";

import { useEffect, useState } from "react";
import { generateQrSvg, playUrl } from "@/lib/qrcode";
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
          </p>
        </div>
        <div className="flex gap-3">
          <button
            type="button"
            onClick={() => window.print()}
            className="rounded-lg bg-signal-500 px-5 py-2 text-xs font-medium text-ink-950"
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

            <p className="mt-5 font-mono text-2xl tracking-[0.3em] text-signal-400 print:text-black">
              {team.joinCode}
            </p>
            <p className="mt-3 text-xs text-ink-500 print:text-neutral-500">
              掃描或輸入代碼加入這一桌
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}
