"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { SignaturePad } from "@/components/checkin/SignaturePad";
import type { SignaturePadHandle } from "@/components/checkin/SignaturePad";
import {
  getOrCreateDeviceToken,
  loadJoinRecord,
  saveJoinRecord,
} from "@/lib/device";
import { processCharacter } from "@/lib/image/processCharacter";
import { lookupRoster, submitSignature } from "@/lib/checkin/api";
import type { RosterMatch } from "@/lib/checkin/api";
import { characterImageUrl, fetchParticipantCount } from "@/lib/join/api";
import type { PublicEvent } from "@/lib/join/api";

/**
 * 報到流程（C0）：掃 QR Code → 打姓名 → 確認資料 → 簽名 → 匯入河道。
 *
 * 「確認資料」這一步在有名冊與沒名冊時是同一個畫面：
 * 查得到就把服務單位與桌次帶進去讓本人核對，查不到就自己填。
 * 報到台不能因為名冊沒匯入或名字打法不同就把人卡在門口。
 */

type Step =
  | "cover"
  | "picking"
  | "confirm"
  | "sign"
  | "uploading"
  | "done";

const COUNT_POLL_INTERVAL_MS = 5000;

/**
 * 深藍底金字，跟主視覺與大螢幕的河道同一套。
 * 底色刻意不用站台預設的近黑，主視覺是深夜藍的水面。
 */
const SHELL = "bg-[#050c1c]";
const PANEL = "rounded-xl border border-[#1d3a63] bg-[#08152b]";
const FIELD =
  "mt-2 w-full rounded-lg border border-[#1d3a63] bg-[#061020] px-4 py-3 text-base text-[#ffeccb] outline-none transition-colors duration-300 placeholder:text-[#4a6c9a] focus:border-[#f2c063]";
const PRIMARY =
  "w-full rounded-lg bg-[#f2c063] py-3.5 text-base font-medium text-[#08152b] transition-opacity duration-300 disabled:opacity-30";
const GHOST = "w-full py-2.5 text-sm text-[#7fa0c8]";

interface CheckinFlowProps {
  readonly event: PublicEvent;
}

export function CheckinFlow({ event }: CheckinFlowProps) {
  const [step, setStep] = useState<Step>("cover");
  const [name, setName] = useState("");
  const [organization, setOrganization] = useState("");
  const [seatNo, setSeatNo] = useState("");
  const [matches, setMatches] = useState<RosterMatch[]>([]);
  const [rosterId, setRosterId] = useState<string | null>(null);
  const [looking, setLooking] = useState(false);
  const [statusMessage, setStatusMessage] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [strokeCount, setStrokeCount] = useState(0);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [count, setCount] = useState(event.participantCount);
  const [doneName, setDoneName] = useState("");

  const padRef = useRef<SignaturePadHandle>(null);
  const deviceTokenRef = useRef<string>("");

  // 已經報到過就直接跳到完成頁（重整、關掉再掃一次都會走到這裡）
  useEffect(() => {
    let cancelled = false;

    const restore = async () => {
      // 讓狀態更新脫離 effect 的同步階段，避免掛載當下的連鎖重渲染
      await Promise.resolve();
      deviceTokenRef.current = getOrCreateDeviceToken();

      const record = loadJoinRecord(event.id);
      if (record && !cancelled) {
        setDoneName(record.displayName);
        setSeatNo(record.characterName ?? "");
        setPreviewUrl(characterImageUrl(record.imagePath));
        setStep("done");
      }
    };

    void restore();
    return () => {
      cancelled = true;
    };
  }, [event.id]);

  // 完成頁顯示「已經有幾位流進河裡」。刻意用輪詢而不是 Realtime：
  // 兩三百支手機各開一條 WebSocket 會撞上連線上限，輪詢也更耐場館 Wi-Fi
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
    };

    poll();
    const timer = setInterval(poll, COUNT_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [step, event.id]);

  const handleLookup = useCallback(async () => {
    const trimmed = name.trim();
    if (trimmed.length < 1) {
      return;
    }

    setLooking(true);
    setErrorMessage(null);

    try {
      const found = await lookupRoster(event.id, trimmed);
      setMatches(found);

      if (found.length === 0) {
        // 沒有名冊、或名冊上沒有這個名字：自己填，流程一樣走得完
        setRosterId(null);
        setStep("confirm");
        return;
      }

      if (found.length === 1) {
        const only = found[0];
        if (only) {
          setRosterId(only.id);
          setName(only.displayName);
          setOrganization(only.organization ?? "");
          setSeatNo(only.seatNo ?? "");
          setStep("confirm");
          return;
        }
      }

      // 同名同姓：讓本人自己認服務單位
      setStep("picking");
    } catch {
      // 查名冊失敗不該擋住報到，改成自己填
      setRosterId(null);
      setStep("confirm");
    } finally {
      setLooking(false);
    }
  }, [event.id, name]);

  const handlePick = useCallback((match: RosterMatch) => {
    setRosterId(match.id);
    setName(match.displayName);
    setOrganization(match.organization ?? "");
    setSeatNo(match.seatNo ?? "");
    setStep("confirm");
  }, []);

  const handleSubmit = useCallback(async () => {
    const exported = padRef.current?.exportCanvas() ?? null;
    if (!exported) {
      setErrorMessage("還沒有簽名，簽一下再送出。");
      return;
    }

    setStep("uploading");
    setErrorMessage(null);
    setStatusMessage("正在處理簽名");

    const trimmedName = name.trim();
    const trimmedOrg = organization.trim();
    const trimmedSeat = seatNo.trim();

    try {
      const image = await processCharacter(exported);
      setStatusMessage("正在上傳");

      const result = await submitSignature({
        event,
        rosterId,
        displayName: trimmedName,
        organization: trimmedOrg === "" ? null : trimmedOrg,
        seatNo: trimmedSeat === "" ? null : trimmedSeat,
        deviceToken: deviceTokenRef.current,
        image,
        onStatus: setStatusMessage,
      });

      // character_name 這一欄在簽到模式借來存桌次：
      // 完成頁重整之後還要看得到自己坐哪一桌
      saveJoinRecord(event.id, {
        participantId: result.participantId,
        displayName: trimmedName,
        characterName: trimmedSeat === "" ? null : trimmedSeat,
        imagePath: result.imagePath,
      });

      setDoneName(trimmedName);
      setPreviewUrl(characterImageUrl(result.imagePath));
      setStep("done");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setErrorMessage(
        message === "EMPTY_DRAWING"
          ? "簽名是空的，再簽一次。"
          : `送出失敗：${message}`,
      );
      setStep("sign");
    }
  }, [event, name, organization, seatNo, rosterId]);

  // ---- 各步驟畫面 ----

  if (step === "cover") {
    const trimmed = name.trim();
    const valid = trimmed.length >= 1 && trimmed.length <= 30;

    return (
      <main className={`${SHELL} mx-auto flex min-h-dvh max-w-md flex-col justify-center px-8 py-16`}>
        <p className="text-xs tracking-[0.4em] text-[#c8963c] uppercase">
          Check In
        </p>
        <h1 className="mt-4 text-3xl leading-snug font-light text-[#ffeccb]">
          {event.name}
        </h1>
        {event.subtitle ? (
          <p className="mt-3 text-sm text-[#7fa0c8]">{event.subtitle}</p>
        ) : null}

        {event.status === "open" ? (
          <form
            className="mt-14"
            onSubmit={(e) => {
              e.preventDefault();
              if (valid && !looking) {
                void handleLookup();
              }
            }}
          >
            <label htmlFor="checkin-name" className="block text-sm text-[#9fbde0]">
              你的姓名
            </label>
            <input
              id="checkin-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={30}
              autoComplete="name"
              className={FIELD}
              placeholder="請填寫報名時使用的姓名"
            />
            <button type="submit" disabled={!valid || looking} className={`${PRIMARY} mt-6`}>
              {looking ? "查詢中" : "下一步"}
            </button>
            <p className="mt-5 text-xs leading-relaxed text-[#5b7fae]">
              報到後你的簽名會出現在大螢幕上，一起匯入河道。
            </p>
          </form>
        ) : (
          <p className={`${PANEL} mt-14 px-5 py-4 text-sm leading-relaxed text-[#9fbde0]`}>
            {event.status === "finished"
              ? "這場活動已經結束了。"
              : "報到已經結束了。如果你還沒簽到，請找報到台的工作人員。"}
          </p>
        )}
      </main>
    );
  }

  if (step === "picking") {
    return (
      <main className={`${SHELL} mx-auto flex min-h-dvh max-w-md flex-col justify-center px-8 py-16`}>
        <h2 className="text-2xl font-light text-[#ffeccb]">哪一位是你？</h2>
        <p className="mt-3 text-sm text-[#7fa0c8]">
          名冊上有 {matches.length} 位同名的與會者，請認一下服務單位。
        </p>

        <div className="mt-8 space-y-3">
          {matches.map((match) => (
            <button
              key={match.id}
              type="button"
              onClick={() => handlePick(match)}
              className={`${PANEL} w-full px-5 py-4 text-left transition-colors duration-300 hover:border-[#f2c063]`}
            >
              <p className="text-lg font-light text-[#ffeccb]">
                {match.displayName}
                {match.checkedIn ? (
                  <span className="ml-3 text-xs text-[#c8963c]">已報到</span>
                ) : null}
              </p>
              <p className="mt-1 text-sm text-[#9fbde0]">
                {match.organization ?? "未填服務單位"}
                {match.title ? ` ・ ${match.title}` : ""}
              </p>
              {match.seatNo ? (
                <p className="mt-1 text-xs text-[#7fa0c8]">桌次 {match.seatNo}</p>
              ) : null}
            </button>
          ))}
        </div>

        <button
          type="button"
          onClick={() => {
            setRosterId(null);
            setStep("confirm");
          }}
          className={`${GHOST} mt-6`}
        >
          以上都不是，我自己填
        </button>
      </main>
    );
  }

  if (step === "confirm") {
    const valid = name.trim().length >= 1;

    return (
      <main className={`${SHELL} mx-auto flex min-h-dvh max-w-md flex-col justify-center px-8 py-16`}>
        <h2 className="text-2xl font-light text-[#ffeccb]">確認一下你的資料</h2>
        <p className="mt-3 text-sm text-[#7fa0c8]">
          {rosterId
            ? "這是名冊上的資料，有錯可以直接改。"
            : "名冊上沒有查到這個名字，請自己填一下。"}
        </p>

        <form
          className="mt-8 space-y-5"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) {
              setErrorMessage(null);
              setStep("sign");
            }
          }}
        >
          <div>
            <label htmlFor="confirm-name" className="block text-sm text-[#9fbde0]">
              姓名
            </label>
            <input
              id="confirm-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={30}
              className={FIELD}
            />
          </div>

          <div>
            <label htmlFor="confirm-org" className="block text-sm text-[#9fbde0]">
              服務單位
            </label>
            <input
              id="confirm-org"
              value={organization}
              onChange={(e) => setOrganization(e.target.value)}
              maxLength={60}
              className={FIELD}
              placeholder="可留空"
            />
          </div>

          <div>
            <label htmlFor="confirm-seat" className="block text-sm text-[#9fbde0]">
              桌次
            </label>
            <input
              id="confirm-seat"
              value={seatNo}
              onChange={(e) => setSeatNo(e.target.value)}
              maxLength={20}
              className={FIELD}
              placeholder="可留空"
            />
          </div>

          <button type="submit" disabled={!valid} className={PRIMARY}>
            資料沒錯，去簽名
          </button>
        </form>

        <button
          type="button"
          onClick={() => setStep(matches.length > 1 ? "picking" : "cover")}
          className={`${GHOST} mt-3`}
        >
          返回
        </button>
      </main>
    );
  }

  if (step === "sign") {
    return (
      <main className={`${SHELL} mx-auto flex h-dvh max-w-md flex-col justify-center overflow-hidden px-5 pt-5 pb-6`}>
        <div className="flex items-baseline justify-between">
          <p className="text-sm text-[#9fbde0]">
            {name.trim()}，請簽名
          </p>
          <div className="flex items-baseline gap-4">
            <button
              type="button"
              onClick={() => padRef.current?.undo()}
              disabled={strokeCount === 0}
              className="text-xs text-[#7fa0c8] disabled:opacity-40"
            >
              復原
            </button>
            <button
              type="button"
              onClick={() => padRef.current?.clear()}
              disabled={strokeCount === 0}
              className="text-xs text-[#7fa0c8] disabled:opacity-40"
            >
              清空
            </button>
            <button
              type="button"
              onClick={() => setStep("confirm")}
              className="text-xs text-[#4a6c9a]"
            >
              返回
            </button>
          </div>
        </div>

        {/* 上限是刻意的：手機直立時整片填滿會變成一條又高又窄的長條，
            手要伸得很開才簽得完一個名字 */}
        <div className="mt-3 max-h-[480px] min-h-0 w-full flex-1 self-center">
          <SignaturePad ref={padRef} onStrokeCountChange={setStrokeCount} />
        </div>

        <p className="mt-3 text-center text-xs text-[#5b7fae]">
          手機轉橫拿會比較好簽。這個簽名就是大螢幕上會出現的樣子。
        </p>

        {errorMessage ? (
          <p className="mt-2 text-center text-xs text-[#ff9a8a]">{errorMessage}</p>
        ) : null}

        <button
          type="button"
          onClick={() => void handleSubmit()}
          disabled={strokeCount === 0}
          className={`${PRIMARY} mt-3`}
        >
          簽好了，完成報到
        </button>
      </main>
    );
  }

  if (step === "uploading") {
    return (
      <main className={`${SHELL} mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center px-8 py-16 text-center`}>
        <span className="size-2 animate-breathe rounded-full bg-[#f2c063]" />
        <p className="mt-6 text-lg font-light text-[#ffeccb]">
          你的簽名正在流進河裡
        </p>
        <p className="mt-3 min-h-5 text-xs text-[#5b7fae]">{statusMessage}</p>
      </main>
    );
  }

  // done
  return (
    <main className={`${SHELL} mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center px-8 py-16 text-center`}>
      {previewUrl ? (
        <div className={`${PANEL} flex w-full justify-center px-6 py-8`}>
          {/* Storage 上的簽名圖，不經過任何最佳化管線 */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={previewUrl}
            alt="你的簽名"
            className="max-h-40 max-w-full object-contain"
          />
        </div>
      ) : null}

      <h2 className="mt-8 text-2xl font-light text-[#ffeccb]">
        {doneName}，報到完成
      </h2>

      {seatNo ? (
        <p className="mt-6 text-sm text-[#9fbde0]">
          你的桌次
          <span className="mx-3 text-4xl font-light text-[#f2c063]">
            {seatNo}
          </span>
        </p>
      ) : null}

      <p className="mt-8 text-sm text-[#7fa0c8]">
        已經有
        <span className="mx-2 text-2xl font-light text-[#f2c063]">{count}</span>
        位流進河裡
      </p>

      <p className="mt-10 text-xs leading-relaxed text-[#5b7fae]">
        抬頭看看大螢幕，找找你的簽名。
        <br />
        這一頁可以先收進口袋，活動中還會用到。
      </p>
    </main>
  );
}
