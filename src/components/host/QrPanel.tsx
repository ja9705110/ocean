"use client";

import { useEffect, useState } from "react";
import { generateQrSvg, joinUrl } from "@/lib/qrcode";
import { useQrImage } from "./useQrImage";

/**
 * QR Code 面板。可切換為全螢幕投影模式，讓全場一起掃碼。
 * 網址在 client 端組出——部署網域與本機開發不同，寫死會出錯。
 *
 * 除了投影，也要能把碼帶著走：報到的連結常常在活動前就要先發到
 * LINE 群組或放進通知信，那時候需要的是一張圖，不是一行網址。
 */

interface QrPanelProps {
  readonly code: string;
}

export function QrPanel({ code }: QrPanelProps) {
  const [svg, setSvg] = useState<string | null>(null);
  const [url, setUrl] = useState("");
  const [projecting, setProjecting] = useState(false);
  const [copied, setCopied] = useState(false);

  const { pngUrl, copyState, copyImage } = useQrImage(url);

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
        <div className="absolute right-8 bottom-8 flex flex-wrap items-center gap-4">
          <button
            type="button"
            onClick={copyImage}
            disabled={pngUrl === null}
            className="text-xs text-ink-600 transition-colors duration-300 ease-world hover:text-ink-300 disabled:opacity-40"
          >
            {copyState === "copied" ? "已複製圖片" : "複製 QR Code"}
          </button>
          {pngUrl ? (
            <a
              href={pngUrl}
              download={`報到-${code}.png`}
              className="text-xs text-ink-600 transition-colors duration-300 ease-world hover:text-ink-300"
            >
              下載 PNG
            </a>
          ) : null}
          <button
            type="button"
            onClick={() => setProjecting(false)}
            className="text-xs text-ink-600 transition-colors duration-300 ease-world hover:text-ink-300"
          >
            離開投影（Esc）
          </button>
        </div>
      </div>
    );
  }

  return (
    <section className="rounded-lg border border-ink-800 bg-ink-900/50 p-7">
      <h2 className="text-sm text-ink-300">參與者入口</h2>

      <div className="mt-5 flex items-center gap-6">
        {svg ? (
          <button
            type="button"
            onClick={() => setProjecting(true)}
            aria-label="放大這個 QR Code"
            className="size-28 shrink-0 cursor-zoom-in rounded-lg bg-white p-2 transition-transform duration-300 ease-world hover:scale-105"
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
            <button
              type="button"
              onClick={copyImage}
              disabled={pngUrl === null}
              className="rounded-lg border border-ink-700 px-4 py-2 text-xs text-ink-300 transition-colors duration-300 ease-world hover:bg-ink-800 disabled:opacity-40"
            >
              {copyState === "copied" ? "已複製圖片" : "複製 QR Code"}
            </button>
            {pngUrl ? (
              <a
                href={pngUrl}
                download={`報到-${code}.png`}
                className="rounded-lg border border-ink-700 px-4 py-2 text-xs text-ink-300 transition-colors duration-300 ease-world hover:bg-ink-800"
              >
                下載 PNG
              </a>
            ) : null}
            <a
              href={`/stage/${code}`}
              target="_blank"
              rel="noreferrer"
              className="rounded-lg border border-ink-700 px-4 py-2 text-xs text-ink-300 transition-colors duration-300 ease-world hover:bg-ink-800"
            >
              開啟大螢幕
            </a>
          </div>

          {copyState === "failed" ? (
            <p className="mt-3 text-xs leading-relaxed text-alert-500">
              這個瀏覽器不讓網頁把圖片放進剪貼簿（或目前不是 https）。
              請改用「下載 PNG」，再把檔案貼出去。
            </p>
          ) : null}
        </div>
      </div>
    </section>
  );
}
