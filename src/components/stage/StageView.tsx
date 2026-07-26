"use client";

import { useEffect, useRef, useState } from "react";
import { fetchParticipantCount } from "@/lib/join/api";
import type { PublicEvent } from "@/lib/join/api";
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
}

export function StageView({ event }: StageViewProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [count, setCount] = useState(event.participantCount);
  const [error, setError] = useState<string | null>(null);

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
  }, [event.id, event.worldTemplate]);

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
