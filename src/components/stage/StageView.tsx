"use client";

import { useEffect, useRef, useState } from "react";
import { fetchParticipantCount } from "@/lib/join/api";
import type { PublicEvent } from "@/lib/join/api";
import type { DrawReveal } from "@/lib/stage/realtime";
import type { WorldRenderer } from "@/world/engine/WorldRenderer";

/**
 * 大螢幕的 React 外殼。
 *
 * PixiJS 與模板全部走動態 import，只在瀏覽器端載入；
 * SSR 只輸出一個空容器。React StrictMode 在開發模式會 double-mount，
 * 以 disposed 旗標與確實的 destroy 防止洩漏出第二個 WebGL context。
 *
 * 同步策略（M4）：
 * - 即時：訂閱資料庫廣播，新角色 1~2 秒內游入、隱藏即時移除
 * - 對帳：頻道每次（重新）訂閱成功時全量比對一次，補漏斷線期間的變更
 * - 保險：每 20 秒安靜對帳一輪，即使廣播整路失效，畫面最多落後 20 秒
 */

const SAFETY_RECONCILE_INTERVAL_MS = 20000;

interface StageViewProps {
  readonly event: PublicEvent;
  /** 壓力測試模式：以 N 隻本機假角色取代真實資料（?stress=350） */
  readonly stressCount?: number;
}

export function StageView({ event, stressCount = 0 }: StageViewProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [count, setCount] = useState(event.participantCount);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<{
    fps: number;
    updateMs: number;
    loaded: number;
    pending: number;
    contextLost: boolean;
  } | null>(null);

  /** 抽獎揭曉：null 表示沒有進行中的演出 */
  const [reveal, setReveal] = useState<DrawReveal | null>(null);
  /** 聚集階段結束、可以顯示姓名了 */
  const [revealed, setRevealed] = useState(false);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return;
    }

    let disposed = false;
    let renderer: WorldRenderer | null = null;
    let unsubscribe: (() => void) | null = null;
    let safetyTimer: ReturnType<typeof setInterval> | null = null;

    const refreshCount = () => {
      fetchParticipantCount(event.id)
        .then((value) => {
          if (!disposed) {
            setCount(value);
          }
        })
        .catch(() => undefined);
    };

    const boot = async () => {
      const [{ WorldRenderer }, templates, stageApi, stageRealtime] =
        await Promise.all([
          import("@/world/engine/WorldRenderer"),
          import("@/world/templates"),
          import("@/lib/stage/api"),
          import("@/lib/stage/realtime"),
        ]);

      if (disposed) {
        return;
      }

      templates.registerAllTemplates();
      const template = templates.resolveWorldTemplate(event.worldTemplate);

      renderer = await WorldRenderer.create(host, template);
      if (disposed) {
        renderer.destroy();
        renderer = null;
        return;
      }

      // 壓力測試模式：本機生成假角色，不連線任何後端
      if (stressCount > 0) {
        const { generateStressCharacters } = await import("@/lib/stage/stress");
        const fakes = generateStressCharacters(stressCount);
        if (disposed || !renderer) {
          return;
        }
        renderer.reconcile(fakes, "initial");
        setCount(stressCount);

        safetyTimer = setInterval(() => {
          if (renderer) {
            setStats(renderer.stats);
          }
        }, 1000);
        return;
      }

      const reconcile = async (mode: "initial" | "entrance") => {
        const characters = await stageApi.fetchStageParticipants(event.id);
        if (!disposed && renderer) {
          renderer.reconcile(characters, mode);
        }
      };

      // 初始全量載入（重整大螢幕即還原世界）
      await reconcile("initial");
      refreshCount();

      // 即時訂閱：新角色以完整進場動畫游入
      unsubscribe = stageRealtime.subscribeStageRealtime(event.id, {
        onJoined: (character) => {
          renderer?.enqueue(character, "entrance");
          refreshCount();
        },
        onRemoved: (id) => {
          renderer?.remove(id);
          refreshCount();
        },
        onDrawReveal: (incoming) => {
          if (disposed || !renderer) {
            return;
          }
          setReveal(incoming);
          setRevealed(false);
          renderer.playDrawSequence(
            incoming.participantId,
            () => {
              if (!disposed) {
                setRevealed(true);
              }
            },
            () => undefined,
          );
        },
        onDrawVoided: () => {
          if (disposed) {
            return;
          }
          renderer?.endDrawSequence();
          setReveal(null);
          setRevealed(false);
        },
        onSubscribed: () => {
          // 重連後補漏；初次訂閱時等同再確認一次
          void reconcile("initial");
          refreshCount();
        },
      });

      // 廣播整路失效時的保險：定期安靜對帳
      safetyTimer = setInterval(() => {
        if (document.visibilityState === "visible") {
          void reconcile("initial");
          refreshCount();
        }
      }, SAFETY_RECONCILE_INTERVAL_MS);
    };

    boot().catch((bootError: unknown) => {
      if (!disposed) {
        const message =
          bootError instanceof Error ? bootError.message : String(bootError);
        setError(message);
      }
    });

    return () => {
      disposed = true;
      if (safetyTimer) {
        clearInterval(safetyTimer);
      }
      unsubscribe?.();
      renderer?.destroy();
      renderer = null;
    };
  }, [event.id, event.worldTemplate, stressCount]);

  return (
    <main className="relative h-dvh w-full overflow-hidden bg-ink-950">
      <div ref={hostRef} className="absolute inset-0" />

      {/* HUD：極簡、貼邊、不搶世界的注意力 */}
      <header className="pointer-events-none absolute top-0 right-0 left-0 flex items-baseline justify-between px-10 py-7">
        <div>
          <p className="text-[0.6rem] tracking-[0.4em] text-ink-400/70 uppercase">
            {event.code}
          </p>
          <h1 className="mt-1 text-xl font-light text-ink-100/90">
            {event.name}
          </h1>
        </div>
        <p className="text-sm font-light text-ink-200/80">
          <span className="mr-2 text-2xl text-signal-400/90">{count}</span>
          位加入
        </p>
      </header>

      {/* 抽獎揭曉：文字疊在 Pixi 畫面之上，動畫由 WorldRenderer 負責 */}
      {reveal ? (
        <>
          {/*
            由下而上的暗色漸層。350 隻角色聚集時必定會壓到文字，
            沒有這層底幕，中獎者姓名在現場投影上會讀不出來。
          */}
          <div
            className={`pointer-events-none absolute inset-x-0 bottom-0 h-[46vh] bg-gradient-to-t from-ink-950 via-ink-950/85 to-transparent transition-opacity duration-1000 ease-world ${
              revealed ? "opacity-100" : "opacity-0"
            }`}
          />
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-end pb-[12vh]">
          <p
            className={`text-sm tracking-[0.4em] text-signal-400/90 uppercase transition-all duration-1000 ease-world ${
              revealed
                ? "translate-y-0 opacity-100"
                : "translate-y-4 opacity-0"
            }`}
          >
            {reveal.prizeName}
          </p>
          <p
            className={`mt-5 text-6xl leading-tight font-light text-ink-100 transition-all delay-200 duration-1000 ease-world ${
              revealed
                ? "translate-y-0 opacity-100"
                : "translate-y-6 opacity-0"
            }`}
          >
            {reveal.displayName}
          </p>
          {reveal.characterName ? (
            <p
              className={`mt-4 text-xl font-light text-ink-300 transition-all delay-500 duration-1000 ease-world ${
                revealed ? "opacity-100" : "opacity-0"
              }`}
            >
              {reveal.characterName}
            </p>
          ) : null}
          </div>
        </>
      ) : null}

      {stats ? (
        <p className="absolute bottom-5 left-10 font-mono text-xs text-ink-400/80">
          壓力測試 目標 {stressCount} ｜ 已載入 {stats.loaded}
          {stats.pending > 0 ? `（佇列 ${stats.pending}）` : ""} ｜ {stats.fps}{" "}
          fps ｜ 邏輯更新 {stats.updateMs.toFixed(2)} ms/幀
          {stats.contextLost ? " ｜ WebGL context 已遺失" : ""}
        </p>
      ) : null}

      {error ? (
        <div className="absolute inset-0 flex items-center justify-center">
          <p className="max-w-md rounded-lg border border-ink-700 bg-ink-900/90 px-6 py-4 text-sm leading-relaxed text-alert-500">
            世界載入失敗：{error}
          </p>
        </div>
      ) : null}
    </main>
  );
}
