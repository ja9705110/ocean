"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchCheckinSettings,
  updateEventSettings,
  uploadEventAsset,
} from "@/lib/host/api";
import type { HostEvent } from "@/lib/host/api";
import {
  DEFAULT_STAGE_CONFIG,
  EMPTY_POSTER,
  MAX_BACKGROUND_DIM,
  MAX_FLOW_INTENSITY,
  MAX_FLOW_SPEED,
  MIN_FLOW_INTENSITY,
  MIN_FLOW_SPEED,
} from "@/lib/stageConfig";
import type { StageConfig, StagePoster } from "@/lib/stageConfig";
import { WORLD_TEMPLATE_OPTIONS } from "@/lib/worldOptions";
import {
  describeStageImage,
  prepareStageImage,
} from "@/lib/image/prepareStageImage";

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
  const fileRef = useRef<HTMLInputElement>(null);
  const overlayRef = useRef<HTMLInputElement>(null);

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

  const pickBackground = useCallback(
    (file: File | undefined) => {
      if (!file) {
        return;
      }
      void run(async () => {
        // 主視覺這種圖動輒好幾 MB，會撞上 Storage 的單檔上限，
        // 而且大螢幕每次開場都要整張抓下來。先在瀏覽器縮到 2560 寬再上傳；
        // 只改解析度與編碼，構圖與文字位置完全不動。
        const prepared = await prepareStageImage(file);
        const url = await uploadEventAsset(
          event.id,
          prepared.blob,
          "stage-bg",
          prepared.extension,
        );
        const next = { ...config, backgroundUrl: url };
        setConfig(next);
        await updateEventSettings(event.id, { stageConfig: next });
        if (fileRef.current) {
          fileRef.current.value = "";
        }
        onChanged();
        return describeStageImage(prepared);
      });
    },
    [config, event.id, onChanged, run],
  );

  const pickOverlay = useCallback(
    (file: File | undefined) => {
      if (!file) {
        return;
      }
      void run(async () => {
        const prepared = await prepareStageImage(file, { keepAlpha: true });
        const url = await uploadEventAsset(
          event.id,
          prepared.blob,
          "stage-overlay",
          prepared.extension,
        );
        const next = { ...config, overlayUrl: url };
        setConfig(next);
        await updateEventSettings(event.id, { stageConfig: next });
        if (overlayRef.current) {
          overlayRef.current.value = "";
        }
        onChanged();
        return describeStageImage(prepared);
      });
    },
    [config, event.id, onChanged, run],
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

        <div className="mt-8 border-t border-ink-800 pt-6">
          <p className="text-sm text-ink-300">背景圖（可選）</p>
          <p className="mt-2 text-xs leading-relaxed text-ink-500">
            第一張：<strong className="text-ink-300">原尺寸完整版主視覺</strong>。
            河道的位置、寬度、彎曲、支流全部從這張圖量出來，
            所以走向與原圖一致是算出來的，不是描出來的。
            <br />
            這張圖上的文字區會被自動抹平，改由下面那張去背 PNG 供應，
            同一段文字不會出現兩次。
          </p>

          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => pickBackground(e.target.files?.[0])}
          />
          <input
            ref={overlayRef}
            type="file"
            accept="image/png,image/webp"
            className="hidden"
            onChange={(e) => pickOverlay(e.target.files?.[0])}
          />

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button
              type="button"
              disabled={busy}
              onClick={() => fileRef.current?.click()}
              className="rounded-lg border border-ink-700 px-5 py-2.5 text-sm text-ink-200 disabled:opacity-50"
            >
              {config.backgroundUrl ? "換一張背景圖" : "上傳背景圖"}
            </button>
            {config.backgroundUrl ? (
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  save(
                    { ...config, backgroundUrl: "" },
                    "已移除，改回程式繪製的河道",
                  )
                }
                className="px-4 py-2.5 text-sm text-ink-500 disabled:opacity-50"
              >
                移除背景圖
              </button>
            ) : null}
          </div>

          {config.backgroundUrl ? (
            <div className="mt-7 border-t border-ink-800 pt-6">
              <p className="text-sm text-ink-300">去背主視覺 PNG</p>
              <p className="mt-2 text-xs leading-relaxed text-ink-500">
                第二張：<strong className="text-ink-300">透明背景的主視覺</strong>
                （logo、全部文字、主標、日期、右下角的 25）。
                這張圖固定蓋在所有動畫的最上層，以原始座標完整顯示，
                不裁切、不拉伸、不重新排版。
              </p>
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => overlayRef.current?.click()}
                  className="rounded-lg border border-ink-700 px-5 py-2.5 text-sm text-ink-200 disabled:opacity-50"
                >
                  {config.overlayUrl ? "換一張去背 PNG" : "上傳去背 PNG"}
                </button>
                {config.overlayUrl ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => save({ ...config, overlayUrl: "" }, "已移除")}
                    className="px-4 py-2.5 text-sm text-ink-500 disabled:opacity-50"
                  >
                    移除
                  </button>
                ) : (
                  <span className="text-xs text-alert-500">
                    還沒上傳。沒有這張，大螢幕上不會有文字。
                  </span>
                )}
              </div>

              <label className="mt-6 flex items-center gap-3 text-sm text-ink-300">
                <input
                  type="checkbox"
                  checked={config.testMode}
                  disabled={busy}
                  onChange={(e) =>
                    save(
                      { ...config, testMode: e.target.checked },
                      e.target.checked
                        ? "測試版：大螢幕只剩河流與主視覺"
                        : "已恢復完整畫面",
                    )
                  }
                  className="accent-signal-500"
                />
                測試版（只顯示河流與去背主視覺）
              </label>
              <p className="mt-2 text-xs leading-relaxed text-ink-500">
                打開之後 QR Code、人數、主視覺文字與大家的簽名全部不顯示，
                用來單獨確認河道的走向、大小、寬度與位置。確認完記得關掉。
              </p>
            </div>
          ) : null}

          {config.backgroundUrl ? (
            <div className="mt-7 border-t border-ink-800 pt-6">
              <p className="mb-4 text-sm text-ink-300">預覽與微調</p>
              <div className="relative overflow-hidden rounded-lg border border-ink-800">
                {/* 主持人剛上傳的圖，不經過最佳化管線 */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={config.backgroundUrl}
                  alt="背景預覽"
                  className="block max-h-40 w-full object-cover"
                />
                <div
                  className="absolute inset-0 bg-[#02040c]"
                  style={{ opacity: config.backgroundDim }}
                />
              </div>

              <div className="mt-4 flex items-baseline justify-between">
                <label htmlFor="stage-dim" className="text-sm text-ink-300">
                  背景壓暗
                </label>
                <span className="font-mono text-sm text-signal-400 tabular-nums">
                  {Math.round(config.backgroundDim * 100)}%
                </span>
              </div>
              <input
                id="stage-dim"
                type="range"
                min={0}
                max={MAX_BACKGROUND_DIM}
                step={0.05}
                value={config.backgroundDim}
                onChange={(e) =>
                  setConfig((prev) => ({
                    ...prev,
                    backgroundDim: Number(e.target.value),
                  }))
                }
                onPointerUp={() => save(config, "已更新")}
                onKeyUp={() => save(config, "已更新")}
                className="mt-3 w-full accent-signal-500"
                disabled={busy}
              />
              <p className="mt-2 text-xs leading-relaxed text-ink-500">
                壓得越暗，簽名越清楚；壓太少的話主視覺會蓋過名字。
              </p>

              <div className="mt-6 flex items-baseline justify-between">
                <label htmlFor="stage-flow" className="text-sm text-ink-300">
                  河道流光強度
                </label>
                <span className="font-mono text-sm text-signal-400 tabular-nums">
                  {Math.round(config.flowIntensity * 100)}%
                </span>
              </div>
              <input
                id="stage-flow"
                type="range"
                min={MIN_FLOW_INTENSITY}
                max={MAX_FLOW_INTENSITY}
                step={0.01}
                value={config.flowIntensity}
                onChange={(e) =>
                  setConfig((prev) => ({
                    ...prev,
                    flowIntensity: Number(e.target.value),
                  }))
                }
                onPointerUp={() => save(config, "已更新")}
                onKeyUp={() => save(config, "已更新")}
                className="mt-3 w-full accent-signal-500"
                disabled={busy}
              />
              <p className="mt-2 text-xs leading-relaxed text-ink-500">
                只影響河道裡流動的光，底圖本身完全不動。
                範圍刻意收在 25%～45%：再高金色會過曝變白，
                主視覺的燙金質感就沒了。
              </p>

              <label className="mt-6 flex items-center gap-3 text-sm text-ink-300">
                <input
                  type="checkbox"
                  checked={config.flowDebug}
                  disabled={busy}
                  onChange={(e) =>
                    save(
                      { ...config, flowDebug: e.target.checked },
                      e.target.checked
                        ? "大螢幕上會用綠色鋪出流動範圍，確認完記得關掉"
                        : "已關閉檢查模式",
                    )
                  }
                  className="accent-signal-500"
                />
                檢查流動範圍
              </label>
              <p className="mt-2 text-xs leading-relaxed text-ink-500">
                打開之後大螢幕會把「允許流動的區域」鋪成綠色。
                logo、左側文字、主標、日期、右下角的 25
                都不應該被綠色蓋到——那些地方即使是金色也不會跟著閃。
                <br />
                確認完務必關掉，否則正式活動時綠色會留在畫面上。
              </p>
            </div>
          ) : null}
        </div>

        <div className="mt-8 border-t border-ink-800 pt-6">
          <label className="flex items-center gap-3 text-sm text-ink-300">
            <input
              type="checkbox"
              checked={config.showQr}
              disabled={busy}
              onChange={(e) =>
                save(
                  { ...config, showQr: e.target.checked },
                  e.target.checked ? "已顯示 QR Code" : "已隱藏 QR Code",
                )
              }
              className="accent-signal-500"
            />
            顯示右側的 QR Code 與人數
          </label>
          <p className="mt-2 text-xs leading-relaxed text-ink-500">
            報到結束之後關掉，整個畫面就只剩主視覺與流動的簽名。
          </p>
        </div>

        <div className="mt-8 border-t border-ink-800 pt-6">
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
