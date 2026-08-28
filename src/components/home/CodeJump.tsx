"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * 首頁的活動代碼入口（C17）。
 *
 * 每一個實際會用到的畫面都在活動代碼底下：/stage/FLOW01、/join/FLOW01、
 * /cookie/FLOW01。這些路徑主持人記不住，也不該記——
 * 打開首頁、輸入代碼、按要去的地方就好。
 *
 * 代碼一律轉大寫：代碼本身是大寫的，手機鍵盤卻常常給小寫，
 * 為了這個讓人看到「找不到活動」太冤枉。
 */

const TARGETS = [
  {
    key: "stage",
    label: "大螢幕",
    hint: "投影用。簽名河流、餅乾馬賽克都在這裡",
    path: (code: string) => `/stage/${code}`,
  },
  {
    key: "join",
    label: "報到",
    hint: "參與者掃 QR 之後看到的畫面",
    path: (code: string) => `/join/${code}`,
  },
  {
    key: "cookie",
    label: "上傳餅乾",
    hint: "彩繪完拍照上傳",
    path: (code: string) => `/cookie/${code}`,
  },
] as const;

export function CodeJump() {
  const router = useRouter();
  const [code, setCode] = useState("");

  const trimmed = code.trim().toUpperCase();
  const ready = trimmed !== "";

  const go = useCallback(
    (path: (value: string) => string) => {
      if (!ready) {
        return;
      }
      router.push(path(trimmed));
    },
    [ready, router, trimmed],
  );

  return (
    <div>
      <label htmlFor="event-code" className="block text-xs text-ink-400">
        活動代碼
      </label>
      <input
        id="event-code"
        value={code}
        onChange={(e) => setCode(e.target.value)}
        maxLength={12}
        autoCapitalize="characters"
        placeholder="例如 FLOW01"
        className="mt-3 w-full max-w-xs rounded-lg border border-ink-700 bg-ink-950 px-4 py-3 font-mono text-lg tracking-[0.2em] text-ink-100 uppercase outline-none transition-colors duration-300 ease-world placeholder:tracking-normal placeholder:text-ink-600 focus:border-signal-500"
      />

      <div className="mt-6 grid gap-px overflow-hidden rounded-lg bg-ink-800 sm:grid-cols-3">
        {TARGETS.map((target) => (
          <button
            key={target.key}
            type="button"
            disabled={!ready}
            onClick={() => go(target.path)}
            className="bg-ink-950 p-5 text-left transition-colors duration-300 ease-world enabled:hover:bg-ink-900 disabled:opacity-40"
          >
            <span className="block text-base font-light text-ink-200">
              {target.label}
            </span>
            <span className="mt-2 block text-xs leading-relaxed text-ink-500">
              {target.hint}
            </span>
          </button>
        ))}
      </div>

      {ready ? (
        <p className="mt-4 font-mono text-xs text-ink-600">
          /stage/{trimmed} ｜ /join/{trimmed} ｜ /cookie/{trimmed}
        </p>
      ) : (
        <p className="mt-4 text-xs leading-relaxed text-ink-500">
          代碼在主持人控制台的「概覽與 QR Code」那一頁，例如 FLOW01。
        </p>
      )}
    </div>
  );
}
