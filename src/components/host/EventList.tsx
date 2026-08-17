"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  claimEvent,
  createEvent,
  deleteEvent,
  listMyEvents,
} from "@/lib/host/api";
import type { HostEvent } from "@/lib/host/api";
import { EVENT_STATUS_LABEL } from "@/lib/eventStatus";
import { WORLD_TEMPLATE_OPTIONS } from "@/lib/worldOptions";

/** 主持人首頁：活動清單與建立表單 */


export function EventList() {
  const [events, setEvents] = useState<HostEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);

  const [name, setName] = useState("");
  const [subtitle, setSubtitle] = useState("");
  const [worldTemplate, setWorldTemplate] = useState<string>("river");
  const [drawCount, setDrawCount] = useState(3);
  const [allowRepeat, setAllowRepeat] = useState(false);
  const [claimCode, setClaimCode] = useState("");
  /** 正在確認刪除的活動 id。null 表示沒有進行中的刪除。 */
  const [deletingId, setDeletingId] = useState<string | null>(null);
  /** 確認框裡打的活動代碼 */
  const [confirmCode, setConfirmCode] = useState("");

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

  const remove = useCallback(
    async (event: HostEvent) => {
      setBusy(true);
      setError(null);
      try {
        await deleteEvent(event.id, confirmCode);
        setDeletingId(null);
        setConfirmCode("");
        await refresh();
      } catch (deleteError) {
        setError(
          deleteError instanceof Error
            ? deleteError.message
            : String(deleteError),
        );
      } finally {
        setBusy(false);
      }
    },
    [confirmCode, refresh],
  );

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
                <div className="group flex items-baseline gap-5 py-5 transition-colors duration-300 ease-world hover:bg-ink-900/60">
                  <Link
                    href={`/host/${event.code}`}
                    className="flex min-w-0 flex-1 items-baseline gap-5"
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
                  </Link>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setDeletingId(
                        deletingId === event.id ? null : event.id,
                      );
                      setConfirmCode("");
                    }}
                    className="shrink-0 text-xs text-ink-600 transition-colors duration-300 ease-world hover:text-alert-500 disabled:opacity-40"
                  >
                    {deletingId === event.id ? "取消" : "刪除"}
                  </button>
                </div>

                {/*
                  刪除確認。刻意要求打出活動代碼，不是「你確定嗎」的是非題：
                  活動清單上「測試場」跟正式那一場長得很像，
                  而刪掉之後參與者、獎項、抽獎結果、題目、作答全部一起消失。
                */}
                {deletingId === event.id ? (
                  <div className="mb-5 rounded-lg border border-alert-500/40 bg-ink-900/60 p-5">
                    <p className="text-sm text-ink-200">
                      刪除「{event.name}」？
                    </p>
                    <p className="mt-2 text-xs leading-relaxed text-ink-500">
                      這場活動的參與者、簽名、獎項、抽獎結果、遊戲房間、
                      題目與作答會一起消失，而且救不回來。
                      已經上傳的圖檔會留在儲存空間裡，不會一起刪。
                      <br />
                      要繼續的話，請輸入活動代碼{" "}
                      <strong className="font-mono text-ink-200">
                        {event.code}
                      </strong>
                      。
                    </p>
                    <div className="mt-4 flex flex-wrap items-center gap-3">
                      <input
                        value={confirmCode}
                        onChange={(e) => setConfirmCode(e.target.value)}
                        placeholder={event.code}
                        aria-label="輸入活動代碼以確認刪除"
                        className="w-40 rounded-lg border border-ink-700 bg-ink-950 px-4 py-2.5 font-mono text-sm text-ink-100 outline-none transition-colors duration-300 ease-world placeholder:text-ink-600 focus:border-alert-500"
                      />
                      <button
                        type="button"
                        disabled={
                          busy ||
                          confirmCode.trim().toUpperCase() !== event.code
                        }
                        onClick={() => void remove(event)}
                        className="rounded-lg bg-alert-500 px-5 py-2.5 text-sm font-medium text-ink-950 disabled:opacity-30"
                      >
                        永久刪除
                      </button>
                    </div>
                  </div>
                ) : null}
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
                  {WORLD_TEMPLATE_OPTIONS.map((template) => (
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
