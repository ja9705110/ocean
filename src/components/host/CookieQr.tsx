"use client";

import { useCallback, useEffect, useState } from "react";
import { cookieUploadUrl, generateQrSvg } from "@/lib/qrcode";
import { useQrImage } from "./useQrImage";

/**
 * 餅乾上傳的 QR Code（後台）。
 *
 * 大螢幕上已經有一個，這一份是給主持人自己處置的：
 * 印出來放在彩繪桌上、貼到 LINE 群組、放進當天的簡報。
 *
 * 所以這裡不是只給一個網址就算數——網址要別人自己打字，現場沒有人會打。
 * 四種帶得走的形式都要一鍵拿得到：
 *
 *   放大        —— 直接投影或讓人對著螢幕掃，什麼都不用存
 *   複製 QR     —— 剪貼簿裡是一張 PNG，可以直接貼進 LINE 或簡報
 *   下載 PNG    —— 剪貼簿寫圖片不是每個瀏覽器都支援，這是保底的那條路
 *   複製網址    —— 要發純文字公告的時候用
 *
 * 網址在瀏覽器端才組得出來——部署網域跟本機開發不同，寫死一定會錯。
 */

interface CookieQrProps {
  readonly code: string;
}

export function CookieQr({ code }: CookieQrProps) {
  const [svg, setSvg] = useState<string | null>(null);
  const [url, setUrl] = useState("");
  const [copiedUrl, setCopiedUrl] = useState(false);
  const [enlarged, setEnlarged] = useState(false);

  const { pngUrl, copyState, copyImage } = useQrImage(url);

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

  // 放大之後用 Esc 關掉，跟桌卡那邊一致
  useEffect(() => {
    if (!enlarged) {
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setEnlarged(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enlarged]);

  const copyUrl = useCallback(() => {
    void navigator.clipboard?.writeText(url).then(() => {
      setCopiedUrl(true);
      setTimeout(() => setCopiedUrl(false), 2000);
    });
  }, [url]);

  const qr = svg ? (
    <div
      className="[&>svg]:block [&>svg]:size-full"
      // 本機用 qrcode 套件產生的 SVG 字串，不是外部輸入
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  ) : (
    <div className="aspect-square animate-breathe rounded bg-ink-200" />
  );

  const copyLabel = copyState === "copied" ? "已複製圖片" : "複製 QR Code";
  const downloadName = `餅乾上傳-${code}.png`;

  return (
    <>
      <div className="flex flex-wrap items-center gap-5">
        <button
          type="button"
          onClick={() => setEnlarged(true)}
          aria-label="放大這個 QR Code"
          className="w-32 shrink-0 cursor-zoom-in rounded-lg bg-white p-2 transition-transform duration-300 ease-world hover:scale-105"
        >
          {qr}
        </button>

        <div className="min-w-0 flex-1">
          <p className="text-xs text-ink-400">上傳餅乾的網址</p>
          <p className="mt-1 font-mono text-xs break-all text-ink-300">{url}</p>

          <div className="mt-3 flex flex-wrap gap-3">
            <button
              type="button"
              onClick={() => setEnlarged(true)}
              className="rounded-lg bg-signal-500 px-4 py-2 text-xs font-medium text-ink-950 transition-opacity duration-300 ease-world hover:opacity-90"
            >
              放大
            </button>
            <button
              type="button"
              onClick={copyImage}
              disabled={pngUrl === null}
              className="rounded-lg border border-ink-700 px-4 py-2 text-xs text-ink-200 transition-colors duration-300 ease-world hover:bg-ink-800 disabled:opacity-40"
            >
              {copyLabel}
            </button>
            {pngUrl ? (
              <a
                href={pngUrl}
                download={downloadName}
                className="rounded-lg border border-ink-700 px-4 py-2 text-xs text-ink-200 transition-colors duration-300 ease-world hover:bg-ink-800"
              >
                下載 PNG
              </a>
            ) : null}
            <button
              type="button"
              onClick={copyUrl}
              className="rounded-lg border border-ink-700 px-4 py-2 text-xs text-ink-200 transition-colors duration-300 ease-world hover:bg-ink-800"
            >
              {copiedUrl ? "已複製" : "複製網址"}
            </button>
          </div>

          {copyState === "failed" ? (
            <p className="mt-3 text-xs leading-relaxed text-alert-500">
              這個瀏覽器不讓網頁把圖片放進剪貼簿（或目前不是 https）。
              請改用「下載 PNG」，再把檔案貼出去。
            </p>
          ) : (
            <p className="mt-3 text-xs leading-relaxed text-ink-500">
              點圖或按「放大」可以投影出來讓大家直接掃。
              要發到群組就用「複製 QR Code」，剪貼簿裡是一張圖，
              直接貼進 LINE 或簡報就好。
            </p>
          )}
        </div>
      </div>

      {enlarged ? (
        <div className="qr-sheet fixed inset-0 z-50 flex flex-col items-center justify-center overflow-y-auto bg-ink-950 p-8 print:bg-white">
          {/*
            列印時要把底下的後台頁面整個藏掉，否則會多印好幾頁設定畫面。
            用 visibility 而不是 display：display:none 會讓這一層自己也一起
            消失（它是 body 的後代），visibility 才能在子層再打開。
            同時改回 absolute——fixed 在列印時各家瀏覽器的行為不一致。
          */}
          <style>{`
            @media print {
              @page { margin: 12mm; }
              body { visibility: hidden; }
              .qr-sheet, .qr-sheet * { visibility: visible; }
              .qr-sheet { position: absolute; inset: 0; }
              .no-print { display: none !important; }
            }
          `}</style>

          {/*
            放大的尺寸用 min(70vh, 70vw)：投影幕多半是橫的，
            只看寬度會超出下緣，只看高度則在窄視窗會被裁掉。
          */}
          <div
            className="rounded-3xl bg-white p-6"
            style={{ width: "min(70vh, 70vw)" }}
          >
            {qr}
          </div>

          <p className="mt-8 text-2xl font-light text-ink-100 print:text-black">
            掃我，上傳你的餅乾
          </p>
          <p className="mt-3 font-mono text-sm break-all text-ink-400 print:text-neutral-600">
            {url}
          </p>

          <div className="no-print mt-10 flex flex-wrap justify-center gap-3">
            <button
              type="button"
              onClick={copyImage}
              disabled={pngUrl === null}
              className="rounded-lg border border-ink-700 px-5 py-2.5 text-xs text-ink-300 transition-colors duration-300 ease-world hover:bg-ink-800 disabled:opacity-40"
            >
              {copyLabel}
            </button>
            {pngUrl ? (
              <a
                href={pngUrl}
                download={downloadName}
                className="rounded-lg border border-ink-700 px-5 py-2.5 text-xs text-ink-300 transition-colors duration-300 ease-world hover:bg-ink-800"
              >
                下載 PNG
              </a>
            ) : null}
            <button
              type="button"
              onClick={() => window.print()}
              className="rounded-lg border border-ink-700 px-5 py-2.5 text-xs text-ink-300 transition-colors duration-300 ease-world hover:bg-ink-800"
            >
              列印
            </button>
            <button
              type="button"
              onClick={() => setEnlarged(false)}
              className="rounded-lg border border-ink-700 px-5 py-2.5 text-xs text-ink-300 transition-colors duration-300 ease-world hover:bg-ink-800"
            >
              關閉（Esc）
            </button>
          </div>
        </div>
      ) : null}
    </>
  );
}
