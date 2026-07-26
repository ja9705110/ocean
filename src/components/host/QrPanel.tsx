"use client";

import { useEffect, useState } from "react";
import { generateQrSvg, joinUrl } from "@/lib/qrcode";

/**
 * QR Code 面板。可切換為全螢幕投影模式，讓全場一起掃碼。
 * 網址在 client 端組出——部署網域與本機開發不同，寫死會出錯。
 */

interface QrPanelProps {
  readonly code: string;
}

export function QrPanel({ code }: QrPanelProps) {
  const [svg, setSvg] = useState<string | null>(null);
  const [url, setUrl] = useState("");
  const [projecting, setProjecting] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const build = async () => {
      // 讓狀態更新脫離 effect 的同步階段，避免掛載當下的連鎖重渲染
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

  // 投影模式下按 Esc 離開，主持人不必找滑鼠
  useEffect(() => {
    if (!projecting) {
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setProjecting(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [projecting]);

  if (projecting) {
    return (
      <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-10 bg-ink-950 px-8">
        {svg ? (
          <div
            className="w-[min(56vh,56vw)] rounded-2xl bg-white p-6"
            // QR Code SVG 由 qrcode 套件產生，內容為固定結構的向量圖形
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        ) : null}
        <div className="text-center">
          <p className="font-mono text-2xl tracking-[0.3em] text-signal-400">
            {code}
          </p>
          <p className="mt-4 text-sm text-ink-400">{url}</p>
        </div>
        <button
          type="button"
          onClick={() => setProjecting(false)}
          className="absolute right-8 bottom-8 text-xs text-ink-600 hover:text-ink-300"
        >
          離開投影（Esc）
        </button>
      </div>
    );
  }

  return (
    <section className="rounded-lg border border-ink-800 bg-ink-900/50 p-7">
      <h2 className="text-sm text-ink-300">參與者入口</h2>

      <div className="mt-5 flex items-center gap-6">
        {svg ? (
          <div
            className="size-28 shrink-0 rounded-lg bg-white p-2"
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        ) : (
          <div className="size-28 shrink-0 rounded-lg bg-ink-800" />
        )}

        <div className="min-w-0">
          <p className="font-mono text-xl tracking-[0.25em] text-signal-400">
            {code}
          </p>
          <p className="mt-2 truncate font-mono text-xs text-ink-500">{url}</p>

          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setProjecting(true)}
              className="rounded-lg bg-signal-500 px-4 py-2 text-xs font-medium text-ink-950"
            >
              全螢幕投影
            </button>
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard.writeText(url).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                });
              }}
              className="rounded-lg border border-ink-700 px-4 py-2 text-xs text-ink-300 transition-colors duration-300 ease-world hover:bg-ink-800"
            >
              {copied ? "已複製" : "複製網址"}
            </button>
            <a
              href={`/stage/${code}`}
              target="_blank"
              rel="noreferrer"
              className="rounded-lg border border-ink-700 px-4 py-2 text-xs text-ink-300 transition-colors duration-300 ease-world hover:bg-ink-800"
            >
              開啟大螢幕
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}
