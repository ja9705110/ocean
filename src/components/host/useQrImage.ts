"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { generateQrPngDataUrl } from "@/lib/qrcode";

/**
 * 把畫面上的 QR Code 變成「帶得走的一張圖」。
 *
 * 後台原本只給網址，但要別人自己打字的東西在現場等於沒有——
 * 主持人真正要做的事是把碼貼進 LINE 群組、放進簡報、印出來貼在桌上，
 * 這三件事需要的都是圖片，不是文字。
 *
 * PNG 在網址一確定就先備好，不等到按下去才產。Safari 的剪貼簿只接受
 * 在點擊那一刻同步交出來的內容，晚一步就會被擋掉。
 */

export type QrCopyState = "idle" | "copied" | "failed";

export interface QrImage {
  /** 可以直接掛在 <a download> 上的 data URL。還沒好之前是 null。 */
  readonly pngUrl: string | null;
  readonly copyState: QrCopyState;
  /** 把 QR 當成圖片複製到剪貼簿 */
  readonly copyImage: () => void;
}

export function useQrImage(url: string): QrImage {
  const [pngUrl, setPngUrl] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<QrCopyState>("idle");

  /** 已經轉好的 PNG。按下複製的當下要立刻交得出來，不能再 await。 */
  const blobRef = useRef<Blob | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    if (url === "") {
      return;
    }
    let cancelled = false;

    const build = async () => {
      await Promise.resolve();
      try {
        const dataUrl = await generateQrPngDataUrl(url);
        // data: URL 是本機組出來的，這個 fetch 不會出去網路
        const blob = await (await fetch(dataUrl)).blob();
        if (!cancelled) {
          blobRef.current = blob;
          setPngUrl(dataUrl);
        }
      } catch {
        if (!cancelled) {
          blobRef.current = null;
          setPngUrl(null);
        }
      }
    };

    void build();
    return () => {
      cancelled = true;
    };
  }, [url]);

  const flash = useCallback((next: QrCopyState) => {
    setCopyState(next);
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
    }
    timerRef.current = setTimeout(() => setCopyState("idle"), 2000);
  }, []);

  /**
   * 有兩種擋法：瀏覽器沒有 ClipboardItem（Firefox 舊版），
   * 或是在非安全來源底下（用 http 開的區網位址）。
   * 兩種都落到 failed，畫面上會改叫使用者用下載那條路。
   */
  const copyImage = useCallback(() => {
    const blob = blobRef.current;
    if (!blob || typeof ClipboardItem === "undefined" || !navigator.clipboard) {
      flash("failed");
      return;
    }
    void navigator.clipboard
      .write([new ClipboardItem({ "image/png": blob })])
      .then(() => flash("copied"))
      .catch(() => flash("failed"));
  }, [flash]);

  return { pngUrl, copyState, copyImage };
}
