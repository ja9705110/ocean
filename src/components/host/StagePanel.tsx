"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchCheckinSettings, updateEventSettings } from "@/lib/host/api";
import type { HostEvent } from "@/lib/host/api";
import {
  DEFAULT_STAGE_CONFIG,
  EMPTY_POSTER,
  MAX_FLOW_SPEED,
  MIN_FLOW_SPEED,
} from "@/lib/stageConfig";
import type { StageConfig, StagePoster } from "@/lib/stageConfig";
import { WORLD_TEMPLATE_OPTIONS } from "@/lib/worldOptions";

/**
 * 大螢幕：世界、流速、主視覺文字。
 *
 * 流速與文字改了之後大螢幕八秒內自己套用，不必重開投影。
 * 世界模板則要重新整理大螢幕（背景是啟動時一次建好的）。
 */

const FIELD =
  "mt-2 w-full rounded-lg border border-ink-700 bg-ink-950 px-4 py-2.5 text-sm text-ink-100 outline-none transition-colors duration-300 ease-world placeholder:text-ink-600 focus:border-signal-500";

/** 每一欄的標籤與提示。順序就是大螢幕上由上而下的順序。 */
const POSTER_FIELDS: readonly {
  readonly key: keyof StagePoster;
  readonly label: string;
  readonly placeholder: string;
}[] = [
  { key: "eyebrow", label: "上方小字", placeholder: "台中市社工師公會 25週年會員齊聚" },
  { key: "title", label: "主標", placeholder: "流嚮" },
  { key: "titleEn", label: "外文標（用 / 分行）", placeholder: "FLOW / TOGETHER" },
  { key: "tagline", label: "標語", placeholder: "每一條河，都有自己的方向" },
  { key: "venue", label: "場地", placeholder: "朝暮良辰婚宴會館 玉宴廳" },
  { key: "dateText", label: "日期時間", placeholder: "115.09.19 SAT. 11:30 － 14:30" },
  { key: "keywords", label: "關鍵字列", placeholder: "流動 × 連結 × 承載 × 匯聚" },
  { key: "footer", label: "落款", placeholder: "匯聚同行・流嚮未來" },
];

/**
 * 一鍵帶入的範例文字。
 *
 * 每一欄的 placeholder 已經寫著該填什麼，但在活動前一天要主持人
 * 一格一格打八行字仍然是負擔。帶進來之後再改比從空白開始快得多。
 */
const SAMPLE_POSTER: StagePoster = {
  eyebrow: "台中市社工師公會\n25週年會員齊聚",
  title: "流嚮",
  titleEn: "FLOW / TOGETHER",
  tagline: "每一條河，\n都有自己的方向",
  venue: "朝暮良辰婚宴會館\n玉宴廳",
  dateText: "115.09.19 SAT. 11:30 － 14:30",
  keywords: "流動 × 連結 × 承載 × 匯聚",
  footer: "匯聚同行・流嚮未來",
};

/** 這幾欄在海報上是兩行的，用多行輸入 */
const MULTILINE = new Set<keyof StagePoster>(["eyebrow", "tagline", "venue"]);

interface StagePanelProps {
  readonly event: HostEvent;
  readonly onChanged: () => void;
}

export function StagePanel({ event, onChanged }: StagePanelProps) {
  const [config, setConfig] = useState<StageConfig>(DEFAULT_STAGE_CONFIG);
  const [worldTemplate, setWorldTemplate] = useState(event.worldTemplate);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      const settings = await fetchCheckinSettings(event.id);
      if (!cancelled) {
        setConfig(settings.stageConfig);
        setLoaded(true);
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [event.id]);

  const run = useCallback(
    async (action: () => Promise<string>) => {
      setBusy(true);
      setError(null);
      setNotice(null);
      try {
        setNotice(await action());
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
    [],
  );

  const save = useCallback(
    (next: StageConfig, message: string) => {
      setConfig(next);
      void run(async () => {
        await updateEventSettings(event.id, { stageConfig: next });
        onChanged();
        return message;
      });
    },
    [event.id, onChanged, run],
  );

  const changeTemplate = useCallback(
    (key: string) => {
      void run(async () => {
        await updateEventSettings(event.id, { worldTemplate: key });
        setWorldTemplate(key);
        onChanged();
        return "已更新。大螢幕請重新整理一次。";
      });
    },
    [event.id, onChanged, run],
  );

  const setPosterField = useCallback(
    (key: keyof StagePoster, value: string) => {
      setConfig((prev) => ({
        ...prev,
        poster: { ...prev.poster, [key]: value },
      }));
    },
    [],
  );

  if (!loaded) {
    return (
      <section className="rounded-lg border border-ink-800 bg-ink-900/50 p-7">
        <p className="text-sm text-ink-500">正在讀取大螢幕設定…</p>
      </section>
    );
  }

  return (
    <section className="space-y-8">
      <div className="rounded-lg border border-ink-800 bg-ink-900/50 p-7">
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm text-ink-300">世界與流速</h2>
          {notice ? (
            <span className="text-xs text-signal-400">{notice}</span>
          ) : null}
        </div>

        <div className="mt-6">
          <label htmlFor="stage-template" className="block text-sm text-ink-300">
            世界
          </label>
          <select
            id="stage-template"
            value={worldTemplate}
            disabled={busy}
            onChange={(e) => changeTemplate(e.target.value)}
            className={FIELD}
          >
            {WORLD_TEMPLATE_OPTIONS.map((template) => (
              <option key={template.key} value={template.key}>
                {template.name}
              </option>
            ))}
          </select>
          <p className="mt-2 text-xs leading-relaxed text-ink-500">
            {WORLD_TEMPLATE_OPTIONS.find((t) => t.key === worldTemplate)?.hint ??
              "未知的世界，大螢幕會退回海洋。"}
            <br />
            換世界之後大螢幕要重新整理一次才會生效。
          </p>
        </div>

        <div className="mt-8">
          <div className="flex items-baseline justify-between">
            <label htmlFor="stage-speed" className="text-sm text-ink-300">
              流速
            </label>
            <span className="font-mono text-sm text-signal-400 tabular-nums">
              {config.flowSpeed.toFixed(2)} 倍
            </span>
          </div>
          <input
            id="stage-speed"
            type="range"
            min={MIN_FLOW_SPEED}
            max={MAX_FLOW_SPEED}
            step={0.05}
            value={config.flowSpeed}
            // 拖曳中只更新畫面，放開才寫回：拖一次會經過幾十個值，
            // 每一個都送出去等於對資料庫打幾十次
            onChange={(e) =>
              setConfig((prev) => ({
                ...prev,
                flowSpeed: Number(e.target.value),
              }))
            }
            onPointerUp={() => save(config, "流速已更新，大螢幕幾秒內套用")}
            onKeyUp={() => save(config, "流速已更新，大螢幕幾秒內套用")}
            className="mt-3 w-full accent-signal-500"
            disabled={busy}
          />
          <div className="mt-2 flex justify-between text-xs text-ink-600">
            <span>慢（看得清楚每個名字）</span>
            <span>快（畫面更有動感）</span>
          </div>
          <p className="mt-3 text-xs leading-relaxed text-ink-500">
            改完不用重開大螢幕，它八秒內會自己套用。
          </p>
        </div>
      </div>

      <div className="rounded-lg border border-ink-800 bg-ink-900/50 p-7">
        <h2 className="text-sm text-ink-300">大螢幕上的主視覺文字</h2>
        <p className="mt-3 text-xs leading-relaxed text-ink-500">
          這幾行會固定顯示在大螢幕左側，像海報一樣不動；
          河道與大家的簽名在後面繼續流。留空的行不會顯示。
        </p>

        <div className="mt-6 space-y-4">
          {POSTER_FIELDS.map((field) => (
            <div key={field.key}>
              <label
                htmlFor={`poster-${field.key}`}
                className="block text-xs text-ink-400"
              >
                {field.label}
              </label>
              {MULTILINE.has(field.key) ? (
                // 這幾行在海報上本來就是兩行，要讓主持人打得出換行
                <textarea
                  id={`poster-${field.key}`}
                  value={config.poster[field.key]}
                  onChange={(e) => setPosterField(field.key, e.target.value)}
                  placeholder={field.placeholder}
                  rows={2}
                  className={FIELD}
                />
              ) : (
                <input
                  id={`poster-${field.key}`}
                  value={config.poster[field.key]}
                  onChange={(e) => setPosterField(field.key, e.target.value)}
                  placeholder={field.placeholder}
                  className={FIELD}
                />
              )}
            </div>
          ))}
        </div>

        <div className="mt-6 flex flex-wrap gap-3">
          <button
            type="button"
            disabled={busy}
            onClick={() => save(config, "主視覺文字已更新")}
            className="rounded-lg bg-signal-500 px-5 py-2.5 text-sm font-medium text-ink-950 disabled:opacity-30"
          >
            儲存文字
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              setConfig((prev) => ({ ...prev, poster: SAMPLE_POSTER }))
            }
            className="rounded-lg border border-ink-700 px-5 py-2.5 text-sm text-ink-200 disabled:opacity-50"
          >
            帶入範例文字
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              save(
                { ...config, poster: EMPTY_POSTER },
                "已清空，大螢幕上不再顯示這一塊",
              )
            }
            className="px-4 py-2.5 text-sm text-ink-500 disabled:opacity-50"
          >
            全部清空
          </button>
        </div>

        {error ? (
          <p className="mt-5 text-xs leading-relaxed text-alert-500">{error}</p>
        ) : null}
      </div>
    </section>
  );
}
