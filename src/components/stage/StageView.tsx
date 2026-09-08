"use client";

import { useEffect, useRef, useState } from "react";
import type { PublicEvent } from "@/lib/join/api";
import type { DrawReveal } from "@/lib/stage/realtime";
import type { EventSnapshot } from "@/lib/stage/api";
import type { DrawResult } from "@/lib/draw/api";
import type { WorldRenderer } from "@/world/engine/WorldRenderer";
import { StandbyOverlay } from "./StandbyOverlay";
import { StagePoster } from "./StagePoster";
import { RiverFlowOverlay } from "./RiverFlowOverlay";
import { RiverBase } from "./RiverBase";
import { CookieBelt } from "./CookieBelt";
import { CookieWall, type CookiePhoto } from "./CookieWall";
import { CookieInvite } from "./CookieInvite";
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
/** 餅乾照片：拍照上傳到出現在牆上，慢個十幾秒沒有人會發現 */
const COOKIE_POLL_INTERVAL_MS = 12000;

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

  /**
   * 有主視覺素材時，畫面收進置中的 16:9 方框裡。
   *
   * 兩種情況都要收：上傳完整版背景圖，或只上傳去背 PNG。
   * 只上傳去背 PNG 的時候底下跑的是程式繪製的河道，那條河也必須
   * 跟文字擠在同一個框裡，否則螢幕不是 16:9 時文字會浮在河的旁邊。
   *
   * Pixi 的 resizeTo 監聽的是視窗的 resize，不是元素本身的尺寸變化，
   * 所以要手動發一次，否則畫布會維持舊的大小。
   */
  const framed =
    stageConfig.backgroundUrl !== "" || stageConfig.overlayUrl !== "";
  useEffect(() => {
    window.dispatchEvent(new Event("resize"));
  }, [framed]);
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
  /** 餅乾照片，順序就是上傳順序（照片牆靠這個順序讓大家找得到自己） */
  const [cookiePhotos, setCookiePhotos] = useState<CookiePhoto[]>([]);
  /**
   * 讓輪詢的閉包讀得到最新的設定。
   *
   * 開場時建立的那個迴圈活到整頁結束，而設定會被中途改掉；
   * 直接抓 state 的話它永遠看到開場那一份。
   */
  const stageConfigRef = useRef(stageConfig);
  useEffect(() => {
    stageConfigRef.current = stageConfig;
  }, [stageConfig]);
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
    let cookieTimer: ReturnType<typeof setInterval> | null = null;

    const usingImage = event.stageConfig.backgroundUrl !== "";

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

      // 河道形狀（角度、彎曲、長度、寬度、位置）在建立世界之前套用：
      // 背景是建立時烘成貼圖的，套晚了就得整個重建一次
      const riverTemplate = await import("@/world/templates/river");
      riverTemplate.setRiverShape(event.stageConfig.river);
      riverTemplate.setRiverLook(event.stageConfig.riverLook);
      let appliedRiver = JSON.stringify([
        event.stageConfig.river,
        event.stageConfig.riverLook,
      ]);
      /** 目前河上裝的是不是餅乾。切換時要整批換掉（C33） */
      let appliedFlowing =
        event.stageConfig.cookies.enabled &&
        event.stageConfig.cookies.layout === "flow";

      // 有底圖時改用主視覺河道模板：簽名沿著「圖上那條河」走，
      // 而不是沿著程式自己那條。遮罩與流場跟光流層是同一份。
      let template = templates.resolveWorldTemplate(event.worldTemplate);
      if (usingImage) {
        const flowSource = await import("@/lib/stage/riverFlowSource");
        const imageRiver = await import("@/world/templates/imageRiver");
        const flow = await flowSource
          .loadRiverFlow(event.stageConfig.backgroundUrl)
          .catch(() => null);

        if (disposed) {
          return;
        }
        // 讀不到圖就退回原本的世界，總比整個大螢幕空著好
        if (flow) {
          imageRiver.setImageRiverFlow(flow);
          template = templates.resolveWorldTemplate("image-river");
        }
      }

      renderer = await WorldRenderer.create(host, template);
      renderer.setSpeedScale(event.stageConfig.flowSpeed);
      renderer.setAmbientSpeedScale(event.stageConfig.particleSpeed);
      // 用主視覺當底圖時，程式繪製的背景與環境光粒全部關掉。
      // 流動改由 RiverFlowOverlay 負責，它的遮罩與流場是從圖片本身量出來的。
      renderer.setBackgroundVisible(!usingImage);
      renderer.setAmbientVisible(!usingImage);
      // 餅乾用牆或密鋪呈現時關掉角色層，河照樣在跑；
      // 流動模式相反——角色層就是餅乾本身（C33）
      renderer.setCharactersVisible(
        !event.stageConfig.cookies.enabled ||
          event.stageConfig.cookies.layout === "flow",
      );
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

      /**
       * 餅乾正在「跟簽名一樣流」的模式（C33）。
       *
       * 這時候角色層裝的是餅乾照片而不是簽名——同一條河、同一套進場、
       * 同一套避讓，只是換一批角色。
       */
      const cookiesFlowing = () => {
        const cookies = stageConfigRef.current.cookies;
        return cookies.enabled && cookies.layout === "flow";
      };

      /**
       * 角色層的資料來源。
       *
       * 兩個來源不會同時出現在河上：簽名段就是簽名，餅乾段就是餅乾。
       * 混在一起的話河會擠成兩倍，而且兩種東西的大小不一樣，看起來很亂。
       */
      const fetchCharacters = async () => {
        if (!cookiesFlowing()) {
          return stageApi.fetchStageParticipants(event.id, display);
        }
        const cookieApi = await import("@/lib/cookie/api");
        const rows = await cookieApi.listCookies(event.id);
        return rows.map((row) => ({
          id: row.id,
          displayName: row.displayName ?? "",
          characterName: null,
          imageUrl: cookieApi.cookieUrl(row.imagePath),
          // 照片是實心的長方形，要裁成圓才不會是一塊塊硬邊的方塊
          circular: true,
          joinedAt: row.createdAt,
        }));
      };

      const reconcile = async (mode: "initial" | "entrance") => {
        const characters = await fetchCharacters();
        if (!disposed && renderer) {
          renderer.reconcile(characters, mode);
        }
      };

      /**
       * 餅乾照片。
       *
       * 廣播（cookie:changed）是主要的更新來源，下面的輪詢只是保險——
       * 現場的 Wi-Fi 斷一下、長連線掉了，牆最多落後十二秒，
       * 而不是從此再也不更新。
       */
      const refreshCookies = () => {
        if (!stageConfigRef.current.cookies.enabled) {
          return;
        }
        void import("@/lib/cookie/api")
          .then(async (cookieApi) => {
            const rows = await cookieApi.listCookies(event.id);
            if (!disposed) {
              setCookiePhotos(
                rows.map((row) => ({
                  id: row.id,
                  url: cookieApi.cookieUrl(row.imagePath),
                  name: row.displayName,
                })),
              );
            }
          })
          .catch(() => undefined);
      };

      // 初始全量載入（重整大螢幕即還原世界）
      await reconcile("initial");
      refreshCount();

      // 即時訂閱：新角色以完整進場動畫游入
      unsubscribe = stageRealtime.subscribeStageRealtime(
        event.id,
        {
        onJoined: (character) => {
          // 餅乾在流的時候，河上裝的是照片，簽名不該混進來
          if (!cookiesFlowing()) {
            renderer?.enqueue(character, "entrance");
          }
          refreshCount();
        },
        onRemoved: (id) => {
          if (!cookiesFlowing()) {
            renderer?.remove(id);
          }
          refreshCount();
        },
        onUpdated: (character) => {
          // 重畫（C28）：同一隻角色換一張圖，人數沒變所以不必重算
          if (!cookiesFlowing()) {
            renderer?.replace(character);
          }
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
        onCookieChanged: () => {
          // 有人剛拍完上傳。這一段的重點就是「他抬頭馬上看到自己」，
          // 所以不等下一次輪詢（C30）。
          refreshCookies();
          // 流動模式下，新的那一張要用完整的進場動畫游進來（C33）
          if (cookiesFlowing()) {
            void reconcile("entrance");
          }
        },
        onSubscribed: () => {
          // 重連後補漏；初次訂閱時等同再確認一次
          void reconcile("initial");
          refreshCount();
          refreshCookies();
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
            renderer?.setAmbientSpeedScale(next.config.particleSpeed);
            renderer?.setCharactersVisible(
              !next.config.cookies.enabled ||
                next.config.cookies.layout === "flow",
            );

            /*
              呈現方式換了就要換掉河上那一批角色（C33）。
              「餅乾流動 ↔ 簽名」是兩種完全不同的內容，
              沿用舊的那一批會變成簽名跟餅乾一起漂。

              stageConfigRef 在這個 effect 之後才更新，所以這裡先自己
              比對一次，不能等它。
            */
            const nextFlowing =
              next.config.cookies.enabled &&
              next.config.cookies.layout === "flow";
            if (nextFlowing !== appliedFlowing) {
              appliedFlowing = nextFlowing;
              stageConfigRef.current = next.config;
              void reconcile("initial");
            }

            // 河道形狀改了：重建背景與環境層，但不重建角色層。
            // 拉一次滑桿不該讓現場已經在流的簽名全部重新進場。
            const incomingRiver = JSON.stringify([
              next.config.river,
              next.config.riverLook,
            ]);
            if (incomingRiver !== appliedRiver && renderer) {
              appliedRiver = incomingRiver;
              riverTemplate.setRiverShape(next.config.river);
              riverTemplate.setRiverLook(next.config.riverLook);
              renderer.rebuildEnvironment();
            }

            if (next.config.backgroundUrl !== event.stageConfig.backgroundUrl) {
              // 換背景圖等於換世界（模板、遮罩、流場全都不同），重載最乾淨
              window.location.reload();
              return;
            }
            setStageConfig(next.config);
          })
          .catch(() => undefined);
      }, SETTINGS_POLL_INTERVAL_MS);

      refreshCookies();
      cookieTimer = setInterval(() => {
        if (document.visibilityState === "visible") {
          refreshCookies();
        }
      }, COOKIE_POLL_INTERVAL_MS);

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
      if (cookieTimer) {
        clearInterval(cookieTimer);
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
  }, [
    event.id,
    event.worldTemplate,
    event.stageConfig.backgroundUrl,
    display,
    stressCount,
  ]);

  // 待機畫面只在報名開放中出現，且抽獎演出期間一律讓位
  /** 測試版只顯示河流與去背主視覺，其餘一律不畫 */
  const testMode = stageConfig.testMode;

  const showStandby =
    stressCount === 0 &&
    snapshot.status === "open" &&
    reveal === null &&
    stageConfig.showQr &&
    !testMode;
  const showWall =
    stressCount === 0 && snapshot.status === "finished" && reveal === null;

  /**
   * 餅乾的兩種排法（C30）。
   *
   * 照片牆是一整個畫面，中獎者牆與抽獎演出期間要讓位；
   * 輸送帶只是疊在河上的一層，行為跟以前一樣。
   */
  const showCookieBelt =
    stageConfig.cookies.enabled && stageConfig.cookies.layout === "river";
  /**
   * 照片牆標題上方那一行。
   *
   * 優先用主視覺的外文標（FLOW / TOGETHER），沒有就退回上方小字，
   * 再沒有就用活動名稱。斜線與換行在這裡一律換成間隔點——
   * 那一行是一條橫的細字，不是兩行。
   */
  const wallOverline = (
    stageConfig.poster.titleEn ||
    stageConfig.poster.eyebrow ||
    event.name
  )
    .split(/\s*\/\s*|\n/)
    .map((part) => part.trim())
    .filter(Boolean)
    .join(" · ");

  const showCookieWall =
    stageConfig.cookies.enabled &&
    stageConfig.cookies.layout === "wall" &&
    reveal === null &&
    !showWall &&
    !testMode;

  return (
    <main className="relative h-dvh w-full overflow-hidden bg-ink-950">
      {/*
        主持人上傳的背景圖，墊在 Pixi 畫布底下。
        畫布是透明的，所以世界的光粒與角色會直接疊在這張圖上面。
      */}
      {stageConfig.backgroundUrl ? (
        /*
          主視覺畫框。底層、流動層、去背 PNG 三者都是這個容器的
          absolute inset-0 子元素，共用同一套座標——縮放時不可能錯位。
          比例取自參考圖本身（1672×941），螢幕不是這個比例時
          四周留深藍黑，不裁切。
        */
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="relative aspect-[1672/941] max-h-full w-full max-w-full">
            {/* 第一層：深藍黑水域 */}
            <div className="absolute inset-0 bg-[#02040c]" />

            {/* 第二層之一：河流底紋（參考圖，文字區已抹除） */}
            <RiverBase referenceUrl={stageConfig.backgroundUrl} />

            {/* 主視覺很亮時壓一層，簽名才看得清楚是誰 */}
            {stageConfig.backgroundDim > 0 ? (
              <div
                className="absolute inset-0 bg-[#02040c]"
                style={{ opacity: stageConfig.backgroundDim }}
              />
            ) : null}

            {/* 第二層之二：沿著河道流動的光 */}
            <RiverFlowOverlay
              imageUrl={stageConfig.backgroundUrl}
              intensity={stageConfig.flowIntensity}
              debug={stageConfig.flowDebug}
            />
          </div>
        </div>
      ) : null}

      {/*
        角色層。用主視覺當底圖時收進同一個 16:9 矩形裡，
        否則畫面不是 16:9 時簽名會流到上下的黑邊上。
        Pixi 的 resizeTo 綁的就是這個容器，換 class 它自己會跟著調整。
      */}
      <div
        className={
          framed
            ? "absolute inset-0 flex items-center justify-center"
            : "absolute inset-0"
        }
      >
        {/*
          只換 class、不換元素：條件式地渲染兩個不同的 div 會讓 React
          在切換時把舊的卸載掉，而 Pixi 的畫布是掛在那個舊元素上的，
          切一次背景圖角色就整個不見了。
        */}
        <div
          ref={hostRef}
          className={
            framed
              ? "aspect-[1672/941] max-h-full w-full max-w-full"
              : "size-full"
          }
          // 測試版把整個畫布藏起來，只留河流底圖與去背主視覺。
          //
          // 餅乾馬賽克不能用這一招：這個 div 裝的是整張 Pixi 畫布，
          // 藏起來連河都不見了，畫面只剩黑底。那一段改成只關角色層
          // （renderer.setCharactersVisible），河照樣在跑。
          style={testMode ? { visibility: "hidden" } : undefined}
        />
      </div>

      {/*
        餅乾照片：河道輸送帶版。畫在河道之上、去背主視覺之下——
        餅乾就是河的內容，而文字永遠在最上層。
      */}
      {showCookieBelt ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div
            className={
              framed
                ? "relative aspect-[1672/941] max-h-full w-full max-w-full"
                : "relative size-full"
            }
          >
            <CookieBelt
              photos={cookiePhotos.map((photo) => photo.url)}
              shape={stageConfig.river}
              display={stageConfig.cookies}
            />
          </div>
        </div>
      ) : null}

      {/*
        餅乾照片：照片牆版（C30）。
        跟輸送帶不同，這一版是一整個畫面，不是疊在河上的一層——
        兩百多張照片跟主視覺文字擠在同一個畫面只會互相蓋住。
        底下壓一層深色，照片才立體；河仍在後面透出一點點當作質地。
      */}
      {showCookieWall ? (
        <div className="absolute inset-0 flex flex-col">
          {/*
            底。不是把河關掉貼一塊黑，是把它壓成一層安靜的質地：
            照片要浮在前面，但後面那條河仍然在流——那是這場活動的背景，
            關掉之後這一段看起來會像是另一個系統的畫面。

            這一層原本加了 backdrop-blur，看起來更有層次，但量過之後
            拿掉了：兩百八十格在畫面上重排時，一個全螢幕的 backdrop-filter
            讓每一幀從 16.7 毫秒漲到 83 毫秒（60fps → 12fps）。
            現場那台接投影機的筆電禁不起這個，而且河本來就只透出一點點，
            糊不糊看不太出來。
          */}
          <div className="absolute inset-0 bg-[#02040c]/[0.90]" />
          {/* 暗角：格子的邊緣柔和地收掉，而不是硬生生切在畫面邊上 */}
          <div
            className="absolute inset-0"
            style={{
              background:
                "radial-gradient(125% 95% at 50% 44%, rgba(2,4,12,0) 40%, rgba(2,4,12,0.78) 100%)",
            }}
          />
          {/* 頂端一道極細的金線，跟主視覺的燙金同一組色 */}
          <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-[#8a6a2f] to-transparent" />

          {/*
            標題列。三段式：左邊標語、中間標題、右邊 QR。
            QR 排在這裡而不是浮在右下角——牆是鋪滿整個畫面的，
            浮在角落就等於蓋掉最後一排的人。
          */}
          <header className="relative flex shrink-0 items-center justify-between px-[3.5vw] pt-[3vh] pb-[1.4vh]">
            <div className="w-[23%]">
              {stageConfig.poster.tagline ? (
                <p className="text-[1.5vh] leading-relaxed tracking-[0.14em] whitespace-pre-line text-[#c9a45f]">
                  {stageConfig.poster.tagline}
                </p>
              ) : null}
            </div>

            <div className="text-center">
              {wallOverline ? (
                <p className="text-[1.35vh] tracking-[0.42em] text-[#9fb3cc] uppercase">
                  {wallOverline}
                </p>
              ) : null}
              <h2
                className="mt-[1.1vh] text-[5vh] leading-none font-light tracking-[0.12em]"
                // 燙金：跟主視覺標題同一道漸層
                style={{
                  backgroundImage:
                    "linear-gradient(160deg,#fff3d6 0%,#f2c063 42%,#b9822b 72%,#ffeec4 100%)",
                  WebkitBackgroundClip: "text",
                  backgroundClip: "text",
                  color: "transparent",
                }}
              >
                大家的餅乾
              </h2>
              <div className="mx-auto mt-[1.5vh] h-px w-[46%] bg-gradient-to-r from-transparent via-[#3a557f] to-transparent" />
              <p className="mt-[1.3vh] text-[1.5vh] tracking-[0.16em] text-[#c9b48a]">
                {cookiePhotos.length === 0 ? (
                  "掃碼把你的餅乾放上來"
                ) : (
                  <>
                    已經有 <span className="text-[#f2c063]">{cookiePhotos.length}</span> 張
                  </>
                )}
              </p>
            </div>

            <div className="flex w-[23%] justify-end">
              <CookieInvite
                code={event.code}
                count={cookiePhotos.length}
                placement="inline"
              />
            </div>
          </header>

          {/* 邊界由 CookieWall 自己負責——它是 absolute，父層的 padding 對它沒作用 */}
          <div className="relative min-h-0 flex-1">
            <CookieWall photos={cookiePhotos} display={stageConfig.cookies} />
          </div>
        </div>
      ) : null}

      {/*
        去背主視覺 PNG。跟背景圖無關——只上傳這一張的時候，
        底下跑的是程式繪製的河道，文字照樣蓋在最上層。
        原始座標完整覆蓋，不裁切不拉伸。
      */}
      {stageConfig.overlayUrl ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="relative aspect-[1672/941] max-h-full w-full max-w-full">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={stageConfig.overlayUrl}
              alt=""
              className="absolute inset-0 size-full object-contain"
            />
          </div>
        </div>
      ) : null}

      {/* 主視覺文字：不動的那一半。抽獎揭曉與得獎者牆期間讓位。 */}
      {stressCount === 0 && reveal === null && !showWall && !showCookieWall && !testMode ? (
        <StagePoster poster={stageConfig.poster} />
      ) : null}

      {/*
        HUD：極簡、貼邊、不搶世界的注意力。
        待機與中獎者牆自帶完整資訊，此時隱藏 HUD 以免重複。
      */}
      {/*
        關掉 QR 的時候連同上方的 HUD 一起收起來。
        主持人關 QR 的意思是「我要一個乾淨的畫面」，
        留一行活動名稱在角落只會跟左側的主視覺文字打架。
      */}
      {!showStandby && !showWall && !showCookieWall && stageConfig.showQr && !testMode ? (
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
      {showStandby && !showCookieWall ? (
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
