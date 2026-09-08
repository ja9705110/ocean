"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getOrCreateDeviceToken } from "@/lib/device";
import { cookieUrl, getMyCookie, submitCookie } from "@/lib/cookie/api";
import {
  anchoredBox,
  centeredBox,
  cropCookie,
  fitAspect,
  guessCookieBox,
  movedBox,
  type CropBox,
} from "@/lib/cookie/crop";
import { COOKIE_ASPECT } from "@/lib/stage/cookieBelt";

/**
 * 餅乾上傳（C14）。
 *
 * 三步：拍 → 對框 → 送出。
 *
 * 對框那一步是整個功能的重點，不是裝飾。實際拍出來的照片幾乎都是
 * 「一張裡兩塊餅乾、餅乾是斜的、背景佔一半以上」，三件事任何一件
 * 都會讓大螢幕上的馬賽克變成一片牛皮紙拼貼。
 *
 * 框會先自動放好，大部分人只要按「就是這樣」。兩百多個人排隊，
 * 能少一個動作就是少一次卡關。
 */

export interface CookieUploaderProps {
  readonly eventId: string;
  readonly eventName: string;
  readonly eventStatus: string;
}

type Stage = "idle" | "cropping" | "sending" | "done";

export function CookieUploader({
  eventId,
  eventName,
  eventStatus,
}: CookieUploaderProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);
  /**
   * 進行中的手勢。
   *
   *   move    整個框跟著手指走
   *   resize  釘住對角、拉一個角改變大小
   */
  const dragRef = useRef<
    | {
        readonly kind: "move";
        readonly pointerId: number;
        readonly startX: number;
        readonly startY: number;
        readonly box: CropBox;
      }
    | {
        readonly kind: "resize";
        readonly pointerId: number;
        /** 釘住不動的那個角，照片像素 */
        readonly anchorX: number;
        readonly anchorY: number;
      }
    | null
  >(null);

  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [imageUrl, setImageUrl] = useState<string>("");
  const [box, setBox] = useState<CropBox | null>(null);
  const [stage, setStage] = useState<Stage>("idle");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [mine, setMine] = useState<string | null>(null);

  const open = eventStatus === "open";

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const existing = await getMyCookie(eventId, getOrCreateDeviceToken());
        if (!cancelled && existing) {
          setMine(cookieUrl(existing.imagePath));
          setDisplayName(existing.displayName ?? "");
        }
      } catch {
        // 查不到自己那一張不是錯誤，可能只是還沒傳過
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [eventId]);

  const pick = useCallback((file: File | undefined) => {
    if (!file) {
      return;
    }
    setError(null);
    const url = URL.createObjectURL(file);
    const next = new Image();
    next.onload = () => {
      setImage(next);
      setImageUrl(url);
      // 先自動框好。抓不到就置中——寧可保守，也不要把人的餅乾切掉一半。
      setBox(guessCookieBox(next));
      setStage("cropping");
    };
    next.onerror = () => {
      URL.revokeObjectURL(url);
      setError("這個檔案打不開，請重新拍一次。");
    };
    next.src = url;
  }, []);

  /** 螢幕座標換算成照片本身的像素 */
  const toImagePoint = useCallback(
    (clientX: number, clientY: number) => {
      const frame = frameRef.current;
      if (!frame || !image) {
        return null;
      }
      const rect = frame.getBoundingClientRect();
      const scale = image.naturalWidth / rect.width;
      return {
        x: (clientX - rect.left) * scale,
        y: (clientY - rect.top) * scale,
      };
    },
    [image],
  );

  /** 按在框上（或照片上）：整個框跟著手指走 */
  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!box) {
        return;
      }
      event.currentTarget.setPointerCapture(event.pointerId);
      dragRef.current = {
        kind: "move",
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        box,
      };
    },
    [box],
  );

  /**
   * 按在角落上：釘住對角，拉這一角改變大小。
   *
   * stopPropagation 是必要的——不擋的話同一下也會被上面那層當成平移，
   * 框會一邊變大一邊跑掉。
   */
  const onHandleDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>, right: boolean, bottom: boolean) => {
      if (!box) {
        return;
      }
      event.stopPropagation();
      event.currentTarget.setPointerCapture(event.pointerId);
      dragRef.current = {
        kind: "resize",
        pointerId: event.pointerId,
        // 釘住的是對角
        anchorX: right ? box.x : box.x + box.width,
        anchorY: bottom ? box.y : box.y + box.height,
      };
    },
    [box],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag || !image || drag.pointerId !== event.pointerId) {
        return;
      }

      if (drag.kind === "resize") {
        const point = toImagePoint(event.clientX, event.clientY);
        if (!point) {
          return;
        }
        setBox(
          anchoredBox(
            drag.anchorX,
            drag.anchorY,
            point.x,
            point.y,
            image.naturalWidth,
            image.naturalHeight,
          ),
        );
        return;
      }

      const frame = frameRef.current;
      if (!frame) {
        return;
      }
      const rect = frame.getBoundingClientRect();
      // 螢幕上的位移換算成照片的像素
      const scale = image.naturalWidth / rect.width;

      // 框跟著手指同方向走。原本這裡是減號——那是「拖照片」的做法，
      // 但畫面上動的是框，所以手往右拖框往左跑，怎麼調都調不到想要的位置。
      setBox(
        movedBox(
          drag.box,
          (event.clientX - drag.startX) * scale,
          (event.clientY - drag.startY) * scale,
          image.naturalWidth,
          image.naturalHeight,
        ),
      );
    },
    [image, toImagePoint],
  );

  const endDrag = useCallback(() => {
    dragRef.current = null;
  }, []);

  const zoom = useCallback(
    (factor: number) => {
      if (!image || !box) {
        return;
      }
      setBox(
        fitAspect(
          box.x + box.width / 2,
          box.y + box.height / 2,
          box.width * factor,
          box.height * factor,
          image.naturalWidth,
          image.naturalHeight,
        ),
      );
    },
    [box, image],
  );

  const send = useCallback(async () => {
    if (!image || !box) {
      return;
    }
    setStage("sending");
    setError(null);
    try {
      const cropped = await cropCookie(image, box);
      const result = await submitCookie({
        eventId,
        deviceToken: getOrCreateDeviceToken(),
        blob: cropped.blob,
        extension: cropped.extension,
        displayName: displayName.trim() || undefined,
        onStatus: setStatus,
      });
      setStatus(null);
      setStage("done");
      const existing = await getMyCookie(eventId, getOrCreateDeviceToken());
      if (existing) {
        setMine(cookieUrl(existing.imagePath));
      }
      if (result.replaced) {
        setStatus("已經換成新的這一張");
      }
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : String(sendError));
      setStage("cropping");
      setStatus(null);
    }
  }, [box, displayName, eventId, image]);

  const reset = useCallback(() => {
    if (imageUrl) {
      URL.revokeObjectURL(imageUrl);
    }
    setImage(null);
    setImageUrl("");
    setBox(null);
    setStage("idle");
    setStatus(null);
  }, [imageUrl]);

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col px-6 py-10">
      <p className="text-xs tracking-[0.3em] text-ink-500 uppercase">
        {eventName}
      </p>
      <h1 className="mt-4 text-2xl font-light text-ink-100">
        上傳你的糖霜餅乾
      </h1>
      <p className="mt-3 text-sm leading-relaxed text-ink-400">
        大家的餅乾會鋪滿大螢幕上那條河，一直流下去。
      </p>

      {!open ? (
        <p className="mt-8 rounded-lg border border-ink-700 bg-ink-900 px-5 py-4 text-sm leading-relaxed text-alert-500">
          這場活動目前沒有開放上傳。
        </p>
      ) : null}

      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={(e) => pick(e.target.files?.[0])}
      />

      {stage === "idle" || stage === "done" ? (
        <div className="mt-8">
          {mine ? (
            <div>
              <p className="text-sm text-ink-300">你目前的那一張</p>
              <div
                className="mt-3 overflow-hidden rounded-xl border border-ink-700"
                style={{ aspectRatio: `${COOKIE_ASPECT}` }}
              >
                {/* 剛上傳的圖，不經過最佳化管線 */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={mine}
                  alt="你上傳的餅乾"
                  className="size-full object-cover"
                />
              </div>
            </div>
          ) : null}

          <button
            type="button"
            disabled={!open}
            onClick={() => fileRef.current?.click()}
            className="mt-6 w-full rounded-xl bg-signal-500 px-6 py-4 text-base font-medium text-ink-950 disabled:opacity-30"
          >
            {mine ? "重拍一張" : "拍我的餅乾"}
          </button>

          <p className="mt-4 text-xs leading-relaxed text-ink-500">
            一次拍一塊就好。墊一張白色餐巾或白紙，邊緣會比較清楚。
            重拍會換掉你原本那一張，不會多佔一格。
          </p>
        </div>
      ) : null}

      {(stage === "cropping" || stage === "sending") && image && box ? (
        <div className="mt-8">
          <p className="text-sm text-ink-300">把餅乾對進框裡</p>
          <p className="mt-2 text-xs leading-relaxed text-ink-500">
            框已經幫你放好了，位置對的話直接按下面。
            要調的話：<span className="text-ink-300">拖框可以移動，拉四個角可以改大小</span>。
          </p>

          <div
            ref={frameRef}
            className="relative mt-4 touch-none overflow-hidden rounded-xl border border-ink-700 select-none"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={imageUrl}
              alt="剛拍的照片"
              className="block w-full"
              draggable={false}
            />
            {/* 框外壓暗，框內保持原樣：一眼看得出哪一塊會被用到 */}
            <div
              className="absolute"
              style={{
                boxShadow: `0 0 0 9999px rgba(2, 4, 12, 0.72)`,
                left: `${(box.x / image.naturalWidth) * 100}%`,
                top: `${(box.y / image.naturalHeight) * 100}%`,
                width: `${(box.width / image.naturalWidth) * 100}%`,
                height: `${(box.height / image.naturalHeight) * 100}%`,
                outline: "2px solid rgba(116, 227, 209, 0.95)",
                borderRadius: "6px",
              }}
            >
              {/*
                四個角的把手。做得比看起來大一圈（-inset 的透明區）：
                手指的接觸面積大約 40 像素，把手畫多大就只能點多大的話，
                在手機上幾乎抓不到。
              */}
              {(
                [
                  [false, false, "cursor-nwse-resize"],
                  [true, false, "cursor-nesw-resize"],
                  [false, true, "cursor-nesw-resize"],
                  [true, true, "cursor-nwse-resize"],
                ] as const
              ).map(([right, bottom, cursor]) => (
                <div
                  key={`${right}-${bottom}`}
                  data-handle={`${right ? "r" : "l"}${bottom ? "b" : "t"}`}
                  onPointerDown={(e) => onHandleDown(e, right, bottom)}
                  onPointerMove={onPointerMove}
                  onPointerUp={endDrag}
                  onPointerCancel={endDrag}
                  className={`absolute size-11 touch-none ${cursor}`}
                  style={{
                    left: right ? undefined : "-22px",
                    right: right ? "-22px" : undefined,
                    top: bottom ? undefined : "-22px",
                    bottom: bottom ? "-22px" : undefined,
                  }}
                >
                  {/* 看得見的那一小塊角標，貼在框的角上 */}
                  <div
                    className="absolute size-5 rounded-[3px] border-2 border-signal-400 bg-ink-950/50"
                    style={{
                      left: right ? undefined : "12px",
                      right: right ? "12px" : undefined,
                      top: bottom ? undefined : "12px",
                      bottom: bottom ? "12px" : undefined,
                    }}
                  />
                </div>
              ))}
            </div>
          </div>

          <div className="mt-4 flex items-center gap-3">
            <button
              type="button"
              disabled={stage === "sending"}
              onClick={() => zoom(1.15)}
              className="flex-1 rounded-lg border border-ink-700 py-3 text-sm text-ink-200 disabled:opacity-40"
            >
              框放大
            </button>
            <button
              type="button"
              disabled={stage === "sending"}
              onClick={() => zoom(1 / 1.15)}
              className="flex-1 rounded-lg border border-ink-700 py-3 text-sm text-ink-200 disabled:opacity-40"
            >
              框縮小
            </button>
            <button
              type="button"
              disabled={stage === "sending"}
              onClick={() =>
                setBox(centeredBox(image.naturalWidth, image.naturalHeight))
              }
              className="flex-1 rounded-lg border border-ink-700 py-3 text-sm text-ink-200 disabled:opacity-40"
            >
              重置
            </button>
          </div>

          <label htmlFor="cookie-name" className="mt-6 block text-xs text-ink-400">
            想署名的話（可以不填）
          </label>
          <input
            id="cookie-name"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            maxLength={30}
            placeholder="你的名字"
            className="mt-2 w-full rounded-lg border border-ink-700 bg-ink-950 px-4 py-3 text-base text-ink-100 outline-none transition-colors duration-300 ease-world placeholder:text-ink-600 focus:border-signal-500"
          />

          <button
            type="button"
            disabled={stage === "sending"}
            onClick={() => void send()}
            className="mt-6 w-full rounded-xl bg-signal-500 px-6 py-4 text-base font-medium text-ink-950 disabled:opacity-30"
          >
            {stage === "sending" ? "上傳中…" : "就是這樣，送出"}
          </button>
          <button
            type="button"
            disabled={stage === "sending"}
            onClick={reset}
            className="mt-3 w-full py-3 text-sm text-ink-500 disabled:opacity-40"
          >
            重拍
          </button>
        </div>
      ) : null}

      {status ? (
        <p className="mt-6 text-sm text-signal-400">{status}</p>
      ) : null}
      {error ? (
        <p className="mt-6 rounded-lg border border-ink-700 bg-ink-900 px-5 py-4 text-sm leading-relaxed text-alert-500">
          {error}
        </p>
      ) : null}
    </main>
  );
}
