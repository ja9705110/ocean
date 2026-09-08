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
  /**
   * 擺哪裡（C30）。
   *
   *   floating  浮在畫面右下角。輸送帶那一版用這個——河從畫面上流過，
   *             右下角本來就是空的。
   *   inline    照片牆用這個：牆是鋪滿整個畫面的，浮在角落等於蓋掉
   *             最後一排的人。改成排進標題列，誰都不擋誰。
   *
   * 還沒有人上傳時兩種都會放大到畫面中央——那時候畫面是空的，
   * 這一塊就是主角。
   */
  readonly placement?: "floating" | "inline";
}

export function CookieInvite({
  code,
  count,
  placement = "floating",
}: CookieInviteProps) {
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

  // 排進標題列的那一版：小、橫的、不佔位置
  if (!empty && placement === "inline") {
    return (
      <div className="pointer-events-none flex items-center gap-[1vw]">
        <div className="text-right">
          <p className="text-[1.4vh] tracking-[0.12em] text-[#c9b48a]">
            掃我，上傳你的餅乾
          </p>
          <p className="mt-[0.6vh] text-[1.15vh] tracking-[0.1em] text-[#7d8ba4]">
            隨時都可以加進來
          </p>
        </div>
        {/*
          暖白底加一圈淡金：純白的方塊落在深底上會是整個畫面最亮的東西，
          把眼睛從照片那邊拉走。QR 只要掃得到就好，不必最搶眼。
        */}
        <div
          className="p-[0.5vh]"
          style={{
            width: "7.6vh",
            backgroundColor: "#f4efe4",
            borderRadius: "0.7vh",
            boxShadow:
              "0 0 0 1px rgba(232,201,140,0.4), 0 8px 22px rgba(0,0,0,0.55)",
          }}
        >
          {svg ? (
            <div
              className="[&>svg]:block [&>svg]:size-full"
              dangerouslySetInnerHTML={{ __html: svg }}
            />
          ) : (
            <div className="aspect-square animate-breathe rounded bg-ink-200" />
          )}
        </div>
      </div>
    );
  }

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
