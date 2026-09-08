"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { COOKIE_ASPECT } from "@/lib/stage/cookieBelt";
import {
  EMPTY_WALL_PLAN,
  pageOfIndex,
  planCookieWall,
  wallCells,
} from "@/lib/stage/cookieWall";
import type { CookieDisplay } from "@/lib/stage/riverShape";

/**
 * 餅乾照片牆（C30）。
 *
 * 全部的照片同時排在畫面上，不流動。有人上傳就多一格、整面牆重排一次，
 * 而且那一格會先亮一下——現場的人抬頭就知道「我的上去了」。
 *
 * 為什麼是 DOM 而不是 canvas：
 *
 * 這一層要的是「照片、名字、還有讓它們平順地移到新位置」。
 * canvas 三件事都要自己刻，DOM 三件事都是現成的——照片交給瀏覽器載，
 * 名字交給排版，移動交給 CSS transition。輸送帶用 canvas 是因為
 * 那邊每一幀都在動、而且要沿著曲線旋轉，這裡完全不需要。
 *
 * 每一格都是同一個尺寸的盒子再用 transform 縮放，而不是直接改寬高：
 * transform 不觸發版面重算，兩百多格同時移動才不會掉幀。
 * 盒子裡的字也跟著縮，名字與照片的比例在任何格子大小下都一樣。
 */

export interface CookiePhoto {
  readonly id: string;
  readonly url: string;
  readonly name: string | null;
}

export interface CookieWallProps {
  readonly photos: readonly CookiePhoto[];
  readonly display: CookieDisplay;
}

/** 每一格的基準寬度。實際大小靠 transform: scale 調，這個值只是內部單位。 */
const BASE_TILE = 240;

/** 名字那一條佔格寬的幾倍高 */
const LABEL_RATIO = 0.3;

/**
 * 小於這個格寬就不寫名字（實際像素，不是基準像素）。
 *
 * 字是格寬的 0.14 倍，格子小於這個尺寸時那行字在投影幕上根本讀不到，
 * 而它佔掉的空間會讓每一張照片都變小。與其留一排看不見的字，
 * 不如把空間還給照片——人多的時候大家想看的是「牆滿了」，
 * 人少的時候才會一個一個找名字。
 */
const NAME_MIN_TILE = 110;

/** 新上傳的那一張要亮多久 */
const HIGHLIGHT_MS = 9000;

/** 以 1600 寬的畫面為基準訂的設定，換到別的解析度要等比例縮放 */
const BASE_WIDTH = 1600;

export function CookieWall({ photos, display }: CookieWallProps) {
  const areaRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const area = areaRef.current;
    if (!area) {
      return;
    }
    const observer = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (box) {
        setSize({ width: box.width, height: box.height });
      }
    });
    observer.observe(area);
    return () => observer.disconnect();
  }, []);

  /**
   * 排法與「要不要寫名字」互相影響，所以算兩次。
   *
   * 名字會讓每一格變高，格子因此變小；格子小到一定程度那行字就讀不到了。
   * 先算沒有名字的版本看格子有多大，夠大才把名字的空間加回去；
   * 加回去之後如果反而縮到讀不到，就退回沒有名字的版本。
   * 兩個候選、一次判斷，不會在兩種排法之間來回跳。
   */
  const { plan, withNames } = useMemo(() => {
    if (size.width <= 0 || size.height <= 0) {
      return { plan: EMPTY_WALL_PLAN, withNames: false };
    }

    // 設定是以 1600 寬的畫面訂的：4K 投影機上不縮放的話格子會變成一堆小點
    const scale = size.width / BASE_WIDTH;
    const shared = {
      width: size.width,
      height: size.height,
      count: photos.length,
      gapRatio: display.wallGap / 100,
      minTile: display.wallMinTile * scale,
      // 人少的時候不要把三張照片撐滿整個投影幕
      maxTile: Math.min(size.width * 0.22, 420 * scale),
    };

    const bare = planCookieWall({ ...shared, labelRatio: 0 });
    if (!display.wallNames || bare.tileWidth < NAME_MIN_TILE) {
      return { plan: bare, withNames: false };
    }

    const named = planCookieWall({ ...shared, labelRatio: LABEL_RATIO });
    return named.tileWidth >= NAME_MIN_TILE
      ? { plan: named, withNames: true }
      : { plan: bare, withNames: false };
  }, [
    size,
    photos.length,
    display.wallGap,
    display.wallMinTile,
    display.wallNames,
  ]);

  const [page, setPage] = useState(0);

  /**
   * 剛上傳的那幾張。
   *
   * 只認 id：重排、換頁、重新整理清單都不該讓一張舊照片重新亮一次。
   */
  const seenRef = useRef<Set<string> | null>(null);
  const [fresh, setFresh] = useState<readonly string[]>([]);

  useEffect(() => {
    let cancelled = false;

    const detect = async () => {
      // 讓狀態更新脫離 effect 的同步階段
      await Promise.resolve();
      if (cancelled) {
        return;
      }

      const ids = photos.map((photo) => photo.id);

      // 第一次載入不算「剛上傳」：整面牆一起亮起來沒有任何意義
      if (seenRef.current === null) {
        seenRef.current = new Set(ids);
        return;
      }

      const seen = seenRef.current;
      const added = ids.filter((id) => !seen.has(id));
      if (added.length === 0) {
        return;
      }
      for (const id of added) {
        seen.add(id);
      }

      setFresh(added);

      // 剛上傳的人要立刻在畫面上看到自己，所以跳到他那一頁。
      // 多張同時進來時看最後一張——那是最新的。
      const lastId = added[added.length - 1];
      const index = ids.lastIndexOf(lastId ?? "");
      if (index >= 0) {
        setPage(pageOfIndex(plan, index));
      }
    };

    void detect();
    return () => {
      cancelled = true;
    };
    // plan 刻意不放進相依：它會隨著視窗大小變，而那不該重跑一次「誰是新的」
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [photos]);

  // 亮一陣子就收起來
  useEffect(() => {
    if (fresh.length === 0) {
      return;
    }
    const timer = setTimeout(() => setFresh([]), HIGHLIGHT_MS);
    return () => clearTimeout(timer);
  }, [fresh]);

  // 放不下而分頁時自動輪播
  useEffect(() => {
    if (plan.pages <= 1) {
      return;
    }
    const timer = setInterval(
      () => setPage((current) => (current + 1) % plan.pages),
      Math.max(5, display.wallPageSeconds) * 1000,
    );
    return () => clearInterval(timer);
  }, [plan.pages, display.wallPageSeconds]);

  // 照片變少（主持人藏了幾張）之後，原本停的那一頁可能已經不存在
  const safePage = plan.pages > 0 ? Math.min(page, plan.pages - 1) : 0;

  const cells = useMemo(
    () => wallCells(plan, safePage, photos.length),
    [plan, safePage, photos.length],
  );

  const scale = plan.tileWidth / BASE_TILE;
  const freshSet = useMemo(() => new Set(fresh), [fresh]);

  // 基準單位下的高度：照片本身，以及照片加上名字的一整格
  const basePhotoHeight = BASE_TILE / COOKIE_ASPECT;
  const baseCellHeight =
    plan.tileWidth > 0
      ? (BASE_TILE * plan.cellHeight) / plan.tileWidth
      : basePhotoHeight;

  return (
    <div className="absolute inset-0 flex flex-col px-[3vw] pb-[1.6vh]">
      <style>{`
        /*
          進場：微微放大並上浮。純淡入在幾百格同時出現時看起來像
          整片一起閃了一下，帶一點位移才像「一張一張擺上去」。
        */
        @keyframes cookieWallRise {
          from { opacity: 0; transform: scale(0.9) translateY(1.6%); }
          to   { opacity: 1; transform: scale(1) translateY(0); }
        }
        /*
          剛上傳的那一張：金色的邊在呼吸。
          金色是這場活動主視覺的顏色，跟標題的燙金是同一套。
        */
        @keyframes cookieWallGlow {
          0%, 100% { box-shadow: 0 0 0 3px rgba(242, 192, 99, 0.95),
                                 0 0 46px 10px rgba(242, 192, 99, 0.30),
                                 0 12px 30px rgba(0, 0, 0, 0.55); }
          50%      { box-shadow: 0 0 0 3px rgba(242, 192, 99, 0.45),
                                 0 0 26px 4px rgba(242, 192, 99, 0.10),
                                 0 12px 30px rgba(0, 0, 0, 0.55); }
        }
      `}</style>

      {/*
        量的是這一格的 content box，格子的座標也是以它為準。
        邊界一定要加在外層的 flex 容器上——absolute inset-0 的子元素
        是相對於父層的 padding box 定位的，父層加 padding 對它沒有作用。
      */}
      <div ref={areaRef} className="relative min-h-0 flex-1">
        {cells.map((cell, order) => {
          const photo = photos[cell.index];
          if (!photo) {
            return null;
          }
          const isFresh = freshSet.has(photo.id);

          return (
            <div
              key={photo.id}
              className="absolute top-0 left-0 will-change-transform"
              style={{
                width: BASE_TILE,
                height: baseCellHeight,
                transform: `translate3d(${cell.x}px, ${cell.y}px, 0) scale(${scale})`,
                transformOrigin: "top left",
                // 重排時平順地移過去。進場動畫在內層，兩者不會打架：
                // 一個管位置，一個管自己內部的縮放與透明度。
                transition:
                  "transform 700ms cubic-bezier(0.22, 0.61, 0.36, 1)",
              }}
            >
              <div
                style={{
                  animation:
                    "cookieWallRise 620ms cubic-bezier(0.16, 1, 0.3, 1) both",
                  /*
                    依序擺上去而不是同時出現：頒獎典禮最後那面牆是一張一張
                    亮起來的，那個節奏就是「質感」的來源。
                    剛上傳的那一張不等——他正抬頭在找自己。
                    上限 1.4 秒，兩百多張才不會等到最後一張還沒出現。
                  */
                  animationDelay: isFresh ? "0ms" : `${Math.min(order * 11, 1400)}ms`,
                }}
              >
                <div
                  className="relative overflow-hidden bg-ink-900"
                  style={{
                    width: BASE_TILE,
                    height: basePhotoHeight,
                    // 圓角跟著格子縮放，任何大小下弧度看起來都一樣
                    borderRadius: BASE_TILE * 0.075,
                    animation: isFresh
                      ? "cookieWallGlow 1.8s ease-in-out infinite"
                      : undefined,
                    boxShadow: isFresh
                      ? undefined
                      : "0 10px 26px rgba(0, 0, 0, 0.5)",
                  }}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={photo.url}
                    alt=""
                    className="size-full object-cover"
                    loading="lazy"
                    decoding="async"
                  />
                  {/*
                    暖色細邊。照片直接落在深底上邊緣會糊掉，
                    一條淡金的線把每一張收乾淨——這是「像一張照片」
                    而不是「一塊色塊」的差別。
                    用獨立一層而不是 inset shadow：inset 會被上面的
                    <img> 蓋掉。
                  */}
                  <div
                    className="pointer-events-none absolute inset-0"
                    style={{
                      borderRadius: BASE_TILE * 0.075,
                      border: `${BASE_TILE * 0.006}px solid rgba(232, 201, 140, ${
                        isFresh ? 0 : 0.22
                      })`,
                    }}
                  />
                </div>

                {withNames ? (
                  <p
                    className="truncate text-center"
                    style={{
                      width: BASE_TILE,
                      marginTop: BASE_TILE * 0.055,
                      fontSize: BASE_TILE * 0.125,
                      lineHeight: 1.25,
                      letterSpacing: "0.06em",
                      // 暖灰：跟主視覺上的日期、場地是同一個色階
                      color: isFresh ? "#f2c063" : "#c9b48a",
                    }}
                  >
                    {photo.name ?? ""}
                  </p>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>

      {/*
        分頁指示。只在真的分頁時出現——一頁就放得下的時候多一排點
        只是告訴大家「還有沒看到的」，而那時候並沒有。
      */}
      {plan.pages > 1 ? (
        <div className="flex shrink-0 items-center justify-center gap-2.5 pt-[1.4vh]">
          {Array.from({ length: plan.pages }, (_, i) => (
            <span
              key={i}
              className="h-px transition-all duration-700 ease-world"
              style={{
                width: i === safePage ? "3.2vw" : "1.1vw",
                backgroundColor: i === safePage ? "#f2c063" : "#3a557f",
              }}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
