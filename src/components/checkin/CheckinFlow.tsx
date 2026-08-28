"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { SignaturePad } from "@/components/checkin/SignaturePad";
import { SignatureSheet } from "@/components/checkin/SignatureSheet";
import { StencilPicker } from "@/components/checkin/StencilPicker";
import { renderStencilLayer } from "@/lib/creatures/riverStencils";
import type { RiverStencil } from "@/lib/creatures/riverStencils";
import type { SignaturePadHandle } from "@/components/checkin/SignaturePad";
import { DrawingCanvas } from "@/components/draw/DrawingCanvas";
import type { DrawingCanvasHandle } from "@/components/draw/DrawingCanvas";
import {
  getOrCreateDeviceToken,
  loadJoinRecord,
  saveJoinRecord,
} from "@/lib/device";
import { processCharacter } from "@/lib/image/processCharacter";
import {
  findCheckinByName,
  lookupRoster,
  submitSignature,
} from "@/lib/checkin/api";
import type { ExistingCheckin, RosterMatch } from "@/lib/checkin/api";
import { characterImageUrl, fetchParticipantCount } from "@/lib/join/api";
import type { PublicEvent } from "@/lib/join/api";

/**
 * 報到流程（C0／C1）：掃 QR Code → 打姓名 → 確認資料 → 簽名
 * →（主持人要收彩繪時）畫彩繪 → 匯入河道。
 *
 * 「確認資料」這一步在有名冊與沒名冊時是同一個畫面：
 * 查得到就把執業單位與桌次帶進去讓本人核對，查不到就自己填。
 * 報到台不能因為名冊沒匯入或名字打法不同就把人卡在門口。
 *
 * 彩繪是可以晚一點再畫的。報到台前面排著隊，沒有人有時間當場塗鴉；
 * 所以簽完名就先放行，完成頁再留一個入口讓他們入座後慢慢畫。
 */

type Step =
  | "cover"
  | "already"
  | "picking"
  | "confirm"
  | "sign"
  | "stencil"
  | "artwork"
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
  const [signaturePreviewUrl, setSignaturePreviewUrl] = useState<string | null>(
    null,
  );
  const [hasArtwork, setHasArtwork] = useState(false);
  /** 送出過幾次彩繪。到 2 就沒有重畫的機會了。 */
  const [artworkCount, setArtworkCount] = useState(0);
  const [count, setCount] = useState(event.participantCount);
  const [doneName, setDoneName] = useState("");
  /** 橫向簽名的全螢幕板子是不是開著 */
  const [landscape, setLandscape] = useState(false);
  /**
   * 橫向簽好之後先收在這裡的預覽圖。
   *
   * 有值就代表簽名已經拿到手了，直立那一頁改成顯示這張圖而不是空白板子——
   * 使用者剛簽完，要看到的是自己的字，不是一塊又要重簽的板子。
   */
  const [pendingSignature, setPendingSignature] = useState<string | null>(null);
  /** 這個名字在後端已經有的報到紀錄，要讓本人自己認 */
  const [existing, setExisting] = useState<ExistingCheckin[]>([]);
  /** 重畫前的確認框是不是開著 */
  const [confirmRedraw, setConfirmRedraw] = useState(false);
  /** 選好的線稿。null 代表空白畫布（自己畫）。 */
  const [stencil, setStencil] = useState<RiverStencil | null>(null);
  /** 線稿圖層。畫布只吃畫好的 canvas，所以在這裡先畫一次。 */
  const [stencilLayer, setStencilLayer] = useState<HTMLCanvasElement | null>(
    null,
  );

  const padRef = useRef<SignaturePadHandle>(null);
  const drawRef = useRef<DrawingCanvasHandle>(null);
  /** 簽好的那張畫布。進到彩繪那一步之後簽名板已經卸載，要先收起來 */
  const signedRef = useRef<HTMLCanvasElement | null>(null);
  const deviceTokenRef = useRef<string>("");

  /** 主持人的大螢幕設定決定要不要請大家畫彩繪 */
  const wantsArtwork = event.stageDisplay !== "signature";

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
        // 姓名也要還原：之後回來補彩繪時會再送一次，
        // 空字串會被後端當成沒填而擋下（BAD_NAME）
        setName(record.displayName);
        setSeatNo(record.characterName ?? "");
        setPreviewUrl(characterImageUrl(record.imagePath));
        setSignaturePreviewUrl(
          record.signaturePath
            ? characterImageUrl(record.signaturePath)
            : null,
        );
        setHasArtwork(record.hasArtwork === true);
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

  /** 查名冊，決定下一步是自己填還是先認人。不含重複報到的檢查。 */
  const goToRoster = useCallback(async () => {
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

      // 同名同姓：讓本人自己認執業單位
      setStep("picking");
    } catch {
      // 查名冊失敗不該擋住報到，改成自己填
      setRosterId(null);
      setStep("confirm");
    } finally {
      setLooking(false);
    }
  }, [event.id, name]);

  const handleLookup = useCallback(async () => {
    const trimmed = name.trim();
    if (trimmed.length < 1) {
      return;
    }

    setLooking(true);
    /*
      先問後端這個名字報到過了沒（C18）。

      瀏覽器裡的紀錄只認得同一支手機。手機換了、用無痕開、清了資料、
      或報到台先用平板代簽過一次，本人再掃就會被簽進去第二次——
      大螢幕上出現兩個一樣的名字，抽獎名單裡也多一份。

      查失敗不擋人。報到台前面排著隊，因為一次查詢逾時就把人卡在門口，
      比多一筆重複糟得多，所以這裡吞掉錯誤直接往下走。
    */
    const already = await findCheckinByName(event.id, trimmed).catch(
      () => [] as ExistingCheckin[],
    );
    setLooking(false);

    if (already.length > 0) {
      setExisting(already);
      setStep("already");
      return;
    }

    await goToRoster();
  }, [event.id, name, goToRoster]);

  const handlePick = useCallback((match: RosterMatch) => {
    setRosterId(match.id);
    setName(match.displayName);
    setOrganization(match.organization ?? "");
    setSeatNo(match.seatNo ?? "");
    setStep("confirm");
  }, []);

  /**
   * 送出。簽名與彩繪任一張有東西就送得出去——
   * 第一次送簽名，之後回頭補彩繪都走這一支。
   */
  const handleSubmit = useCallback(
    async (options: { readonly withArtwork: boolean }) => {
      const signatureCanvas = signedRef.current;
      const artworkCanvas = options.withArtwork
        ? (drawRef.current?.exportCanvas() ?? null)
        : null;

      if (signatureCanvas === null && artworkCanvas === null) {
        setErrorMessage("還沒有簽名，簽一下再送出。");
        return;
      }
      if (options.withArtwork && artworkCanvas === null) {
        setErrorMessage("先畫點什麼吧，一筆也好。");
        return;
      }

      const backStep: Step = options.withArtwork ? "artwork" : "sign";

      setStep("uploading");
      setErrorMessage(null);
      setStatusMessage("正在處理圖片");

      const trimmedName = name.trim();
      const trimmedOrg = organization.trim();
      const trimmedSeat = seatNo.trim();

      try {
        const signature =
          signatureCanvas === null
            ? null
            : await processCharacter(signatureCanvas);
        const artwork =
          artworkCanvas === null ? null : await processCharacter(artworkCanvas);

        setStatusMessage("正在上傳");

        const result = await submitSignature({
          event,
          rosterId,
          displayName: trimmedName,
          organization: trimmedOrg === "" ? null : trimmedOrg,
          seatNo: trimmedSeat === "" ? null : trimmedSeat,
          deviceToken: deviceTokenRef.current,
          signature,
          artwork,
          // 只在真的送彩繪時記線稿，補簽名時不要把它清掉
          stencil: artwork === null ? null : (stencil?.key ?? null),
          onStatus: setStatusMessage,
        });

        // character_name 這一欄在簽到模式借來存桌次：
        // 完成頁重整之後還要看得到自己坐哪一桌
        saveJoinRecord(event.id, {
          participantId: result.participantId,
          displayName: trimmedName,
          characterName: trimmedSeat === "" ? null : trimmedSeat,
          imagePath: result.imagePath,
          signaturePath: result.signaturePath,
          // image_path 與 signature_path 不同，表示彩繪真的存在
          hasArtwork:
            result.signaturePath === null ||
            result.imagePath !== result.signaturePath,
        });

        setDoneName(trimmedName);
        setArtworkCount(result.artworkCount);
        setHasArtwork(
          result.signaturePath === null ||
            result.imagePath !== result.signaturePath,
        );
        setPreviewUrl(characterImageUrl(result.imagePath));
        setSignaturePreviewUrl(
          result.signaturePath === null
            ? null
            : characterImageUrl(result.signaturePath),
        );
        setStep("done");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setErrorMessage(
          message === "EMPTY_DRAWING"
            ? "圖是空的，再畫一次。"
            : `送出失敗：${message}`,
        );
        setStep(backStep);
      }
    },
    [event, name, organization, seatNo, rosterId, stencil],
  );

  /**
   * 橫向簽完，收起板子。
   *
   * 這時候就把畫布收下來，因為板子一卸載筆畫就沒了。
   * 轉過來的板子畫出來的方向已經是正的——使用者橫著拿手機看到的上方，
   * 就是畫布的上方——所以直接匯出就是正的，不需要再轉一次。
   */
  const handleLandscapeDone = useCallback(() => {
    const exported = padRef.current?.exportCanvas() ?? null;
    if (!exported) {
      setLandscape(false);
      return;
    }
    signedRef.current = exported;
    setPendingSignature(exported.toDataURL("image/png"));
    setErrorMessage(null);
    setLandscape(false);
  }, []);

  /** 簽名完成：主持人有要收彩繪就往下一步，否則直接送出 */
  const handleSignedDone = useCallback(() => {
    // 橫向簽的那張已經收在 signedRef 裡，直立的板子這時候是空的
    const exported = pendingSignature
      ? signedRef.current
      : (padRef.current?.exportCanvas() ?? null);
    if (!exported) {
      setErrorMessage("還沒有簽名，簽一下再送出。");
      return;
    }
    signedRef.current = exported;
    setErrorMessage(null);

    if (wantsArtwork) {
      setStep("stencil");
      return;
    }
    void handleSubmit({ withArtwork: false });
  }, [wantsArtwork, handleSubmit, pendingSignature]);

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
              報名簽到，請輸入您報名資料的姓名
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

  // 這個名字後端已經有紀錄了（C18）。可能是同名同姓，也可能是本人換了
  // 手機，所以不直接擋，讓本人自己認。
  if (step === "already") {
    const one = existing.length === 1 ? existing[0] : null;

    const enter = (record: ExistingCheckin) => {
      setDoneName(record.displayName);
      setName(record.displayName);
      setOrganization(record.organization ?? "");
      setSeatNo(record.seatNo ?? "");
      setPreviewUrl(characterImageUrl(record.imagePath));
      setSignaturePreviewUrl(
        record.signaturePath ? characterImageUrl(record.signaturePath) : null,
      );
      setHasArtwork(
        record.signaturePath === null || record.imagePath !== record.signaturePath,
      );
      // 這台手機之後重掃就直接回完成頁，不必再查一次
      saveJoinRecord(event.id, {
        participantId: record.id,
        displayName: record.displayName,
        characterName: record.seatNo,
        imagePath: record.imagePath,
        signaturePath: record.signaturePath,
        hasArtwork:
          record.signaturePath === null ||
          record.imagePath !== record.signaturePath,
      });
      setStep("done");
    };

    return (
      <main className={`${SHELL} mx-auto flex min-h-dvh max-w-md flex-col justify-center px-8 py-16`}>
        <h2 className="text-2xl font-light text-[#ffeccb]">
          {one ? "你已經報到過了" : "有幾筆同名的報到紀錄"}
        </h2>
        <p className="mt-3 text-sm leading-relaxed text-[#7fa0c8]">
          {one
            ? "這個名字已經簽過了，不用再簽一次。"
            : "請認一下哪一筆是你。"}
        </p>

        <div className="mt-8 space-y-3">
          {existing.map((record) => (
            <button
              key={record.id}
              type="button"
              onClick={() => enter(record)}
              className={`${PANEL} w-full px-5 py-4 text-left transition-colors duration-300 hover:border-[#f2c063]`}
            >
              <p className="text-lg font-light text-[#ffeccb]">
                {record.displayName}
              </p>
              <p className="mt-1 text-sm text-[#9fbde0]">
                {record.organization ?? "未填執業單位"}
                {record.seatNo ? ` ・ 桌次 ${record.seatNo}` : ""}
              </p>
              <p className="mt-1 text-xs text-[#5b7fae]">
                {new Date(record.joinedAtMs).toLocaleTimeString("zh-TW", {
                  hour: "2-digit",
                  minute: "2-digit",
                })}{" "}
                簽到
              </p>
            </button>
          ))}
        </div>

        {/* 同名同姓在三百人的場子裡是會發生的，一定要留一條路給真的還沒簽的人 */}
        <button
          type="button"
          onClick={() => {
            setExisting([]);
            void goToRoster();
          }}
          className={`${GHOST} mt-6`}
        >
          都不是我，我還沒簽到
        </button>
      </main>
    );
  }

  if (step === "picking") {
    return (
      <main className={`${SHELL} mx-auto flex min-h-dvh max-w-md flex-col justify-center px-8 py-16`}>
        <h2 className="text-2xl font-light text-[#ffeccb]">哪一位是你？</h2>
        <p className="mt-3 text-sm text-[#7fa0c8]">
          名冊上有 {matches.length} 位同名的與會者，請認一下執業單位。
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
                {match.organization ?? "未填執業單位"}
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
              執業單位
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

        {/*
          橫向簽好之後這裡改成顯示那張簽名，不再放一塊空白板子：
          使用者剛簽完，要看到的是自己的字，不是一塊看起來還要再簽一次的板子。
        */}
        {pendingSignature ? (
          <div className="mt-3 flex min-h-0 w-full flex-1 items-center justify-center self-center rounded-xl border border-[#1d3a63] bg-[#061020] p-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={pendingSignature}
              alt="你的簽名"
              className="max-h-full max-w-full object-contain"
            />
          </div>
        ) : landscape ? (
          /*
            橫向板子開著的時候不要同時掛直立的板子。
            兩塊板子共用同一個 padRef，後掛上的會蓋掉前一個，
            而且橫向那塊卸載時會把 ref 清成 null，直立那塊就變成叫不動。
            反正這時候整個畫面都被橫向板子蓋住了，留著也看不到。
          */
          <div className="mt-3 min-h-0 w-full flex-1" />
        ) : (
          /* 上限是刻意的：手機直立時整片填滿會變成一條又高又窄的長條，
             手要伸得很開才簽得完一個名字 */
          <div className="mt-3 max-h-[480px] min-h-0 w-full flex-1 self-center">
            <SignaturePad ref={padRef} onStrokeCountChange={setStrokeCount} />
          </div>
        )}

        {/*
          橫向簽名。直立的板子是一條又高又窄的長條，中文名字橫著寫，
          三個字下來手要一直往右伸，最後一個字通常擠在邊上。
        */}
        <button
          type="button"
          onClick={() => {
            setStrokeCount(0);
            setLandscape(true);
          }}
          className="mt-3 w-full rounded-lg border border-[#2a4a78] py-2.5 text-sm text-[#9fbde0] transition-colors duration-300 hover:border-[#f2c063]"
        >
          {pendingSignature
            ? "重新橫向簽名"
            : strokeCount > 0
              ? "改用橫向重簽（現在這幾筆會清掉）"
              : "點我橫向簽名（手機打橫，比較好寫）"}
        </button>

        <p className="mt-3 text-center text-xs leading-relaxed text-[#5b7fae]">
          可以簽暱稱，不一定要本名。
          <br />
          這個簽名會顯示在大螢幕上。
        </p>

        {errorMessage ? (
          <p className="mt-2 text-center text-xs text-[#ff9a8a]">{errorMessage}</p>
        ) : null}

        <button
          type="button"
          onClick={handleSignedDone}
          disabled={strokeCount === 0 && pendingSignature === null}
          className={`${PRIMARY} mt-3`}
        >
          {wantsArtwork ? "簽好了，下一步畫彩繪" : "簽好了，完成報到"}
        </button>

        {landscape ? (
          <SignatureSheet
            padRef={padRef}
            name={name.trim()}
            strokeCount={strokeCount}
            onStrokeCountChange={setStrokeCount}
            onDone={handleLandscapeDone}
          />
        ) : null}
      </main>
    );
  }

  if (step === "stencil") {
    return (
      <StencilPicker
        onBack={() => setStep(signaturePreviewUrl ? "done" : "sign")}
        onPick={(picked) => {
          setStencil(picked);
          // 線稿在這裡就畫好。畫布只吃畫好的 canvas，而且解析度要夠——
          // 512 是彩繪匯出的邊長，比它小會在畫布上放大成糊的線
          setStencilLayer(
            picked === null
              ? null
              : renderStencilLayer(picked, "#7fa0c8", 512, 1.6),
          );
          setStep("artwork");
        }}
      />
    );
  }

  if (step === "artwork") {
    return (
      <main
        className={`${SHELL} mx-auto flex h-dvh max-w-md flex-col overflow-hidden px-4 pt-4 pb-5`}
      >
        <div className="mb-3 flex items-baseline justify-between px-1">
          <p className="text-sm text-[#9fbde0]">
            {stencil ? `幫這隻${stencil.name}上色` : "畫一張你的彩繪"}
          </p>
          <button
            type="button"
            onClick={() => setStep("stencil")}
            className="text-xs text-[#4a6c9a]"
          >
            換一張
          </button>
        </div>

        <div className="min-h-0 flex-1">
          <DrawingCanvas ref={drawRef} creature={stencilLayer} />
        </div>

        {errorMessage ? (
          <p className="mt-3 px-1 text-xs text-[#ff9a8a]">{errorMessage}</p>
        ) : null}

        <button
          type="button"
          onClick={() => void handleSubmit({ withArtwork: true })}
          className={`${PRIMARY} mt-4`}
        >
          畫好了，送出
        </button>

        {/* 排隊的時候沒有人有心情塗鴉。先放行，入座之後再回來畫。
            signaturePreviewUrl 有值代表已經送出過一次，這次是回頭補彩繪，
            那就沒有「跳過」可言了。 */}
        {signaturePreviewUrl === null ? (
          <button
            type="button"
            onClick={() => void handleSubmit({ withArtwork: false })}
            className={GHOST}
          >
            先跳過，之後再畫
          </button>
        ) : null}
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
        <div className={`${PANEL} flex w-full flex-col items-center gap-4 px-6 py-8`}>
          {/* Storage 上的圖，不經過任何最佳化管線 */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={previewUrl}
            alt={hasArtwork ? "你的彩繪" : "你的簽名"}
            className="max-h-40 max-w-full object-contain"
          />
          {/* 有彩繪時上面那張是彩繪，簽名另外附在下面，跟大螢幕的排法一致 */}
          {hasArtwork && signaturePreviewUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={signaturePreviewUrl}
              alt="你的簽名"
              className="max-h-20 max-w-[80%] object-contain"
            />
          ) : null}
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

      {/*
        重畫只給一次（C21）。第一次是「先交出來」，第二次是「認真畫」。
        不設限的話會有人畫完不滿意就一直重來，每一次都是兩張新圖上傳，
        而大螢幕上那條河會一直在換。次數記在後端，清瀏覽資料不會重置。
      */}
      {wantsArtwork ? (
        artworkCount >= 2 ? (
          <p className={`${PANEL} mt-10 px-5 py-4 text-center text-sm text-[#9fbde0]`}>
            重畫的機會用完了
            <span className="mt-1 block text-xs text-[#5b7fae]">
              一支手機可以重畫一次，你已經用過了。
            </span>
          </p>
        ) : confirmRedraw ? (
          /*
            重畫前先擋一下。

            按到這裡的人已經有一張畫了，而按下去那張就沒了——
            不可逆的事情要在按之前講，不是按完才在完成頁告訴他
            「機會用完了」。用整塊面板而不是瀏覽器的 confirm：
            confirm 在手機上是一行小字，而且有些內建瀏覽器會擋掉。
          */
          <div className={`${PANEL} mt-10 border-[#c8963c] px-5 py-5`}>
            <p className="text-base text-[#ffeccb]">這是最後一次重畫的機會</p>
            <p className="mt-3 text-sm leading-relaxed text-[#9fbde0]">
              一支手機只能重畫一次。按下去之後現在這張畫就會被換掉，
              而且不能再改了，也救不回來。
            </p>
            <p className="mt-3 text-sm leading-relaxed text-[#9fbde0]">
              確定要重畫嗎？
            </p>
            <div className="mt-5 space-y-3">
              <button
                type="button"
                onClick={() => {
                  setErrorMessage(null);
                  setConfirmRedraw(false);
                  setStep("stencil");
                }}
                className={PRIMARY}
              >
                確定，我要重畫
              </button>
              <button
                type="button"
                onClick={() => setConfirmRedraw(false)}
                className={GHOST}
              >
                先不要，保留現在這張
              </button>
            </div>
          </div>
        ) : (
          <>
            <button
              type="button"
              onClick={() => {
                setErrorMessage(null);
                // 已經有畫的人要先確認，第一次畫的人不必被擋
                if (hasArtwork) {
                  setConfirmRedraw(true);
                  return;
                }
                setStep("stencil");
              }}
              className={`${PRIMARY} mt-10`}
            >
              {hasArtwork ? "重畫我的彩繪" : "畫我的彩繪"}
            </button>
            {hasArtwork ? (
              <p className="mt-3 text-center text-xs text-[#5b7fae]">
                只能再重畫這一次，畫好之後就不能再改了。
              </p>
            ) : null}
          </>
        )
      ) : null}

      <p className="mt-10 text-xs leading-relaxed text-[#5b7fae]">
        抬頭看看大螢幕，找找你的簽名。
        <br />
        這一頁可以先收進口袋，活動中還會用到。
      </p>
    </main>
  );
}
