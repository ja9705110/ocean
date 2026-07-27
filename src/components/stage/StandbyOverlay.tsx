"use client";

import { useEffect, useState } from "react";
import { generateQrSvg, joinUrl } from "@/lib/qrcode";

/**
 * 待機畫面：世界照常運轉，QR Code 與人數疊在上層。
 *
 * 報名開放期間，投影幕的首要任務是讓全場掃到碼。
 * 但世界本身也要看得見——那是吸引大家加入的原因，
 * 所以用側欄而非整頁遮蔽。
 */

interface StandbyOverlayProps {
  readonly code: string;
  readonly count: number;
  readonly eventName: string;
  readonly subtitle: string | null;
  readonly logoUrl: string | null;
}

export function StandbyOverlay({
  code,
  count,
  eventName,
  subtitle,
  logoUrl,
}: StandbyOverlayProps) {
  const [svg, setSvg] = useState<string | null>(null);
  const [url, setUrl] = useState("");

  useEffect(() => {
    let cancelled = false;

    const build = async () => {
      await Promise.resolve();
      const target = joinUrl(window.location.origin, code);
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
    <div className="pointer-events-none absolute inset-0 flex items-center justify-end">
      {/* 由右向左的暗幕，確保白色 QR 與文字在任何世界背景上都清晰 */}
      <div className="absolute inset-y-0 right-0 w-[46%] bg-gradient-to-l from-ink-950 via-ink-950/92 to-transparent" />

      <div className="relative flex w-[38%] flex-col items-center px-12 text-center">
        {logoUrl ? (
          // 主持人上傳的活動 Logo
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={logoUrl}
            alt=""
            className="mb-10 max-h-24 max-w-[60%] object-contain"
          />
        ) : null}

        <p className="text-xs tracking-[0.45em] text-ink-400/80 uppercase">
          掃碼加入
        </p>

        {svg ? (
          <div
            className="mt-8 w-[min(30vh,26vw)] rounded-2xl bg-white p-5"
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        ) : (
          <div className="mt-8 aspect-square w-[min(30vh,26vw)] rounded-2xl bg-ink-800" />
        )}

        <p className="mt-7 font-mono text-3xl tracking-[0.3em] text-signal-400">
          {code}
        </p>
        <p className="mt-3 font-mono text-xs break-all text-ink-500">{url}</p>

        <div className="mt-12">
          <p className="text-6xl font-light text-ink-100 tabular-nums">
            {count}
          </p>
          <p className="mt-2 text-sm text-ink-400">位已經在世界裡</p>
        </div>

        <div className="mt-12">
          <p className="text-lg font-light text-ink-200">{eventName}</p>
          {subtitle ? (
            <p className="mt-2 text-sm text-ink-500">{subtitle}</p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
