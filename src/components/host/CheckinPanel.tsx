"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { fetchCheckinSettings, updateEventSettings } from "@/lib/host/api";
import type { HostEvent } from "@/lib/host/api";
import type { StageDisplay } from "@/lib/stageDisplay";
import {
  clearRoster,
  importRoster,
  listRoster,
  parseRosterText,
} from "@/lib/checkin/roster";
import type { RosterEntry } from "@/lib/checkin/roster";
import { WORLD_TEMPLATE_OPTIONS } from "@/lib/worldOptions";

/**
 * 報到設定：報到方式、大螢幕世界、與會者名冊。
 *
 * 名冊是選配的。沒有名冊時報到照樣走得完，只是與會者要自己填
 * 服務單位與桌次。這一點在現場很重要——名冊常常在活動前一晚才定案。
 */

const ROSTER_POLL_MS = 8000;

const FIELD =
  "mt-2 w-full rounded-lg border border-ink-700 bg-ink-950 px-4 py-3 text-base text-ink-100 outline-none transition-colors duration-300 ease-world placeholder:text-ink-600 focus:border-signal-500";

interface CheckinPanelProps {
  readonly event: HostEvent;
  readonly onChanged: () => void;
}

export function CheckinPanel({ event, onChanged }: CheckinPanelProps) {
  const [joinMode, setJoinMode] = useState<"draw" | "signature">("draw");
  const [stageDisplay, setStageDisplay] = useState<StageDisplay>("signature");
  const [worldTemplate, setWorldTemplate] = useState(event.worldTemplate);
  const [roster, setRoster] = useState<RosterEntry[]>([]);
  const [rosterText, setRosterText] = useState("");
  const [showImport, setShowImport] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refreshRoster = useCallback(async (eventId: string) => {
    try {
      setRoster(await listRoster(eventId));
    } catch {
      // 名冊還沒建（資料庫尚未跑過 C0）時當作空的，不要在後台跳紅字
      setRoster([]);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      const settings = await fetchCheckinSettings(event.id);
      if (!cancelled) {
        setJoinMode(settings.joinMode);
        setStageDisplay(settings.stageDisplay);
      }
      await refreshRoster(event.id);
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [event.id, refreshRoster]);

  // 報到進行中要看得到誰還沒到，不然報到台得一直手動重整
  useEffect(() => {
    if (joinMode !== "signature" || event.status !== "open") {
      return;
    }

    const timer = setInterval(() => {
      if (document.visibilityState === "visible") {
        void refreshRoster(event.id);
      }
    }, ROSTER_POLL_MS);

    return () => clearInterval(timer);
  }, [joinMode, event.status, event.id, refreshRoster]);

  const run = useCallback(
    async (action: () => Promise<string>) => {
      setBusy(true);
      setError(null);
      setNotice(null);
      try {
        setNotice(await action());
      } catch (actionError) {
        setError(
          actionError instanceof Error
            ? actionError.message
            : String(actionError),
        );
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const changeMode = useCallback(
    (mode: "draw" | "signature") => {
      void run(async () => {
        await updateEventSettings(event.id, { joinMode: mode });
        setJoinMode(mode);
        onChanged();
        return mode === "signature"
          ? "已改為電子簽到，同一個 QR Code 就會變成報到頁"
          : "已改回畫角色";
      });
    },
    [event.id, onChanged, run],
  );

  const changeDisplay = useCallback(
    (next: StageDisplay) => {
      void run(async () => {
        await updateEventSettings(event.id, { stageDisplay: next });
        setStageDisplay(next);
        onChanged();
        return "大螢幕十秒內會自己重新載入並換成新的顯示方式";
      });
    },
    [event.id, onChanged, run],
  );

  const changeTemplate = useCallback(
    (key: string) => {
      void run(async () => {
        await updateEventSettings(event.id, { worldTemplate: key });
        setWorldTemplate(key);
        onChanged();
        return "大螢幕的世界已更新，重新整理大螢幕即可看到";
      });
    },
    [event.id, onChanged, run],
  );

  const parsed = useMemo(() => parseRosterText(rosterText), [rosterText]);

  const doImport = useCallback(() => {
    void run(async () => {
      const inserted = await importRoster(event.id, parsed);
      await refreshRoster(event.id);
      setRosterText("");
      setShowImport(false);
      return `已匯入 ${inserted} 位`;
    });
  }, [event.id, parsed, refreshRoster, run]);

  const doClear = useCallback(() => {
    void run(async () => {
      await clearRoster(event.id);
      await refreshRoster(event.id);
      return "名冊已清空";
    });
  }, [event.id, refreshRoster, run]);

  const checkedIn = roster.filter((entry) => entry.checkedInAt !== null).length;

  return (
    <section className="rounded-lg border border-ink-800 bg-ink-900/50 p-7">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm text-ink-300">報到</h2>
        {notice ? (
          <span className="text-xs text-signal-400">{notice}</span>
        ) : null}
      </div>

      {/* 報到方式 */}
      <div className="mt-5 grid gap-3 sm:grid-cols-2">
        {(
          [
            {
              key: "draw" as const,
              name: "畫角色",
              hint: "每個人畫一隻角色送進世界",
            },
            {
              key: "signature" as const,
              name: "電子簽到",
              hint: "確認資料後簽名，簽名流進河道",
            },
          ]
        ).map((option) => (
          <button
            key={option.key}
            type="button"
            disabled={busy}
            onClick={() => changeMode(option.key)}
            className={`rounded-lg border px-5 py-4 text-left transition-colors duration-300 ease-world disabled:opacity-50 ${
              joinMode === option.key
                ? "border-signal-500 bg-ink-800"
                : "border-ink-700 bg-ink-950"
            }`}
          >
            <p className="text-sm text-ink-100">{option.name}</p>
            <p className="mt-1 text-xs leading-relaxed text-ink-500">
              {option.hint}
            </p>
          </button>
        ))}
      </div>

      {/* 大螢幕顯示什麼 */}
      {joinMode === "signature" ? (
        <div className="mt-7">
          <p className="text-sm text-ink-300">大螢幕上顯示</p>
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            {(
              [
                { key: "signature" as const, name: "只有簽名", hint: "報到最快，簽完就入座" },
                { key: "artwork" as const, name: "只有彩繪", hint: "每個人畫一張塗鴉" },
                { key: "both" as const, name: "彩繪配簽名", hint: "彩繪在上、簽名在下合成一張" },
              ]
            ).map((option) => (
              <button
                key={option.key}
                type="button"
                disabled={busy}
                onClick={() => changeDisplay(option.key)}
                className={`rounded-lg border px-4 py-3 text-left transition-colors duration-300 ease-world disabled:opacity-50 ${
                  stageDisplay === option.key
                    ? "border-signal-500 bg-ink-800"
                    : "border-ink-700 bg-ink-950"
                }`}
              >
                <p className="text-sm text-ink-100">{option.name}</p>
                <p className="mt-1 text-xs leading-relaxed text-ink-500">
                  {option.hint}
                </p>
              </button>
            ))}
          </div>
          <p className="mt-3 text-xs leading-relaxed text-ink-500">
            選了「彩繪」或「彩繪配簽名」之後，與會者簽完名會多一步畫圖，
            也可以先跳過、入座之後再從同一個頁面回來畫。
            <br />
            中途改設定不用重開大螢幕，它十秒內會自己重新載入。
          </p>
        </div>
      ) : null}

      {/* 大螢幕世界 */}
      <div className="mt-7">
        <label htmlFor="checkin-template" className="block text-sm text-ink-300">
          大螢幕的世界
        </label>
        <select
          id="checkin-template"
          value={worldTemplate}
          disabled={busy}
          onChange={(e) => changeTemplate(e.target.value)}
          className={FIELD}
        >
          {WORLD_TEMPLATE_OPTIONS.map((template) => (
            <option key={template.key} value={template.key}>
              {template.name}
            </option>
          ))}
        </select>
        <p className="mt-2 text-xs leading-relaxed text-ink-500">
          {WORLD_TEMPLATE_OPTIONS.find((t) => t.key === worldTemplate)?.hint ??
            "未知的世界，大螢幕會退回海洋。"}
        </p>
      </div>

      {/* 名冊 */}
      <div className="mt-8 border-t border-ink-800 pt-6">
        <div className="flex items-baseline justify-between">
          <h3 className="text-sm text-ink-300">與會者名冊</h3>
          <span className="text-xs text-ink-500">
            {roster.length === 0
              ? "尚未匯入"
              : `已報到 ${checkedIn} / ${roster.length}`}
          </span>
        </div>

        <p className="mt-3 text-xs leading-relaxed text-ink-500">
          匯入之後，與會者打完姓名就會看到自己的服務單位與桌次，確認即可簽名。
          <br />
          名冊是選配的：不匯入也能報到，只是要自己填。
        </p>

        <div className="mt-5 flex flex-wrap gap-3">
          <Link
            href={`/host/${event.code}/signatures`}
            className="inline-block rounded-lg border border-ink-700 px-5 py-2.5 text-sm text-ink-200"
          >
            開啟簽到表（可列印、存 PDF、下載 CSV）
          </Link>
          {/*
            彩繪跟簽到是兩件事，所以是兩份紀錄：簽到表回答「誰來了」，
            每一位與會者都有一列；彩繪成果回答「誰畫了、畫了什麼」，
            只有真的畫過的人。混成一份的話兩個問題都要先過濾才答得出來。
          */}
          <Link
            href={`/host/${event.code}/artworks`}
            className="inline-block rounded-lg border border-ink-700 px-5 py-2.5 text-sm text-ink-200"
          >
            開啟彩繪成果（含線稿統計）
          </Link>
        </div>

        {showImport ? (
          <div className="mt-5">
            <label htmlFor="roster-text" className="block text-sm text-ink-300">
              一行一位：姓名, 服務單位, 職稱, 桌次
            </label>
            <textarea
              id="roster-text"
              value={rosterText}
              onChange={(e) => setRosterText(e.target.value)}
              rows={8}
              placeholder={"王小明, 台中市社工師公會, 理事, 3\n李大華, 某某社福基金會, 社工師, 7"}
              className={`${FIELD} font-mono text-sm`}
            />
            <p className="mt-2 text-xs text-ink-500">
              可以直接從 Excel 複製貼上（會是 Tab 分隔）。
              後面三欄留空也可以，只有姓名是必填。
              {parsed.length > 0 ? ` 目前解析出 ${parsed.length} 位。` : ""}
            </p>
            <div className="mt-4 flex gap-3">
              <button
                type="button"
                disabled={busy || parsed.length === 0}
                onClick={doImport}
                className="rounded-lg bg-signal-500 px-5 py-2.5 text-sm font-medium text-ink-950 disabled:opacity-30"
              >
                匯入 {parsed.length} 位
              </button>
              <button
                type="button"
                onClick={() => setShowImport(false)}
                className="px-4 py-2.5 text-sm text-ink-500"
              >
                取消
              </button>
            </div>
            <p className="mt-3 text-xs leading-relaxed text-ink-600">
              匯入會取代目前尚未報到的名單；已經報到的那幾位不受影響。
            </p>
          </div>
        ) : (
          <div className="mt-5 flex gap-3">
            <button
              type="button"
              disabled={busy}
              onClick={() => setShowImport(true)}
              className="rounded-lg border border-ink-700 px-5 py-2.5 text-sm text-ink-200 disabled:opacity-50"
            >
              {roster.length === 0 ? "匯入名冊" : "重新匯入"}
            </button>
            {roster.length > 0 ? (
              <button
                type="button"
                disabled={busy}
                onClick={doClear}
                className="px-4 py-2.5 text-sm text-ink-500 disabled:opacity-50"
              >
                清空名冊
              </button>
            ) : null}
          </div>
        )}

        {roster.length > 0 ? (
          <ul className="mt-6 max-h-72 space-y-1 overflow-y-auto pr-1">
            {roster.map((entry) => (
              <li
                key={entry.id}
                className="flex items-baseline justify-between gap-4 rounded px-3 py-2 text-sm odd:bg-ink-950/40"
              >
                <span className="min-w-0">
                  <span className="text-ink-100">{entry.displayName}</span>
                  {entry.organization ? (
                    <span className="ml-3 text-xs text-ink-500">
                      {entry.organization}
                    </span>
                  ) : null}
                </span>
                <span className="flex shrink-0 items-baseline gap-3">
                  {entry.seatNo ? (
                    <span className="text-xs text-ink-500">
                      第 {entry.seatNo} 桌
                    </span>
                  ) : null}
                  <span
                    className={`text-xs ${
                      entry.checkedInAt ? "text-signal-400" : "text-ink-600"
                    }`}
                  >
                    {entry.checkedInAt ? "已報到" : "未到"}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      {error ? (
        <p className="mt-5 text-xs leading-relaxed text-alert-500">{error}</p>
      ) : null}
    </section>
  );
}
