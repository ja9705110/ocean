"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { QrPanel } from "./QrPanel";
import { PrizePanel } from "./PrizePanel";
import { DrawPanel } from "./DrawPanel";
import {
  listEventParticipants,
  listMyEvents,
  setParticipantEligible,
  setParticipantVisible,
  updateEventStatus,
} from "@/lib/host/api";
import type { HostEvent, HostParticipant } from "@/lib/host/api";
import { listDraws, listPrizes } from "@/lib/draw/api";
import type { DrawResult, Prize } from "@/lib/draw/api";
import { EVENT_STATUS_HINT, EVENT_STATUS_LABEL } from "@/lib/eventStatus";
import type { EventStatus } from "@/lib/eventStatus";

/**
 * 活動控制台：狀態切換、QR Code、參與者管理。
 * 抽獎控制於 M7 加入。
 */

const PARTICIPANT_POLL_MS = 6000;

/** 各狀態可前往的下一步。刻意不提供「回到草稿」——活動一旦公開就不該消失。 */
const STATUS_ACTIONS: Record<
  EventStatus,
  readonly { readonly to: EventStatus; readonly label: string }[]
> = {
  draft: [{ to: "open", label: "開放報名" }],
  open: [{ to: "locked", label: "鎖定報名" }],
  locked: [
    { to: "open", label: "重新開放" },
    { to: "drawing", label: "進入抽獎" },
  ],
  drawing: [
    { to: "locked", label: "回到鎖定" },
    { to: "finished", label: "結束活動" },
  ],
  finished: [],
};

interface HostConsoleProps {
  readonly code: string;
}

export function HostConsole({ code }: HostConsoleProps) {
  const [event, setEvent] = useState<HostEvent | null>(null);
  const [participants, setParticipants] = useState<HostParticipant[]>([]);
  const [prizes, setPrizes] = useState<Prize[]>([]);
  const [draws, setDraws] = useState<DrawResult[]>([]);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const refreshEvent = useCallback(async () => {
    const all = await listMyEvents();
    const found = all.find((item) => item.code === code) ?? null;
    setEvent(found);
    setNotFound(found === null);
    return found;
  }, [code]);

  const refreshParticipants = useCallback(async (eventId: string) => {
    setParticipants(await listEventParticipants(eventId));
  }, []);

  const refreshDrawState = useCallback(async (eventId: string) => {
    const [nextPrizes, nextDraws] = await Promise.all([
      listPrizes(eventId),
      listDraws(eventId),
    ]);
    setPrizes(nextPrizes);
    setDraws(nextDraws);
  }, []);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const found = await refreshEvent();
        if (found && !cancelled) {
          await Promise.all([
            refreshParticipants(found.id),
            refreshDrawState(found.id),
          ]);
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
  }, [refreshEvent, refreshParticipants, refreshDrawState]);

  // 報名開放期間，參與者清單需要持續更新才能即時處理不當內容
  useEffect(() => {
    if (!event || event.status === "finished") {
      return;
    }

    const timer = setInterval(() => {
      if (document.visibilityState !== "visible") {
        return;
      }
      void refreshEvent().catch(() => undefined);
      void refreshParticipants(event.id).catch(() => undefined);
    }, PARTICIPANT_POLL_MS);

    return () => clearInterval(timer);
  }, [event, refreshEvent, refreshParticipants]);

  const changeStatus = useCallback(
    async (status: EventStatus) => {
      if (!event) {
        return;
      }
      setBusyId("status");
      setError(null);
      try {
        await updateEventStatus(event.id, status);
        await refreshEvent();
      } catch (statusError) {
        setError(
          statusError instanceof Error
            ? statusError.message
            : String(statusError),
        );
      } finally {
        setBusyId(null);
      }
    },
    [event, refreshEvent],
  );

  const toggleVisible = useCallback(
    async (participant: HostParticipant) => {
      if (!event) {
        return;
      }
      setBusyId(participant.id);
      setError(null);
      try {
        await setParticipantVisible(participant.id, !participant.isVisible);
        await refreshParticipants(event.id);
        await refreshEvent();
      } catch (toggleError) {
        setError(
          toggleError instanceof Error
            ? toggleError.message
            : String(toggleError),
        );
      } finally {
        setBusyId(null);
      }
    },
    [event, refreshParticipants, refreshEvent],
  );

  const toggleEligible = useCallback(
    async (participant: HostParticipant) => {
      if (!event) {
        return;
      }
      setBusyId(participant.id);
      setError(null);
      try {
        await setParticipantEligible(participant.id, !participant.isEligible);
        await refreshParticipants(event.id);
      } catch (toggleError) {
        setError(
          toggleError instanceof Error
            ? toggleError.message
            : String(toggleError),
        );
      } finally {
        setBusyId(null);
      }
    },
    [event, refreshParticipants],
  );

  const hiddenCount = useMemo(
    () => participants.filter((p) => !p.isVisible).length,
    [participants],
  );

  if (notFound) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-8">
        <h1 className="text-2xl font-light text-ink-100">找不到這場活動</h1>
        <p className="mt-4 text-sm leading-relaxed text-ink-400">
          代碼「{code}」不存在，或不是由這個帳號管理的。
          若活動是以 SQL 建立且尚無主持人，請回到清單頁認領它。
        </p>
        <Link
          href="/host"
          className="mt-10 text-xs text-ink-500 underline-offset-4 hover:underline"
        >
          回到我的活動
        </Link>
      </main>
    );
  }

  if (!event) {
    return (
      <main className="flex min-h-dvh items-center justify-center">
        <span className="size-2 animate-breathe rounded-full bg-signal-500" />
      </main>
    );
  }

  return (
    <main className="mx-auto min-h-dvh max-w-3xl px-8 py-20">
      <Link
        href="/host"
        className="text-xs text-ink-600 underline-offset-4 transition-colors duration-300 ease-world hover:text-ink-300 hover:underline"
      >
        我的活動
      </Link>

      <h1 className="mt-6 text-3xl font-light text-ink-100">{event.name}</h1>
      {event.subtitle ? (
        <p className="mt-2 text-sm text-ink-400">{event.subtitle}</p>
      ) : null}

      {error ? (
        <p className="mt-8 rounded-lg border border-ink-700 bg-ink-900 px-5 py-4 text-xs leading-relaxed text-alert-500">
          {error}
        </p>
      ) : null}

      {/* 狀態控制 */}
      <section className="mt-10 rounded-lg border border-ink-800 bg-ink-900/50 p-7">
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-2">
          <h2 className="text-sm text-ink-300">目前狀態</h2>
          <span className="text-base font-light text-signal-400">
            {EVENT_STATUS_LABEL[event.status]}
          </span>
        </div>
        <p className="mt-3 text-xs leading-relaxed text-ink-500">
          {EVENT_STATUS_HINT[event.status]}
        </p>

        {STATUS_ACTIONS[event.status].length > 0 ? (
          <div className="mt-6 flex flex-wrap gap-3">
            {STATUS_ACTIONS[event.status].map((action) => (
              <button
                key={action.to}
                type="button"
                disabled={busyId === "status"}
                onClick={() => void changeStatus(action.to)}
                className="rounded-lg bg-signal-500 px-5 py-2.5 text-xs font-medium text-ink-950 transition-opacity duration-300 ease-world disabled:opacity-40"
              >
                {action.label}
              </button>
            ))}
          </div>
        ) : null}
      </section>

      {/* QR Code */}
      <div className="mt-8">
        <QrPanel code={event.code} />
      </div>

      {/* 獎項設定 */}
      <div className="mt-8">
        <PrizePanel
          eventId={event.id}
          prizes={prizes}
          onChanged={() => void refreshDrawState(event.id)}
        />
      </div>

      {/* 抽獎 */}
      <div className="mt-8">
        <DrawPanel
          eventId={event.id}
          prizes={prizes}
          draws={draws}
          onChanged={() => {
            void refreshDrawState(event.id);
            void refreshEvent();
          }}
        />
      </div>

      {/* 參與者清單 */}
      <section className="mt-14">
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm text-ink-300">
            參與者
            <span className="ml-3 text-xs text-ink-500">
              顯示中 {event.participantCount}
              {hiddenCount > 0 ? ` ｜ 已隱藏 ${hiddenCount}` : ""}
            </span>
          </h2>
        </div>

        <p className="mt-3 text-xs leading-relaxed text-ink-500">
          隱藏會讓角色從大螢幕即時消失，並排除抽獎；恢復後會重新游入。
          排除抽獎則保留角色在世界中，只是不會被抽到。
        </p>

        {participants.length === 0 ? (
          <p className="mt-8 text-sm text-ink-500">還沒有人加入。</p>
        ) : (
          <ul className="mt-6 grid gap-px overflow-hidden rounded-lg bg-ink-800 sm:grid-cols-2">
            {participants.map((participant) => (
              <li
                key={participant.id}
                className="flex items-center gap-4 bg-ink-950 p-4"
              >
                <div
                  className={`size-16 shrink-0 overflow-hidden rounded-lg bg-ink-900 ${
                    participant.isVisible ? "" : "opacity-30"
                  }`}
                >
                  {/* 參與者上傳的角色圖，來源為 Supabase Storage 公開 bucket */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={participant.imageUrl}
                    alt={`${participant.displayName} 的角色`}
                    className="size-full object-contain"
                    loading="lazy"
                  />
                </div>

                <div className="min-w-0 flex-1">
                  <p
                    className={`truncate text-sm ${
                      participant.isVisible ? "text-ink-100" : "text-ink-500"
                    }`}
                  >
                    {participant.displayName}
                  </p>
                  {participant.characterName ? (
                    <p className="truncate text-xs text-ink-500">
                      {participant.characterName}
                    </p>
                  ) : null}
                  <div className="mt-2 flex gap-3">
                    <button
                      type="button"
                      disabled={busyId === participant.id}
                      onClick={() => void toggleVisible(participant)}
                      className={`text-xs underline-offset-4 transition-colors duration-300 ease-world hover:underline disabled:opacity-40 ${
                        participant.isVisible
                          ? "text-alert-500"
                          : "text-signal-400"
                      }`}
                    >
                      {participant.isVisible ? "隱藏" : "恢復顯示"}
                    </button>
                    <button
                      type="button"
                      disabled={busyId === participant.id}
                      onClick={() => void toggleEligible(participant)}
                      className="text-xs text-ink-500 underline-offset-4 transition-colors duration-300 ease-world hover:text-ink-300 hover:underline disabled:opacity-40"
                    >
                      {participant.isEligible ? "排除抽獎" : "恢復抽獎資格"}
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
