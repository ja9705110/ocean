"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { DrawingCanvas } from "@/components/draw/DrawingCanvas";
import type { DrawingCanvasHandle } from "@/components/draw/DrawingCanvas";
import { CreaturePicker } from "@/components/join/CreaturePicker";
import { renderCreatureLayer } from "@/lib/creatures/ocean";
import type { OceanCreature } from "@/lib/creatures/ocean";
import {
  getOrCreateDeviceToken,
  loadJoinRecord,
  saveJoinRecord,
} from "@/lib/device";
import { processCharacter } from "@/lib/image/processCharacter";
import { preparePhotoLayer } from "@/lib/image/preparePhoto";
import {
  characterImageUrl,
  fetchMyParticipant,
  fetchMyWin,
  fetchParticipantCount,
  submitParticipant,
} from "@/lib/join/api";
import type { MyWin, PublicEvent } from "@/lib/join/api";

/**
 * 參與者端流程（規格第 12 節）：
 * 封面＋姓名 → 畫角色 → 命名（可跳過）→ 上傳 → 完成頁。
 *
 * 進入時若 localStorage 已有本活動的報名紀錄，直接跳到完成頁；
 * 沒有紀錄時再以 device_token 問一次後端（換手機瀏覽器重開的情況）。
 */

type Step =
  | "cover"
  | "creature"
  | "draw"
  | "christen"
  | "uploading"
  | "done";

/** 生物範本圖層的解析度：夠大以免在高 DPI 手機上糊掉 */
const CREATURE_LAYER_SIZE = 768;

const COUNT_POLL_INTERVAL_MS = 4000;

interface JoinFlowProps {
  readonly event: PublicEvent;
}

export function JoinFlow({ event }: JoinFlowProps) {
  const [step, setStep] = useState<Step>("cover");
  const [displayName, setDisplayName] = useState("");
  const [characterName, setCharacterName] = useState("");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [count, setCount] = useState(event.participantCount);
  const [restoredName, setRestoredName] = useState<string | null>(null);
  const [participantId, setParticipantId] = useState<string | null>(null);
  const [win, setWin] = useState<MyWin | null>(null);

  const [photoLayer, setPhotoLayer] = useState<HTMLCanvasElement | null>(null);
  const [photoLoading, setPhotoLoading] = useState(false);
  const [creatureLayer, setCreatureLayer] = useState<HTMLCanvasElement | null>(
    null,
  );
  const [creatureName, setCreatureName] = useState<string | null>(null);

  const handleCreaturePick = useCallback(
    (creature: OceanCreature | null, color: string) => {
      setCreatureLayer(
        creature ? renderCreatureLayer(creature, color, CREATURE_LAYER_SIZE) : null,
      );
      setCreatureName(creature?.name ?? null);
      setStep("draw");
    },
    [],
  );

  const canvasRef = useRef<DrawingCanvasHandle>(null);
  const exportedRef = useRef<HTMLCanvasElement | null>(null);
  const deviceTokenRef = useRef<string>("");
  const photoInputRef = useRef<HTMLInputElement>(null);

  const handlePhotoChosen = useCallback(async (file: File | undefined) => {
    if (!file) {
      return;
    }

    setPhotoLoading(true);
    setErrorMessage(null);
    try {
      const layer = await preparePhotoLayer(file);
      setPhotoLayer(layer);
    } catch {
      setErrorMessage("這張照片打不開，換一張試試。");
    } finally {
      setPhotoLoading(false);
      // 清空 input 值，同一張照片可以再選一次
      if (photoInputRef.current) {
        photoInputRef.current.value = "";
      }
    }
  }, []);

  // 還原已報名狀態
  useEffect(() => {
    let cancelled = false;

    const restore = async () => {
      // 讓狀態更新脫離 effect 的同步階段，避免掛載當下的連鎖重渲染
      await Promise.resolve();

      deviceTokenRef.current = getOrCreateDeviceToken();

      const record = loadJoinRecord(event.id);
      if (record) {
        if (!cancelled) {
          setRestoredName(record.displayName);
          setParticipantId(record.participantId);
          setPreviewUrl(characterImageUrl(record.imagePath));
          setStep("done");
        }
        return;
      }

      // localStorage 沒有紀錄仍可能已報名（例如清過站台資料），問一次後端；
      // 失敗就當作未報名，讓使用者正常走流程，送出時的冪等機制會接住
      try {
        const existing = await fetchMyParticipant(
          event.id,
          deviceTokenRef.current,
        );

        if (existing && !cancelled) {
          saveJoinRecord(event.id, {
            participantId: existing.id,
            displayName: existing.display_name,
            characterName: existing.character_name,
            imagePath: existing.image_path,
          });
          setRestoredName(existing.display_name);
          setParticipantId(existing.id);
          setPreviewUrl(characterImageUrl(existing.image_path));
          setStep("done");
        }
      } catch {
        // 查詢失敗視同未報名
      }
    };

    void restore();
    return () => {
      cancelled = true;
    };
  }, [event.id]);

  // 完成頁輪詢世界人數。手機端刻意不開 Realtime：
  // 350 條 WebSocket 會撞上 Supabase 連線上限，輪詢也更耐場館 Wi-Fi 斷線
  useEffect(() => {
    if (step !== "done") {
      return;
    }

    let cancelled = false;

    const poll = () => {
      if (document.visibilityState !== "visible") {
        return;
      }
      fetchParticipantCount(event.id)
        .then((value) => {
          if (!cancelled) {
            setCount(value);
          }
        })
        .catch(() => undefined);

      // 中獎通知也走輪詢：350 支手機各開一條 Realtime 連線會撞上
      // Supabase 的並發上限，而且輪詢更耐場館 Wi-Fi 斷線
      if (participantId) {
        fetchMyWin(event.id, participantId)
          .then((value) => {
            if (!cancelled && value) {
              setWin(value);
            }
          })
          .catch(() => undefined);
      }
    };

    poll();
    const timer = setInterval(poll, COUNT_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [step, event.id, participantId]);

  const handleFinishDrawing = useCallback(() => {
    const exported = canvasRef.current?.exportCanvas() ?? null;

    if (!exported) {
      setErrorMessage("先畫點什麼吧，一筆也好。");
      return;
    }

    // 命名步驟預設帶入生物名稱，參與者可以直接沿用或改掉
    if (creatureName && characterName.trim() === "") {
      setCharacterName(creatureName);
    }

    exportedRef.current = exported;
    setPreviewUrl(exported.toDataURL());
    setErrorMessage(null);
    setStep("christen");
  }, [creatureName, characterName]);

  const handleSubmit = useCallback(async () => {
    const exported = exportedRef.current;
    if (!exported) {
      setStep("draw");
      return;
    }

    setStep("uploading");
    setErrorMessage(null);
    setStatusMessage("正在處理圖片");

    try {
      const image = await processCharacter(exported);
      setStatusMessage("正在上傳");

      const trimmedCharacterName = characterName.trim();
      const result = await submitParticipant({
        event,
        displayName: displayName.trim(),
        characterName: trimmedCharacterName === "" ? null : trimmedCharacterName,
        deviceToken: deviceTokenRef.current,
        image,
        onStatus: setStatusMessage,
      });

      saveJoinRecord(event.id, {
        participantId: result.participantId,
        displayName: displayName.trim(),
        characterName: trimmedCharacterName === "" ? null : trimmedCharacterName,
        imagePath: result.imagePath,
      });

      setParticipantId(result.participantId);
      setStep("done");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setErrorMessage(
        message === "EMPTY_DRAWING"
          ? "畫布是空的，回上一步畫點什麼吧。"
          : `送出失敗：${message}`,
      );
      setStep("christen");
    }
  }, [event, displayName, characterName]);

  // ---- 各步驟畫面 ----

  if (step === "cover") {
    const trimmed = displayName.trim();
    const valid = trimmed.length >= 1 && trimmed.length <= 30;

    return (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-8 py-16">
        <p className="text-xs tracking-[0.3em] text-ink-500 uppercase">
          {event.code}
        </p>
        <h1 className="mt-4 text-3xl leading-snug font-light text-ink-100">
          {event.name}
        </h1>
        {event.subtitle ? (
          <p className="mt-3 text-sm text-ink-400">{event.subtitle}</p>
        ) : null}

        {event.status === "open" ? (
          <form
            className="mt-14"
            onSubmit={(e) => {
              e.preventDefault();
              if (valid) {
                setStep("creature");
              }
            }}
          >
            <label
              htmlFor="display-name"
              className="block text-sm text-ink-300"
            >
              你的姓名
            </label>
            <input
              id="display-name"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              maxLength={30}
              autoComplete="name"
              className="mt-3 w-full rounded-lg border border-ink-700 bg-ink-900 px-4 py-3 text-base text-ink-100 outline-none transition-colors duration-300 ease-world placeholder:text-ink-600 focus:border-signal-500"
              placeholder="讓大家認得你"
            />
            <button
              type="submit"
              disabled={!valid}
              className="mt-6 w-full rounded-lg bg-signal-500 py-3.5 text-base font-medium text-ink-950 transition-opacity duration-300 ease-world disabled:opacity-30"
            >
              開始畫我的角色
            </button>
          </form>
        ) : (
          <p className="mt-14 rounded-lg border border-ink-700 bg-ink-900 px-5 py-4 text-sm leading-relaxed text-ink-300">
            {event.status === "finished"
              ? "這場活動已經結束了。"
              : "報名已截止。如果你已經送出過角色，抽獎時請看大螢幕。"}
          </p>
        )}
      </main>
    );
  }

  if (step === "creature") {
    return (
      <CreaturePicker
        displayName={displayName.trim()}
        onPick={handleCreaturePick}
        onBack={() => setStep("cover")}
      />
    );
  }

  if (step === "draw") {
    return (
      <main className="mx-auto flex h-dvh max-w-md flex-col overflow-hidden px-4 pt-4 pb-5">
        <div className="mb-3 flex items-baseline justify-between px-1">
          <p className="text-sm text-ink-300">
            {creatureName
              ? `你的${creatureName}，加點什麼吧`
              : `${displayName.trim()}，畫出你的角色`}
          </p>
          <div className="flex items-baseline gap-4">
            <input
              ref={photoInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => void handlePhotoChosen(e.target.files?.[0])}
            />
            <button
              type="button"
              disabled={photoLoading}
              onClick={() =>
                photoLayer ? setPhotoLayer(null) : photoInputRef.current?.click()
              }
              className="text-xs text-signal-400 disabled:opacity-50"
            >
              {photoLoading
                ? "照片處理中"
                : photoLayer
                  ? "移除照片"
                  : "加一張照片"}
            </button>
            <button
              type="button"
              onClick={() => setStep("creature")}
              className="text-xs text-ink-600"
            >
              返回
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1">
          <DrawingCanvas
            ref={canvasRef}
            photo={photoLayer}
            creature={creatureLayer}
          />
        </div>

        {errorMessage ? (
          <p className="mt-3 px-1 text-xs text-alert-500">{errorMessage}</p>
        ) : null}

        <button
          type="button"
          onClick={handleFinishDrawing}
          className="mt-4 w-full rounded-lg bg-signal-500 py-3.5 text-base font-medium text-ink-950"
        >
          畫好了
        </button>
      </main>
    );
  }

  if (step === "christen") {
    return (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-8 py-16">
        <h2 className="text-2xl font-light text-ink-100">幫你的角色取個名字</h2>
        <p className="mt-2 text-sm text-ink-500">可以跳過，之後也認得出你。</p>

        {previewUrl ? (
          <div className="mt-8 flex justify-center rounded-lg bg-ink-800 p-6">
            {/* 匯出畫布的 data URL 預覽，不經過任何最佳化管線 */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={previewUrl}
              alt="你畫的角色"
              className="max-h-48 max-w-full object-contain"
            />
          </div>
        ) : null}

        <input
          value={characterName}
          onChange={(e) => setCharacterName(e.target.value)}
          maxLength={30}
          className="mt-8 w-full rounded-lg border border-ink-700 bg-ink-900 px-4 py-3 text-base text-ink-100 outline-none transition-colors duration-300 ease-world placeholder:text-ink-600 focus:border-signal-500"
          placeholder="角色名稱（可留空）"
        />

        {errorMessage ? (
          <p className="mt-4 text-xs leading-relaxed text-alert-500">
            {errorMessage}
          </p>
        ) : null}

        <button
          type="button"
          onClick={() => void handleSubmit()}
          className="mt-6 w-full rounded-lg bg-signal-500 py-3.5 text-base font-medium text-ink-950"
        >
          送進世界
        </button>
        <button
          type="button"
          onClick={() => setStep("draw")}
          className="mt-3 w-full py-2 text-sm text-ink-500"
        >
          回去再改一下
        </button>
      </main>
    );
  }

  if (step === "uploading") {
    return (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center px-8 py-16 text-center">
        <span className="size-2 animate-breathe rounded-full bg-signal-500" />
        <p className="mt-6 text-lg font-light text-ink-100">
          你的角色正在游進世界
        </p>
        <p className="mt-3 min-h-5 text-xs text-ink-500">{statusMessage}</p>
      </main>
    );
  }

  // done
  const shownName = restoredName ?? displayName.trim();

  if (win) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center px-8 py-16 text-center">
        <span className="animate-breathe text-xs tracking-[0.4em] text-signal-400 uppercase">
          Winner
        </span>

        {previewUrl ? (
          <div className="mt-8 flex w-full justify-center rounded-lg bg-ink-800 p-8">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={previewUrl}
              alt="你的角色"
              className="max-h-56 max-w-full object-contain"
            />
          </div>
        ) : null}

        <h2 className="mt-10 text-3xl leading-snug font-light text-ink-100">
          {shownName}
          <br />
          你中獎了
        </h2>

        <p className="mt-6 text-xl font-light text-signal-400">
          {win.prizeName}
        </p>

        <p className="mt-10 text-xs leading-relaxed text-ink-500">
          請到台前領獎。這一頁可以出示給工作人員確認。
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center px-8 py-16 text-center">
      {previewUrl ? (
        <div className="flex w-full justify-center rounded-lg bg-ink-800 p-6">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={previewUrl}
            alt="你的角色"
            className="max-h-52 max-w-full object-contain"
          />
        </div>
      ) : null}

      <h2 className="mt-8 text-2xl font-light text-ink-100">
        {shownName}，你已經在世界裡了
      </h2>

      <p className="mt-6 text-sm text-ink-400">
        世界裡已有
        <span className="mx-2 text-2xl font-light text-signal-400">
          {count}
        </span>
        位
      </p>

      <p className="mt-10 text-xs leading-relaxed text-ink-500">
        抬頭看看大螢幕，找找你的角色。
        <br />
        抽獎開始時結果會出現在大螢幕上，這一頁可以先收進口袋。
      </p>
    </main>
  );
}
