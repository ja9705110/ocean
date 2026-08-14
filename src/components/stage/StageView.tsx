"use client";

import { useEffect, useRef, useState } from "react";
import type { PublicEvent } from "@/lib/join/api";
import type { DrawReveal } from "@/lib/stage/realtime";
import type { EventSnapshot } from "@/lib/stage/api";
import type { DrawResult } from "@/lib/draw/api";
import type { WorldRenderer } from "@/world/engine/WorldRenderer";
import { StandbyOverlay } from "./StandbyOverlay";
import { StagePoster } from "./StagePoster";
import { WinnersWall } from "./WinnersWall";
import { BgmPlayer } from "./BgmPlayer";

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
const SNAPSHOT_POLL_INTERVAL_MS = 4000;
/** 顯示設定一場活動改不了幾次，查得比其他東西鬆一點就好 */
const SETTINGS_POLL_INTERVAL_MS = 8000;

interface StageViewProps {
  readonly event: PublicEvent;
  /** 壓力測試模式：以 N 隻本機假角色取代真實資料（?stress=350） */
  readonly stressCount?: number;
}

export function StageView({ event, stressCount = 0 }: StageViewProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  /** 顯示方式在頁面載入時決定；中途被改掉時整頁重載 */
  const display = event.stageDisplay;
  /** 流速與主視覺文字可以當場套用，不必重載 */
  const [stageConfig, setStageConfig] = useState(event.stageConfig);
  const [error, setError] = useState<string | null>(null);

  /** 活動的即時快照：狀態、人數、素材。決定大螢幕現在該顯示什麼 */
  const [snapshot, setSnapshot] = useState<EventSnapshot>({
    status: event.status,
    participantCount: event.participantCount,
    logoUrl: null,
    bgmUrl: null,
    subtitle: event.subtitle,
  });
  const [winners, setWinners] = useState<DrawResult[]>([]);
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
    let snapshotTimer: ReturnType<typeof setInterval> | null = null;
    let settingsTimer: ReturnType<typeof setInterval> | null = null;

    let refreshCount = () => undefined as void;

    const boot = async () => {
      const [{ WorldRenderer }, templates, stageApi, stageRealtime, drawApi] =
        await Promise.all([
          import("@/world/engine/WorldRenderer"),
          import("@/world/templates"),
          import("@/lib/stage/api"),
          import("@/lib/stage/realtime"),
          import("@/lib/draw/api"),
        ]);

      if (disposed) {
        return;
      }

      // 一次取回狀態、人數與素材；結束狀態時一併載入中獎名單
      refreshCount = () => {
        stageApi
          .fetchEventSnapshot(event.id)
          .then((next) => {
            if (disposed || !next) {
              return;
            }
            setSnapshot(next);
            if (next.status === "finished") {
              drawApi
                .listDraws(event.id)
                .then((rows) => {
                  if (!disposed) {
                    setWinners(rows);
                  }
                })
                .catch(() => undefined);
            }
          })
          .catch(() => undefined);
      };

      templates.registerAllTemplates();
      const template = templates.resolveWorldTemplate(event.worldTemplate);

      renderer = await WorldRenderer.create(host, template);
      renderer.setSpeedScale(event.stageConfig.flowSpeed);
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
        setSnapshot((prev) => ({ ...prev, participantCount: stressCount }));

        safetyTimer = setInterval(() => {
          if (renderer) {
            setStats(renderer.stats);
          }
        }, 1000);
        return;
      }

      const reconcile = async (mode: "initial" | "entrance") => {
        const characters = await stageApi.fetchStageParticipants(
          event.id,
          display,
        );
        if (!disposed && renderer) {
          renderer.reconcile(characters, mode);
        }
      };

      // 初始全量載入（重整大螢幕即還原世界）
      await reconcile("initial");
      refreshCount();

      // 即時訂閱：新角色以完整進場動畫游入
      unsubscribe = stageRealtime.subscribeStageRealtime(
        event.id,
        {
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
        },
        display,
      );

      // 廣播整路失效時的保險：定期安靜對帳
      safetyTimer = setInterval(() => {
        if (document.visibilityState === "visible") {
          void reconcile("initial");
        }
      }, SAFETY_RECONCILE_INTERVAL_MS);

      // 主持人在活動中途改設定時的兩種反應：
      //
      // 流速與主視覺文字可以當場套用，改一下就看到。
      //
      // 顯示方式（簽名 / 彩繪 / 兩者）則要每一位的貼圖都換掉。與其在
      // 渲染器裡做一套「換圖」的路徑，不如直接重載整頁——這個動作一場
      // 活動最多發生兩三次，而重載保證畫面與設定一致，不會殘留半套舊貼圖。
      settingsTimer = setInterval(() => {
        if (document.visibilityState !== "visible") {
          return;
        }
        stageApi
          .fetchStageSettings(event.id)
          .then((next) => {
            if (disposed) {
              return;
            }
            if (next.display !== display) {
              window.location.reload();
              return;
            }
            renderer?.setSpeedScale(next.config.flowSpeed);
            setStageConfig(next.config);
          })
          .catch(() => undefined);
      }, SETTINGS_POLL_INTERVAL_MS);

      // 狀態與人數要跟得上：待機畫面的計數變動是現場的即時回饋，
      // 主持人切換狀態後大螢幕也該立刻換畫面
      snapshotTimer = setInterval(() => {
        if (document.visibilityState === "visible") {
          refreshCount();
        }
      }, SNAPSHOT_POLL_INTERVAL_MS);
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
      if (settingsTimer) {
        clearInterval(settingsTimer);
      }
      if (safetyTimer) {
        clearInterval(safetyTimer);
      }
      if (snapshotTimer) {
        clearInterval(snapshotTimer);
      }
      unsubscribe?.();
      renderer?.destroy();
      renderer = null;
    };
    // event.stageConfig.flowSpeed 刻意不在相依陣列裡：它只用來設定初始值，
    // 之後的變更由輪詢直接呼叫 setSpeedScale 套用。放進來會讓改一次速度
    // 就整個世界重建一次，所有簽名重新進場。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [event.id, event.worldTemplate, display, stressCount]);

  // 待機畫面只在報名開放中出現，且抽獎演出期間一律讓位
  const showStandby =
    stressCount === 0 && snapshot.status === "open" && reveal === null;
  const showWall =
    stressCount === 0 && snapshot.status === "finished" && reveal === null;

  return (
    <main className="relative h-dvh w-full overflow-hidden bg-ink-950">
      <div ref={hostRef} className="absolute inset-0" />

      {/* 主視覺文字：不動的那一半。抽獎揭曉與得獎者牆期間讓位。 */}
      {stressCount === 0 && reveal === null && !showWall ? (
        <StagePoster poster={stageConfig.poster} />
      ) : null}

      {/*
        HUD：極簡、貼邊、不搶世界的注意力。
        待機與中獎者牆自帶完整資訊，此時隱藏 HUD 以免重複。
      */}
      {!showStandby && !showWall ? (
        <header className="pointer-events-none absolute top-0 right-0 left-0 flex items-baseline justify-between px-10 py-7">
          <div className="flex items-center gap-5">
            {snapshot.logoUrl ? (
              // 主持人上傳的活動 Logo
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={snapshot.logoUrl}
                alt=""
                className="max-h-10 max-w-40 object-contain"
              />
            ) : null}
            <div>
              <p className="text-[0.6rem] tracking-[0.4em] text-ink-400/70 uppercase">
                {event.code}
              </p>
              <h1 className="mt-1 text-xl font-light text-ink-100/90">
                {event.name}
              </h1>
            </div>
          </div>
          <p className="text-sm font-light text-ink-200/80">
            <span className="mr-2 text-2xl text-signal-400/90">
              {snapshot.participantCount}
            </span>
            位加入
          </p>
        </header>
      ) : null}

      {/* 待機：報名開放中且沒有抽獎演出時，讓 QR Code 佔據視覺重心 */}
      {showStandby ? (
        <StandbyOverlay
          code={event.code}
          count={snapshot.participantCount}
          eventName={event.name}
          subtitle={snapshot.subtitle}
          logoUrl={snapshot.logoUrl}
        />
      ) : null}

      {/* 結束：中獎者牆 */}
      {showWall ? (
        <WinnersWall draws={winners} eventName={event.name} />
      ) : null}

      {snapshot.bgmUrl ? <BgmPlayer url={snapshot.bgmUrl} /> : null}

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
