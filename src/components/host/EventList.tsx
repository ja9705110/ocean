"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { claimEvent, createEvent, listMyEvents } from "@/lib/host/api";
import type { HostEvent } from "@/lib/host/api";
import { EVENT_STATUS_LABEL } from "@/lib/eventStatus";

/** 主持人首頁：活動清單與建立表單 */

const WORLD_TEMPLATES = [{ key: "ocean", name: "海洋" }] as const;

export function EventList() {
  const [events, setEvents] = useState<HostEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);

  const [name, setName] = useState("");
  const [subtitle, setSubtitle] = useState("");
  const [worldTemplate, setWorldTemplate] = useState<string>("ocean");
  const [drawCount, setDrawCount] = useState(3);
  const [allowRepeat, setAllowRepeat] = useState(false);
  const [claimCode, setClaimCode] = useState("");

  const refresh = useCallback(async () => {
    try {
      setEvents(await listMyEvents());
      setError(null);
    } catch (refreshError) {
      setError(
        refreshError instanceof Error
          ? refreshError.message
          : String(refreshError),
      );
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      // 讓狀態更新脫離 effect 的同步階段，避免掛載當下的連鎖重渲染
      await Promise.resolve();
      if (!cancelled) {
        await refresh();
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  const submit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setBusy(true);
      setError(null);
      try {
        await createEvent({
          name: name.trim(),
          subtitle: subtitle.trim() === "" ? null : subtitle.trim(),
          worldTemplate,
          drawCount,
          allowRepeat,
        });
        setName("");
        setSubtitle("");
        setCreating(false);
        await refresh();
      } catch (submitError) {
        setError(
          submitError instanceof Error
            ? submitError.message
            : String(submitError),
        );
      } finally {
        setBusy(false);
      }
    },
    [name, subtitle, worldTemplate, drawCount, allowRepeat, refresh],
  );

  const claim = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await claimEvent(claimCode.trim().toUpperCase());
      setClaimCode("");
      await refresh();
    } catch (claimError) {
      const message =
        claimError instanceof Error ? claimError.message : String(claimError);
      setError(
        message.includes("EVENT_NOT_CLAIMABLE")
          ? "這個代碼不存在，或該活動已經有主持人了。"
          : message,
      );
    } finally {
      setBusy(false);
    }
  }, [claimCode, refresh]);

  return (
    <main className="mx-auto min-h-dvh max-w-3xl px-8 py-20">
      <p className="text-xs tracking-[0.35em] text-ink-500 uppercase">Host</p>
      <h1 className="mt-6 text-3xl font-light text-ink-100">我的活動</h1>

      {error ? (
        <p className="mt-8 rounded-lg border border-ink-700 bg-ink-900 px-5 py-4 text-xs leading-relaxed text-alert-500">
          {error}
        </p>
      ) : null}

      {/* 活動清單 */}
      <div className="mt-12">
        {events === null ? (
          <p className="text-sm text-ink-500">載入中</p>
        ) : events.length === 0 ? (
          <p className="text-sm leading-relaxed text-ink-500">
            還沒有活動。建立第一場，或在下方認領既有的示範活動。
          </p>
        ) : (
          <ul className="divide-y divide-ink-800 border-y border-ink-800">
            {events.map((event) => (
              <li key={event.id}>
                <Link
                  href={`/host/${event.code}`}
                  className="group flex items-baseline gap-5 py-5 transition-colors duration-300 ease-world hover:bg-ink-900/60"
                >
                  <span className="w-20 shrink-0 font-mono text-sm text-signal-400/90">
                    {event.code}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-base font-light text-ink-100">
                      {event.name}
                    </span>
                    <span className="mt-1 block text-xs text-ink-500">
                      {EVENT_STATUS_LABEL[event.status]} ｜{" "}
                      {event.participantCount} 位參與 ｜ 已抽{" "}
                      {event.drawnCount}／{event.drawCount}
                    </span>
                  </span>
                  <span className="shrink-0 text-xs text-ink-600 transition-colors duration-300 ease-world group-hover:text-ink-300">
                    管理
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* 建立活動 */}
      <div className="mt-14">
        {creating ? (
          <form
            onSubmit={(e) => void submit(e)}
            className="rounded-lg border border-ink-800 bg-ink-900/50 p-7"
          >
            <h2 className="text-lg font-light text-ink-100">建立活動</h2>

            <label
              htmlFor="event-name"
              className="mt-7 block text-sm text-ink-300"
            >
              活動名稱
            </label>
            <input
              id="event-name"
              required
              maxLength={60}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如：2026 年度大會"
              className="mt-2 w-full rounded-lg border border-ink-700 bg-ink-950 px-4 py-3 text-base text-ink-100 outline-none transition-colors duration-300 ease-world placeholder:text-ink-600 focus:border-signal-500"
            />

            <label
              htmlFor="event-subtitle"
              className="mt-5 block text-sm text-ink-300"
            >
              副標題（可留空）
            </label>
            <input
              id="event-subtitle"
              maxLength={80}
              value={subtitle}
              onChange={(e) => setSubtitle(e.target.value)}
              placeholder="顯示在參與者的封面上"
              className="mt-2 w-full rounded-lg border border-ink-700 bg-ink-950 px-4 py-3 text-base text-ink-100 outline-none transition-colors duration-300 ease-world placeholder:text-ink-600 focus:border-signal-500"
            />

            <div className="mt-5 grid gap-5 sm:grid-cols-2">
              <div>
                <label
                  htmlFor="event-template"
                  className="block text-sm text-ink-300"
                >
                  世界主題
                </label>
                <select
                  id="event-template"
                  value={worldTemplate}
                  onChange={(e) => setWorldTemplate(e.target.value)}
                  className="mt-2 w-full rounded-lg border border-ink-700 bg-ink-950 px-4 py-3 text-base text-ink-100 outline-none transition-colors duration-300 ease-world focus:border-signal-500"
                >
                  {WORLD_TEMPLATES.map((template) => (
                    <option key={template.key} value={template.key}>
                      {template.name}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label
                  htmlFor="event-draw-count"
                  className="block text-sm text-ink-300"
                >
                  預計抽出人數
                </label>
                <input
                  id="event-draw-count"
                  type="number"
                  min={1}
                  max={100}
                  value={drawCount}
                  onChange={(e) => setDrawCount(Number(e.target.value))}
                  className="mt-2 w-full rounded-lg border border-ink-700 bg-ink-950 px-4 py-3 text-base text-ink-100 outline-none transition-colors duration-300 ease-world focus:border-signal-500"
                />
              </div>
            </div>

            <label className="mt-6 flex items-center gap-3 text-sm text-ink-300">
              <input
                type="checkbox"
                checked={allowRepeat}
                onChange={(e) => setAllowRepeat(e.target.checked)}
                className="size-4 accent-signal-500"
              />
              允許重複中獎
            </label>

            <div className="mt-8 flex gap-3">
              <button
                type="submit"
                disabled={busy || name.trim() === ""}
                className="rounded-lg bg-signal-500 px-6 py-3 text-sm font-medium text-ink-950 transition-opacity duration-300 ease-world disabled:opacity-40"
              >
                {busy ? "建立中" : "建立"}
              </button>
              <button
                type="button"
                onClick={() => setCreating(false)}
                className="rounded-lg border border-ink-700 px-6 py-3 text-sm text-ink-300 transition-colors duration-300 ease-world hover:bg-ink-800"
              >
                取消
              </button>
            </div>
          </form>
        ) : (
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="rounded-lg bg-signal-500 px-7 py-3.5 text-sm font-medium text-ink-950"
          >
            建立活動
          </button>
        )}
      </div>

      {/* 認領既有活動 */}
      <div className="mt-16 border-t border-ink-800 pt-8">
        <h2 className="text-sm text-ink-300">認領既有活動</h2>
        <p className="mt-2 text-xs leading-relaxed text-ink-500">
          若活動是以 SQL 直接建立、尚無主持人（例如示範活動 DEMO01），
          在此輸入代碼即可接手管理。
        </p>
        <div className="mt-4 flex gap-3">
          <input
            value={claimCode}
            onChange={(e) => setClaimCode(e.target.value.toUpperCase())}
            maxLength={12}
            placeholder="DEMO01"
            className="w-40 rounded-lg border border-ink-700 bg-ink-900 px-4 py-2.5 font-mono text-sm text-ink-100 outline-none transition-colors duration-300 ease-world placeholder:text-ink-600 focus:border-signal-500"
          />
          <button
            type="button"
            onClick={() => void claim()}
            disabled={busy || claimCode.trim() === ""}
            className="rounded-lg border border-ink-700 px-5 py-2.5 text-sm text-ink-300 transition-colors duration-300 ease-world hover:bg-ink-800 disabled:opacity-40"
          >
            認領
          </button>
        </div>
      </div>
    </main>
  );
}
