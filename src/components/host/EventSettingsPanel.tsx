"use client";

import { useCallback, useRef, useState } from "react";
import { updateEventSettings, uploadEventLogo } from "@/lib/host/api";
import type { HostEvent } from "@/lib/host/api";

/**
 * 活動外觀設定：副標題、Logo、背景音樂。
 * 這些都會出現在大螢幕的待機畫面上。
 */

interface EventSettingsPanelProps {
  readonly event: HostEvent;
  readonly logoUrl: string | null;
  readonly bgmUrl: string | null;
  readonly onChanged: () => void;
}

export function EventSettingsPanel({
  event,
  logoUrl,
  bgmUrl,
  onChanged,
}: EventSettingsPanelProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const run = useCallback(
    async (action: () => Promise<void>) => {
      setBusy(true);
      setError(null);
      setSaved(false);
      try {
        await action();
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
        onChanged();
      } catch (actionError) {
        setError(
          actionError instanceof Error
            ? actionError.message
            : String(actionError),
        );
      } finally {
        setBusy(false);
      }
    },
    [onChanged],
  );

  const pickLogo = useCallback(
    (file: File | undefined) => {
      if (!file) {
        return;
      }
      void run(async () => {
        const url = await uploadEventLogo(event.id, file);
        await updateEventSettings(event.id, { logoUrl: url });
        if (fileRef.current) {
          fileRef.current.value = "";
        }
      });
    },
    [event.id, run],
  );

  return (
    <section className="rounded-lg border border-ink-800 bg-ink-900/50 p-7">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm text-ink-300">大螢幕外觀</h2>
        {saved ? (
          <span className="text-xs text-signal-400">已儲存</span>
        ) : null}
      </div>
      <p className="mt-3 text-xs leading-relaxed text-ink-500">
        這些會顯示在大螢幕的待機畫面上。修改後大螢幕幾秒內自動更新，不用重整。
      </p>

      {error ? (
        <p className="mt-4 text-xs leading-relaxed text-alert-500">{error}</p>
      ) : null}

      {/* 副標題 */}
      <label
        htmlFor="settings-subtitle"
        className="mt-7 block text-xs text-ink-400"
      >
        副標題
      </label>
      <input
        id="settings-subtitle"
        defaultValue={event.subtitle ?? ""}
        maxLength={80}
        disabled={busy}
        placeholder="例如：2026 年度大會"
        onBlur={(e) => {
          const next = e.target.value.trim();
          if (next !== (event.subtitle ?? "")) {
            void run(() =>
              updateEventSettings(event.id, {
                subtitle: next === "" ? null : next,
              }),
            );
          }
        }}
        className="mt-2 w-full rounded-lg border border-ink-700 bg-ink-950 px-4 py-2.5 text-sm text-ink-100 outline-none transition-colors duration-300 ease-world placeholder:text-ink-600 focus:border-signal-500"
      />

      {/* Logo */}
      <p className="mt-6 text-xs text-ink-400">活動 Logo</p>
      <div className="mt-2 flex items-center gap-4">
        <div className="flex h-16 w-32 shrink-0 items-center justify-center rounded-lg border border-ink-800 bg-ink-950">
          {logoUrl ? (
            // 已上傳的 Logo 預覽
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={logoUrl}
              alt="活動 Logo"
              className="max-h-14 max-w-28 object-contain"
            />
          ) : (
            <span className="text-[0.65rem] text-ink-600">尚未上傳</span>
          )}
        </div>

        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/svg+xml"
          className="hidden"
          onChange={(e) => pickLogo(e.target.files?.[0])}
        />
        <button
          type="button"
          disabled={busy}
          onClick={() => fileRef.current?.click()}
          className="rounded-lg border border-ink-700 px-4 py-2 text-xs text-ink-300 transition-colors duration-300 ease-world hover:bg-ink-800 disabled:opacity-40"
        >
          {logoUrl ? "換一張" : "上傳"}
        </button>
        {logoUrl ? (
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void run(() => updateEventSettings(event.id, { logoUrl: null }))
            }
            className="text-xs text-alert-500 underline-offset-4 hover:underline disabled:opacity-40"
          >
            移除
          </button>
        ) : null}
      </div>

      {/* BGM */}
      <label htmlFor="settings-bgm" className="mt-6 block text-xs text-ink-400">
        背景音樂網址
      </label>
      <input
        id="settings-bgm"
        defaultValue={bgmUrl ?? ""}
        disabled={busy}
        placeholder="直接指向 mp3 的網址（可留空）"
        onBlur={(e) => {
          const next = e.target.value.trim();
          if (next !== (bgmUrl ?? "")) {
            void run(() =>
              updateEventSettings(event.id, {
                bgmUrl: next === "" ? null : next,
              }),
            );
          }
        }}
        className="mt-2 w-full rounded-lg border border-ink-700 bg-ink-950 px-4 py-2.5 font-mono text-xs text-ink-100 outline-none transition-colors duration-300 ease-world placeholder:text-ink-600 focus:border-signal-500"
      />
      <p className="mt-2 text-xs leading-relaxed text-ink-500">
        必須是可直接播放的音檔網址（YouTube 連結無法使用）。
        大螢幕上需要按一次播放鍵才會開始，這是瀏覽器的規定，無法自動播放。
      </p>
    </section>
  );
}
