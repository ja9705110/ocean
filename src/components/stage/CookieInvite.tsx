"use client";

import { useEffect, useState } from "react";
import { cookieUploadUrl, generateQrSvg } from "@/lib/qrcode";

/**
 * 大螢幕上的餅乾上傳邀請（C15）。
 *
 * 沒有這一塊，整個功能等於不存在——參與者不會知道要去哪裡上傳。
 * 兩百多個人坐在位子上，唯一可行的入口就是「抬頭看螢幕、拿起手機掃」。
 *
 * 只在餅乾馬賽克那一段顯示，而且刻意做得小、貼在角落：
 * 這時候畫面的主角是大家的餅乾，不是 QR Code。
 *
 * 網址在瀏覽器端才組得出來——部署網域跟本機開發不同，寫死一定會錯。
 */

export interface CookieInviteProps {
  readonly code: string;
  /** 已經上傳幾張。0 的時候要講得更清楚一點，因為畫面上還沒東西可看。 */
  readonly count: number;
}

export function CookieInvite({ code, count }: CookieInviteProps) {
  const [svg, setSvg] = useState<string | null>(null);
  const [url, setUrl] = useState("");

  useEffect(() => {
    let cancelled = false;

    const build = async () => {
      // 讓狀態更新脫離 effect 的同步階段，避免掛載當下的連鎖重渲染
      await Promise.resolve();
      const target = cookieUploadUrl(window.location.origin, code);
      if (cancelled) {
        return;
      }
      setUrl(target);
      try {
        const generated = await generateQrSvg(target);
        if (!cancelled) {
          setSvg(generated);
        }
      } catch {
        if (!cancelled) {
          setSvg(null);
        }
      }
    };

    void build();
    return () => {
      cancelled = true;
    };
  }, [code]);

  // 還沒有人上傳的時候放大一點：那時候螢幕上是空的，
  // 這一塊就是主角，要讓最後一排也看得到
  const empty = count === 0;

  return (
    <div
      className={
        empty
          ? "pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-6"
          : "pointer-events-none absolute right-10 bottom-10 flex items-end gap-5"
      }
    >
      <div
        className={
          empty
            ? "rounded-2xl bg-white p-6"
            : "rounded-xl bg-white/95 p-3 shadow-lg"
        }
        style={{ width: empty ? "clamp(220px, 22vw, 360px)" : "132px" }}
      >
        {svg ? (
          <div
            className="[&>svg]:block [&>svg]:size-full"
            // QR Code 是本機用 qrcode 套件產生的 SVG 字串，不是外部輸入
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        ) : (
          <div className="aspect-square animate-breathe rounded bg-ink-200" />
        )}
      </div>

      <div className={empty ? "text-center" : "pb-1"}>
        <p
          className={
            empty
              ? "text-3xl font-light text-ink-100"
              : "text-lg font-light text-ink-100"
          }
        >
          掃我，上傳你的餅乾
        </p>
        <p
          className={
            empty
              ? "mt-3 text-base leading-relaxed text-ink-300"
              : "mt-1 text-xs text-ink-400"
          }
        >
          {empty
            ? "拍一張你彩繪好的餅乾，它會變成這條河的一段"
            : `已經有 ${count} 塊在河上`}
        </p>
        {url ? (
          <p
            className={
              empty
                ? "mt-4 font-mono text-sm text-ink-500"
                : "mt-1 font-mono text-[0.65rem] text-ink-600"
            }
          >
            {url}
          </p>
        ) : null}
      </div>
    </div>
  );
}
