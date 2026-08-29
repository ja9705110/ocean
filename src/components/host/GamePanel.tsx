"use client";

import { useCallback, useEffect, useState } from "react";
import { TableCards } from "./TableCards";
import { QuizPanel } from "./QuizPanel";
import {
  createGameSession,
  deleteGameSession,
  endRound,
  listGameSessions,
  listTeams,
  renameTeam,
  resetGamePlayers,
  startRound,
  updateSessionConfig,
  updateSessionStatus,
} from "@/lib/game/api";
import { GAME_STATUS_HINT, GAME_STATUS_LABEL } from "@/lib/game/types";
import {
  QUIZ_MODE_HINT,
  QUIZ_MODE_LABEL,
  parsePhoneDisplay,
  parseQuizMode,
} from "@/lib/quiz/types";
import type { QuizMode } from "@/lib/quiz/types";
import { QUIZ_THEMES, quizTheme } from "@/lib/quiz/themes";
import { findCreature } from "@/lib/creatures/ocean";
import { CreatureMark } from "@/components/quiz/CreatureMark";
import { SENSITIVITY_LABEL } from "@/lib/game/motion";
import type { Sensitivity } from "@/lib/game/motion";
import {
  DURATION_OPTIONS,
  parseRescueConfig,
  toConfigPatch,
} from "@/lib/game/rescue";
import type { GameSession, GameSessionStatus, Team } from "@/lib/game/types";

/**
 * 遊戲場次管理（G0）。
 *
 * 建立場次時一次產生所有隊伍與各自的加入碼，
 * 主持人列印桌卡放到桌上，玩家掃自己那張就入座。
 */

const GAMES = [
  { key: "quiz", name: "問答" },
  { key: "ocean-rescue", name: "划船救援" },
] as const;

const STATUS_ACTIONS: Record<
  GameSessionStatus,
  readonly { readonly to: GameSessionStatus; readonly label: string }[]
> = {
  setup: [{ to: "lobby", label: "開放入座" }],
  lobby: [{ to: "setup", label: "暫停入座" }],
  countdown: [{ to: "lobby", label: "回到大廳" }],
  playing: [{ to: "finished", label: "結束遊戲" }],
  finished: [],
};

const POLL_MS = 5000;

/**
 * 按下開始到第 0 拍之間的緩衝（G1）。
 *
 * 這段時間要夠所有手機輪詢到新狀態、對完時、把手擺好並聽完預備拍。
 * 太短會有人還沒握好就開始，太長則現場會冷掉。
 */
const LEAD_IN_MS = 7000;

interface GamePanelProps {
  readonly eventId: string;
}

export function GamePanel({ eventId }: GamePanelProps) {
  const [sessions, setSessions] = useState<GameSession[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [teams, setTeams] = useState<Team[]>([]);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showCards, setShowCards] = useState(false);
  /** 是否展開刪除確認。切換場次時要收起來，免得確認框指到別場。 */
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  /** 確認框裡打的場次名稱 */
  const [confirmName, setConfirmName] = useState("");
  /** 清空參與者的確認框是不是開著，以及裡面打的名稱 */
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [resetName, setResetName] = useState("");
  /** 剛清掉幾個人，講一次就好 */
  const [resetNote, setResetNote] = useState<string | null>(null);

  const [gameKey, setGameKey] = useState<string>("quiz");
  const [name, setName] = useState("");
  const [teamCount, setTeamCount] = useState(10);

  const active = sessions.find((s) => s.id === activeId) ?? null;

  const refresh = useCallback(async () => {
    const rows = await listGameSessions(eventId);
    setSessions(rows);
    return rows;
  }, [eventId]);

  const refreshTeams = useCallback(async (sessionId: string) => {
    setTeams(await listTeams(sessionId));
  }, []);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      await Promise.resolve();
      try {
        const rows = await refresh();
        if (!cancelled && rows[0] && activeId === null) {
          setActiveId(rows[0].id);
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(
            loadError instanceof Error ? loadError.message : String(loadError),
          );
        }
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [refresh, activeId]);

  useEffect(() => {
    if (!activeId) {
      return;
    }
    let cancelled = false;

    const load = async () => {
      // 讓狀態更新脫離 effect 的同步階段，避免掛載當下的連鎖重渲染
      await Promise.resolve();
      if (!cancelled) {
        await refreshTeams(activeId).catch(() => undefined);
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [activeId, refreshTeams]);

  // 入座期間人數持續變動，主持人需要看到即時進度
  useEffect(() => {
    if (!active || active.status === "finished") {
      return;
    }
    const timer = setInterval(() => {
      if (document.visibilityState !== "visible") {
        return;
      }
      void refresh().catch(() => undefined);
      void refreshTeams(active.id).catch(() => undefined);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [active, refresh, refreshTeams]);

  const run = useCallback(
    async (action: () => Promise<void>) => {
      setBusy(true);
      setError(null);
      try {
        await action();
        await refresh();
        if (activeId) {
          await refreshTeams(activeId);
        }
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
    [refresh, refreshTeams, activeId],
  );

  const create = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const trimmed = name.trim();
      if (trimmed === "") {
        return;
      }
      void run(async () => {
        const id = await createGameSession({
          eventId,
          gameKey,
          name: trimmed,
          teamCount,
        });
        setActiveId(id);
        setName("");
        setCreating(false);
      });
    },
    [eventId, gameKey, name, teamCount, run],
  );

  /**
   * 刪除場次。
   *
   * 不走 run()：run() 收尾時會拿 activeId 再抓一次隊伍，
   * 但這時候那個場次已經不存在了。這裡自己接手，
   * 刪完就把游標移到剩下的第一場（沒有就留空）。
   */
  const remove = useCallback(
    (session: GameSession) => {
      void (async () => {
        setBusy(true);
        setError(null);
        try {
          await deleteGameSession(session.id, confirmName);
          setConfirmingDelete(false);
          setConfirmName("");
          const rows = await refresh();
          const next = rows[0]?.id ?? null;
          setActiveId(next);
          setTeams(next ? await listTeams(next) : []);
        } catch (deleteError) {
          setError(
            deleteError instanceof Error
              ? deleteError.message
              : String(deleteError),
          );
        } finally {
          setBusy(false);
        }
      })();
    },
    [confirmName, refresh],
  );

  /**
   * 把整場的人清空。
   *
   * 彩排完要做的事：假玩家與他們的分數留在裡面，人數與排行榜從第一題
   * 就是錯的。桌子與題目留著，清的只有人。
   */
  const resetPlayers = useCallback(
    (session: GameSession) => {
      void (async () => {
        setBusy(true);
        setError(null);
        try {
          const removed = await resetGamePlayers(session.id, resetName);
          setConfirmingReset(false);
          setResetName("");
          setResetNote(`已經清掉 ${removed} 位參與者。`);
          await refresh();
          await refreshTeams(session.id);
        } catch (resetError) {
          setError(
            resetError instanceof Error ? resetError.message : String(resetError),
          );
        } finally {
          setBusy(false);
        }
      })();
    },
    [resetName, refresh, refreshTeams],
  );

  const seated = teams.reduce((sum, team) => sum + team.playerCount, 0);
  const rescue = parseRescueConfig(active?.config);

  const quizMode: QuizMode = parseQuizMode(active?.config.mode);
  const activeTheme = quizTheme(active?.config.theme);

  const phoneDisplay = parsePhoneDisplay(active?.config);

  const patchConfig = useCallback(
    (
      patch: Partial<{
        sensitivity: Sensitivity;
        durationMs: number;
        mode: QuizMode;
        theme: string;
        showPrompt: boolean;
        showOptions: boolean;
        showChat: boolean;
      }>,
    ) => {
      if (!active) {
        return;
      }
      // mode、theme 與三個顯示開關都不屬於划船設定，
      // 直接併進 config，不經過 toConfigPatch
      const { mode, theme, showPrompt, showOptions, showChat, ...rescuePatch } =
        patch;
      void run(() =>
        updateSessionConfig(active.id, active.config, {
          ...toConfigPatch({ ...rescue, ...rescuePatch }),
          ...(mode ? { mode } : {}),
          ...(theme ? { theme } : {}),
          // 用 !== undefined 而不是真值判斷：false 也是要存進去的值
          ...(showPrompt !== undefined ? { showPrompt } : {}),
          ...(showOptions !== undefined ? { showOptions } : {}),
          ...(showChat !== undefined ? { showChat } : {}),
        }),
      );
    },
    [active, rescue, run],
  );

  return (
    <section className="rounded-lg border border-ink-800 bg-ink-900/50 p-7">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm text-ink-300">遊戲</h2>
        {active ? (
          <span className="text-xs text-ink-500">
            {teams.length} 桌 ｜ 已入座 {seated} 位
          </span>
        ) : null}
      </div>

      {error ? (
        <p className="mt-4 text-xs leading-relaxed text-alert-500">{error}</p>
      ) : null}

      {/* 場次選擇 */}
      {sessions.length > 0 ? (
        <div className="mt-5">
          <label htmlFor="game-session" className="block text-xs text-ink-400">
            場次
          </label>
          <select
            id="game-session"
            value={activeId ?? ""}
            onChange={(e) => {
              setActiveId(e.target.value);
              // 換場次的時候把確認框收起來，免得確認的是上一場
              setConfirmingDelete(false);
              setConfirmName("");
              setConfirmingReset(false);
              setResetName("");
              setResetNote(null);
            }}
            className="mt-2 w-full rounded-lg border border-ink-700 bg-ink-950 px-3 py-2.5 text-sm text-ink-100 outline-none transition-colors duration-300 ease-world focus:border-signal-500"
          >
            {sessions.map((session) => (
              <option key={session.id} value={session.id}>
                {session.name}（{GAME_STATUS_LABEL[session.status]}）
              </option>
            ))}
          </select>
        </div>
      ) : null}

      {/* 場次控制 */}
      {active ? (
        <div className="mt-6 rounded-lg border border-ink-800 bg-ink-950/60 p-5">
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-2">
            <span className="text-xs text-ink-400">目前狀態</span>
            <span className="text-base font-light text-signal-400">
              {GAME_STATUS_LABEL[active.status]}
            </span>
          </div>
          <p className="mt-2 text-xs leading-relaxed text-ink-500">
            {GAME_STATUS_HINT[active.status]}
          </p>

          {active.status === "playing" ? (
            <p className="mt-2 text-xs text-ink-400">
              第 {active.roundNo} 回合
              {active.startedAtMs
                ? ` ｜ 起始時間 ${new Date(active.startedAtMs).toLocaleTimeString("zh-TW")}`
                : ""}
            </p>
          ) : null}

          <div className="mt-5 flex flex-wrap gap-3">
            {/* 回合的起始時間必須由伺服器決定，因此獨立於一般的狀態切換 */}
            {active.gameKey === "ocean-rescue" &&
            (active.status === "lobby" || active.status === "countdown") ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => void run(() => startRound(active.id, LEAD_IN_MS).then(() => undefined))}
                className="rounded-lg bg-signal-500 px-5 py-2.5 text-xs font-medium text-ink-950 transition-opacity duration-300 ease-world disabled:opacity-40"
              >
                開始回合
              </button>
            ) : null}

            {active.gameKey === "ocean-rescue" && active.status === "playing" ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => void run(() => endRound(active.id))}
                className="rounded-lg border border-ink-700 px-5 py-2.5 text-xs text-ink-300 transition-colors duration-300 ease-world hover:bg-ink-800"
              >
                收回這一回合
              </button>
            ) : null}

            {STATUS_ACTIONS[active.status].map((action) => (
              <button
                key={action.to}
                type="button"
                disabled={busy}
                onClick={() =>
                  void run(() => updateSessionStatus(active.id, action.to))
                }
                className="rounded-lg border border-ink-700 px-5 py-2.5 text-xs text-ink-300 transition-colors duration-300 ease-world hover:bg-ink-800 disabled:opacity-40"
              >
                {action.label}
              </button>
            ))}
            <button
              type="button"
              onClick={() => setShowCards(true)}
              className="rounded-lg border border-ink-700 px-5 py-2.5 text-xs text-ink-300 transition-colors duration-300 ease-world hover:bg-ink-800"
            >
              列印桌卡
            </button>
            {/*
              清空參與者跟刪除場次是兩件事：清空之後桌子、加入碼、題目
              都還在，大家重掃就能再進來——彩排完要按的是這一顆。
            */}
            {seated > 0 ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setConfirmingReset(!confirmingReset);
                  setResetName("");
                  setResetNote(null);
                }}
                className="ml-auto rounded-lg border border-ink-700 px-4 py-2.5 text-xs text-ink-300 transition-colors duration-300 ease-world hover:bg-ink-800 disabled:opacity-40"
              >
                {confirmingReset ? "取消" : "清空參與者"}
              </button>
            ) : null}
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setConfirmingDelete(!confirmingDelete);
                setConfirmName("");
              }}
              className={`${seated > 0 ? "" : "ml-auto "}rounded-lg px-3 py-2.5 text-xs text-ink-600 transition-colors duration-300 ease-world hover:text-alert-500 disabled:opacity-40`}
            >
              {confirmingDelete ? "取消" : "刪除場次"}
            </button>
          </div>

          {resetNote ? (
            <p className="mt-4 text-xs text-signal-400">{resetNote}</p>
          ) : null}

          {/*
            清空參與者的確認。人與分數會全部消失，所以跟刪除一樣要打字——
            但桌子、加入碼、題目都留著，大家重掃桌卡就能再進來。
          */}
          {confirmingReset ? (
            <div className="mt-5 rounded-lg border border-ink-700 bg-ink-950/60 p-5">
              <p className="text-sm text-ink-200">
                清空「{active.name}」目前的 {seated} 位參與者？
              </p>
              <p className="mt-2 text-xs leading-relaxed text-ink-500">
                所有人、他們的作答分數與同桌討論都會清掉，救不回來。
                桌子、加入碼、題目都留著——大家重新掃桌卡就能再進來，
                所以彩排完要按的是這一顆，不是「刪除場次」。
                <br />
                要繼續的話，請輸入場次名稱{" "}
                <strong className="text-ink-200">{active.name}</strong>。
              </p>
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <input
                  value={resetName}
                  onChange={(e) => setResetName(e.target.value)}
                  placeholder={active.name}
                  aria-label="輸入場次名稱以確認清空參與者"
                  className="w-56 rounded-lg border border-ink-700 bg-ink-950 px-4 py-2.5 text-sm text-ink-100 outline-none transition-colors duration-300 ease-world placeholder:text-ink-600 focus:border-signal-500"
                />
                <button
                  type="button"
                  disabled={busy || resetName.trim() !== active.name.trim()}
                  onClick={() => resetPlayers(active)}
                  className="rounded-lg bg-signal-500 px-5 py-2.5 text-sm font-medium text-ink-950 disabled:opacity-30"
                >
                  清空參與者
                </button>
              </div>
            </div>
          ) : null}

          {/*
            刪除確認。跟刪活動同一套：要打出場次名稱，不是「你確定嗎」。
            測試時建的房間跟正式那一場在選單裡長得很像，
            按錯就是整場的隊伍、分數、題目一起消失。
          */}
          {confirmingDelete ? (
            <div className="mt-5 rounded-lg border border-alert-500/40 bg-ink-900/60 p-5">
              <p className="text-sm text-ink-200">刪除「{active.name}」？</p>
              <p className="mt-2 text-xs leading-relaxed text-ink-500">
                這個場次的隊伍、加入碼、已入座的玩家、回合成績、題目與
                作答紀錄會一起消失，而且救不回來。活動本身與參與者名單不受影響。
                <br />
                要繼續的話，請輸入場次名稱{" "}
                <strong className="text-ink-200">{active.name}</strong>。
              </p>
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <input
                  value={confirmName}
                  onChange={(e) => setConfirmName(e.target.value)}
                  placeholder={active.name}
                  aria-label="輸入場次名稱以確認刪除"
                  className="w-56 rounded-lg border border-ink-700 bg-ink-950 px-4 py-2.5 text-sm text-ink-100 outline-none transition-colors duration-300 ease-world placeholder:text-ink-600 focus:border-alert-500"
                />
                <button
                  type="button"
                  disabled={busy || confirmName.trim() !== active.name.trim()}
                  onClick={() => remove(active)}
                  className="rounded-lg bg-alert-500 px-5 py-2.5 text-sm font-medium text-ink-950 disabled:opacity-30"
                >
                  永久刪除
                </button>
              </div>
            </div>
          ) : null}

          {/* 主題：決定四個選項的圖案與整場的配色 */}
          {active.gameKey === "quiz" ? (
            <div className="mt-7 border-t border-ink-800 pt-6">
              <p className="text-xs text-ink-400">主題</p>
              <p className="mt-1 text-xs leading-relaxed text-ink-500">
                決定四個選項的圖案與大螢幕的配色。整場固定不變，
                玩家玩兩題就記得住位置。
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                {QUIZ_THEMES.map((option) => (
                  <button
                    key={option.key}
                    type="button"
                    disabled={busy}
                    onClick={() => patchConfig({ theme: option.key })}
                    className={
                      option.key === activeTheme.key
                        ? "flex items-center gap-2 rounded-lg border border-signal-500 bg-signal-900/40 px-3 py-2 text-xs text-ink-100"
                        : "flex items-center gap-2 rounded-lg border border-ink-700 px-3 py-2 text-xs text-ink-400 transition-colors duration-300 ease-world hover:bg-ink-800 disabled:opacity-40"
                    }
                  >
                    {option.options.map((symbol) => (
                      <CreatureMark
                        key={symbol.creatureKey}
                        creatureKey={symbol.creatureKey}
                        size={20}
                        color={symbol.color}
                      />
                    ))}
                    <span className="ml-1">{option.name}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {/*
            手機上看得到什麼（C26）。

            三樣各自能開能關，而且是活動中途也可以改的——主持人喊
            「現在專心答題不要聊天」的時候，關掉聊天室下一秒就生效。

            關掉的那幾樣後端根本不送內容過來，不是送了再藏。
          */}
          {active.gameKey === "quiz" ? (
            <div className="mt-7 border-t border-ink-800 pt-6">
              <p className="text-xs text-ink-400">參與者的手機上看得到什麼</p>
              <p className="mt-1 text-xs leading-relaxed text-ink-500">
                活動進行中也可以隨時改，手機那邊會立刻跟著變。
              </p>

              <div className="mt-4 space-y-4">
                {(
                  [
                    {
                      key: "showPrompt",
                      label: "題目",
                      on: phoneDisplay.showPrompt,
                      hint: "打開之後手機上也會出現題目文字與配圖。預設關閉——題目只放大螢幕，大家才會一起抬頭；但看不清楚大螢幕的人確實存在，需要就打開。",
                    },
                    {
                      key: "showOptions",
                      label: "選項（作答按鈕）",
                      on: phoneDisplay.showOptions,
                      hint: "關掉之後手機上沒有任何按鈕，沒有人按得下答案。只在「這一輪不用手機作答」的時候關。",
                      warn: !phoneDisplay.showOptions,
                    },
                    {
                      key: "showChat",
                      label: "同桌聊天室",
                      on: phoneDisplay.showChat,
                      hint: "關掉之後手機下半部的討論區會整個消失，也不再連線——想讓大家專心答題時關掉它。",
                    },
                  ] as const
                ).map((item) => (
                  <div key={item.key}>
                    <label className="flex items-center gap-3 text-sm text-ink-200">
                      <input
                        type="checkbox"
                        checked={item.on}
                        disabled={busy}
                        onChange={(e) =>
                          patchConfig({ [item.key]: e.target.checked })
                        }
                        className="accent-signal-500"
                      />
                      {item.label}
                    </label>
                    <p
                      className={`mt-1 ml-7 text-xs leading-relaxed ${
                        "warn" in item && item.warn
                          ? "text-alert-500"
                          : "text-ink-500"
                      }`}
                    >
                      {item.hint}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {/* 問答的計分方式。作答方式完全相同，差別只在排行榜怎麼加總。 */}
          {active.gameKey === "quiz" ? (
            <div className="mt-7 border-t border-ink-800 pt-6">
              <p className="text-xs text-ink-400">計分方式</p>
              <p className="mt-1 text-xs leading-relaxed text-ink-500">
                {QUIZ_MODE_HINT[quizMode]}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                {(["captain", "team", "individual"] as const).map((value) => (
                  <button
                    key={value}
                    type="button"
                    disabled={busy}
                    onClick={() => patchConfig({ mode: value })}
                    className={
                      value === quizMode
                        ? "rounded-lg border border-signal-500 bg-signal-900/40 px-4 py-2 text-xs text-ink-100"
                        : "rounded-lg border border-ink-700 px-4 py-2 text-xs text-ink-400 transition-colors duration-300 ease-world hover:bg-ink-800 disabled:opacity-40"
                    }
                  >
                    {QUIZ_MODE_LABEL[value]}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {/* 划船設定：全場統一，玩家端只照做 */}
          {active.gameKey === "ocean-rescue" ? (
          <div className="mt-7 border-t border-ink-800 pt-6">
            <p className="text-xs text-ink-400">划槳靈敏度</p>
            <p className="mt-1 text-xs leading-relaxed text-ink-500">
              全場共用同一個門檻，各隊的划速才有得比。
              先用手機到 /practice 試划，找到對的那一檔再設在這裡。
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              {(["low", "medium", "high"] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  disabled={busy}
                  onClick={() => patchConfig({ sensitivity: value })}
                  className={
                    value === rescue.sensitivity
                      ? "rounded-lg border border-signal-500 bg-signal-900/40 px-4 py-2 text-xs text-ink-100"
                      : "rounded-lg border border-ink-700 px-4 py-2 text-xs text-ink-400 transition-colors duration-300 ease-world hover:bg-ink-800 disabled:opacity-40"
                  }
                >
                  {SENSITIVITY_LABEL[value]}
                </button>
              ))}
            </div>

            <p className="mt-6 text-xs text-ink-400">一回合多久</p>
            <div className="mt-3 flex flex-wrap gap-2">
              {DURATION_OPTIONS.map((value) => (
                <button
                  key={value}
                  type="button"
                  disabled={busy}
                  onClick={() => patchConfig({ durationMs: value })}
                  className={
                    value === rescue.durationMs
                      ? "rounded-lg border border-signal-500 bg-signal-900/40 px-4 py-2 text-xs text-ink-100"
                      : "rounded-lg border border-ink-700 px-4 py-2 text-xs text-ink-400 transition-colors duration-300 ease-world hover:bg-ink-800 disabled:opacity-40"
                  }
                >
                  {value / 1000} 秒
                </button>
              ))}
            </div>

            {active.status === "playing" ? (
              <p className="mt-4 text-xs leading-relaxed text-ink-500">
                回合進行中改設定不會影響已經開始的這一回合，下一回合才生效。
              </p>
            ) : null}
          </div>
          ) : null}

          {/* 各桌入座狀況 */}
          {teams.length > 0 ? (
            <ul className="mt-7 grid gap-px overflow-hidden rounded-lg bg-ink-800 sm:grid-cols-2">
              {teams.map((team) => (
                <li
                  key={team.id}
                  className="flex items-center gap-3 bg-ink-950 px-4 py-3"
                >
                  <span
                    className="size-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: team.color }}
                  />
                  <input
                    defaultValue={team.name}
                    maxLength={40}
                    disabled={busy}
                    onBlur={(e) => {
                      const next = e.target.value.trim();
                      if (next !== "" && next !== team.name) {
                        void run(() => renameTeam(team.id, next));
                      } else {
                        e.target.value = team.name;
                      }
                    }}
                    className="min-w-0 flex-1 rounded border border-transparent bg-transparent px-2 py-1 text-sm text-ink-100 outline-none transition-colors duration-300 ease-world hover:border-ink-700 focus:border-signal-500"
                  />
                  <span className="shrink-0 text-[0.7rem] text-ink-500">
                    {findCreature(team.creatureKey)?.name ?? team.creatureKey}
                  </span>
                  <span className="shrink-0 font-mono text-[0.65rem] text-ink-600">
                    {team.joinCode}
                  </span>
                  <span
                    className={`w-10 shrink-0 text-right text-sm tabular-nums ${
                      team.playerCount > 0 ? "text-signal-400" : "text-ink-600"
                    }`}
                  >
                    {team.playerCount}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {/* 建立場次 */}
      <div className="mt-7">
        {creating ? (
          <form
            onSubmit={create}
            className="rounded-lg border border-ink-800 bg-ink-950/60 p-6"
          >
            <h3 className="text-sm text-ink-200">建立遊戲場次</h3>

            <label
              htmlFor="game-name"
              className="mt-5 block text-xs text-ink-400"
            >
              場次名稱
            </label>
            <input
              id="game-name"
              required
              maxLength={60}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如：下午場 海洋救援"
              className="mt-2 w-full rounded-lg border border-ink-700 bg-ink-950 px-4 py-2.5 text-sm text-ink-100 outline-none transition-colors duration-300 ease-world placeholder:text-ink-600 focus:border-signal-500"
            />

            <div className="mt-5 grid gap-5 sm:grid-cols-2">
              <div>
                <label
                  htmlFor="game-key"
                  className="block text-xs text-ink-400"
                >
                  遊戲
                </label>
                <select
                  id="game-key"
                  value={gameKey}
                  onChange={(e) => setGameKey(e.target.value)}
                  className="mt-2 w-full rounded-lg border border-ink-700 bg-ink-950 px-3 py-2.5 text-sm text-ink-100 outline-none transition-colors duration-300 ease-world focus:border-signal-500"
                >
                  {GAMES.map((game) => (
                    <option key={game.key} value={game.key}>
                      {game.name}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label
                  htmlFor="game-teams"
                  className="block text-xs text-ink-400"
                >
                  幾桌（隊）
                </label>
                <input
                  id="game-teams"
                  type="number"
                  min={1}
                  max={100}
                  value={teamCount}
                  onChange={(e) => setTeamCount(Number(e.target.value))}
                  className="mt-2 w-full rounded-lg border border-ink-700 bg-ink-950 px-3 py-2.5 text-sm text-ink-100 outline-none transition-colors duration-300 ease-world focus:border-signal-500"
                />
              </div>
            </div>

            <p className="mt-4 text-xs leading-relaxed text-ink-500">
              建立後每桌會拿到自己的加入碼與 QR Code，列印出來放到桌上，
              玩家掃自己桌上那張就會進入該隊。
            </p>

            <div className="mt-6 flex gap-3">
              <button
                type="submit"
                disabled={busy || name.trim() === ""}
                className="rounded-lg bg-signal-500 px-6 py-2.5 text-sm font-medium text-ink-950 transition-opacity duration-300 ease-world disabled:opacity-40"
              >
                {busy ? "建立中" : "建立"}
              </button>
              <button
                type="button"
                onClick={() => setCreating(false)}
                className="rounded-lg border border-ink-700 px-6 py-2.5 text-sm text-ink-300 transition-colors duration-300 ease-world hover:bg-ink-800"
              >
                取消
              </button>
            </div>
          </form>
        ) : (
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="rounded-lg border border-ink-700 px-5 py-2.5 text-sm text-ink-300 transition-colors duration-300 ease-world hover:bg-ink-800"
          >
            建立遊戲場次
          </button>
        )}
      </div>

      {active?.gameKey === "quiz" ? (
        <div className="mt-6">
          <QuizPanel
            sessionId={active.id}
            eventId={eventId}
            themeKey={active.config.theme}
          />
        </div>
      ) : null}

      <p className="mt-6 text-xs leading-relaxed text-ink-500">
        還沒抓到划槳的手感？用手機打開{" "}
        <a
          href="/practice"
          className="text-ink-300 underline underline-offset-4 transition-colors duration-300 ease-world hover:text-signal-400"
        >
          /practice
        </a>{" "}
        可以單獨試划，不需要建立場次。
      </p>

      {showCards && active ? (
        <TableCards
          teams={teams}
          sessionName={active.name}
          onClose={() => setShowCards(false)}
        />
      ) : null}
    </section>
  );
}
