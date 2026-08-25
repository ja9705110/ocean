"use client";

import { useEffect, useState } from "react";
import { cookieUploadUrl, generateQrSvg } from "@/lib/qrcode";

/**
 * 餅乾上傳的 QR Code（後台）。
 *
 * 大螢幕上已經有一個，這一份是給「印出來放在彩繪桌上」用的：
 * 現場排隊彩繪的人背對螢幕，桌上有一張才不用一直回頭。
 *
 * 網址在瀏覽器端才組得出來——部署網域跟本機開發不同，寫死一定會錯。
 */

interface CookieQrProps {
  readonly code: string;
}

export function CookieQr({ code }: CookieQrProps) {
  const [svg, setSvg] = useState<string | null>(null);
  const [url, setUrl] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const build = async () => {
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

  return (
    <div className="flex flex-wrap items-center gap-5">
      <div className="w-32 shrink-0 rounded-lg bg-white p-2">
        {svg ? (
          <div
            className="[&>svg]:block [&>svg]:size-full"
            // 本機用 qrcode 套件產生的 SVG 字串，不是外部輸入
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        ) : (
          <div className="aspect-square animate-breathe rounded bg-ink-200" />
        )}
      </div>

      <div className="min-w-0 flex-1">
        <p className="text-xs text-ink-400">上傳餅乾的網址</p>
        <p className="mt-1 font-mono text-xs break-all text-ink-300">{url}</p>
        <div className="mt-3 flex flex-wrap gap-3">
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard?.writeText(url).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              });
            }}
            className="rounded-lg border border-ink-700 px-4 py-2 text-xs text-ink-200"
          >
            {copied ? "已複製" : "複製網址"}
          </button>
          <button
            type="button"
            onClick={() => window.print()}
            className="rounded-lg border border-ink-700 px-4 py-2 text-xs text-ink-200"
          >
            列印這一頁
          </button>
        </div>
        <p className="mt-3 text-xs leading-relaxed text-ink-500">
          印一張放在彩繪桌上。現場排隊的人背對螢幕，桌上有一張才不用回頭。
        </p>
      </div>
    </div>
  );
}
