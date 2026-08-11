"use client";

import { useCallback, useEffect, useState } from "react";
import { CreatureMark } from "@/components/quiz/CreatureMark";
import {
  deleteQuizQuestion,
  endAnswerEarly,
  getQuizStageState,
  listQuizQuestions,
  moveQuizQuestion,
  saveQuizQuestion,
  setQuizPhase,
  startQuizQuestion,
} from "@/lib/quiz/api";
import { QUIZ_OPTIONS } from "@/lib/quiz/options";
import { CaptainPanel } from "./CaptainPanel";
import { uploadQuizImage } from "@/lib/quiz/image";
import { NEW_QUESTION, QUIZ_PHASE_LABEL } from "@/lib/quiz/types";
import type {
  QuizPhase,
  QuizQuestion,
  QuizQuestionInput,
  QuizStageState,
} from "@/lib/quiz/types";

/**
 * 出題與主持（Q0）。
 *
 * 現場的操作順序刻意做成一條線：選題 → 開始 → 公布答案 → 看排行 → 下一題。
 * 主持人拿著麥克風、面對兩百人，能點的按鈕越少越好，
 * 所以每個階段只留下「此刻該做的那一個」。
 */

const POLL_MS = 2000;

interface QuizPanelProps {
  readonly sessionId: string;
  /** assets 儲存桶的寫入政策要求路徑第一層是主持人自己的活動 id */
  readonly eventId: string;
}

export function QuizPanel({ sessionId, eventId }: QuizPanelProps) {
  const [questions, setQuestions] = useState<QuizQuestion[]>([]);
  const [stage, setStage] = useState<QuizStageState | null>(null);
  const [draft, setDraft] = useState<QuizQuestionInput | null>(null);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [rows, live] = await Promise.all([
      listQuizQuestions(sessionId),
      getQuizStageState(sessionId),
    ]);
    setQuestions(rows);
    setStage(live);
  }, [sessionId]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      await Promise.resolve();
      if (cancelled) {
        return;
      }
      try {
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    };
    void load();

    const timer = setInterval(() => {
      if (document.visibilityState === "visible") {
        void refresh().catch(() => undefined);
      }
    }, POLL_MS);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [refresh]);

  const run = useCallback(
    (action: () => Promise<void>) => {
      setBusy(true);
      setError(null);
      void action()
        .then(() => refresh())
        .catch((e: unknown) => {
          setError(e instanceof Error ? e.message : String(e));
        })
        .finally(() => setBusy(false));
    },
    [refresh],
  );

  const save = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      if (!draft) {
        return;
      }
      const trimmed = draft.options.map((o) => o.trim());
      if (draft.prompt.trim() === "" || trimmed.some((o) => o === "")) {
        setError("題目與四個選項都要填。");
        return;
      }
      run(async () => {
        await saveQuizQuestion(sessionId, { ...draft, options: trimmed });
        setDraft(null);
      });
    },
    [draft, run, sessionId],
  );

  const pickImage = useCallback(
    async (file: File) => {
      setUploading(true);
      setError(null);
      try {
        const url = await uploadQuizImage(eventId, file);
        setDraft((current) => (current ? { ...current, imageUrl: url } : current));
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setUploading(false);
      }
    },
    [eventId],
  );

  const currentId = stage?.questionId ?? null;
  const phase: QuizPhase = stage?.phase ?? "idle";
  const currentIndex = questions.findIndex((q) => q.id === currentId);
  const nextQuestion =
    currentIndex >= 0 ? questions[currentIndex + 1] : questions[0];

  return (
    <section className="rounded-lg border border-ink-800 bg-ink-900/50 p-7">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm text-ink-300">海洋問答</h2>
        <a
          href={`/game/${sessionId}`}
          target="_blank"
          rel="noreferrer"
          className="text-xs text-ink-400 underline underline-offset-4 transition-colors duration-300 ease-world hover:text-signal-400"
        >
          開啟大螢幕
        </a>
      </div>

      {error ? (
        <p className="mt-4 text-xs leading-relaxed text-alert-500">{error}</p>
      ) : null}

      {/* 主持控制 */}
      <div className="mt-5 rounded-lg border border-ink-800 bg-ink-950/60 p-5">
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-2">
          <span className="text-xs text-ink-400">大螢幕現在</span>
          <span className="text-base font-light text-signal-400">
            {QUIZ_PHASE_LABEL[phase]}
          </span>
          {currentIndex >= 0 ? (
            <span className="text-xs text-ink-500">
              第 {currentIndex + 1} 題 ｜ 已作答 {stage?.answeredCount ?? 0} ／{" "}
              {stage?.playerCount ?? 0}
            </span>
          ) : null}
        </div>

        <div className="mt-5 flex flex-wrap gap-3">
          {phase === "idle" || phase === "scoreboard" ? (
            nextQuestion ? (
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  run(() => startQuizQuestion(sessionId, nextQuestion.id))
                }
                className="rounded-lg bg-signal-500 px-5 py-2.5 text-xs font-medium text-ink-950 transition-opacity duration-300 ease-world disabled:opacity-40"
              >
                {currentIndex >= 0 ? "下一題" : "開始第 1 題"}
              </button>
            ) : (
              <span className="text-xs text-ink-500">
                {questions.length === 0 ? "先在下面新增題目" : "所有題目都出過了"}
              </span>
            )
          ) : null}

          {/* 公布答案與排行榜都由時間自動推進，主持人不必記得按。
              這一顆只在「大家都答完了、不想等時間跑完」時用。 */}
          {phase === "answer" ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => run(() => endAnswerEarly(sessionId))}
              className="rounded-lg border border-ink-700 px-5 py-2.5 text-xs text-ink-300 transition-colors duration-300 ease-world hover:bg-ink-800 disabled:opacity-40"
            >
              提早收答案
            </button>
          ) : null}

          {phase === "reveal" ? (
            <span className="self-center text-xs text-ink-500">
              正在公布答案，稍後自動顯示分數
            </span>
          ) : null}

          {phase !== "idle" ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => run(() => setQuizPhase(sessionId, "idle"))}
              className="rounded-lg border border-ink-700 px-5 py-2.5 text-xs text-ink-300 transition-colors duration-300 ease-world hover:bg-ink-800"
            >
              回到待機畫面
            </button>
          ) : null}
        </div>
      </div>

      {stage?.mode === "captain" ? (
        <CaptainPanel sessionId={sessionId} />
      ) : null}

      {/* 題目清單 */}
      <ul className="mt-6 space-y-2">
        {questions.map((q) => (
          <li
            key={q.id}
            className={`rounded-lg border p-4 ${
              q.id === currentId
                ? "border-signal-500 bg-signal-900/20"
                : "border-ink-800 bg-ink-950/40"
            }`}
          >
            <div className="flex items-start gap-3">
              <span className="mt-0.5 w-6 shrink-0 text-xs text-ink-500 tabular-nums">
                {q.ordinal}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-start gap-3">
                  {q.imageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={q.imageUrl}
                      alt=""
                      className="h-12 w-16 shrink-0 rounded border border-ink-800 object-cover"
                    />
                  ) : null}
                  <p className="text-sm text-ink-100">{q.prompt}</p>
                </div>
                <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
                  {q.options.map((text, index) => (
                    <span
                      key={index}
                      className={`text-xs ${
                        index === q.correctIndex
                          ? "text-signal-400"
                          : "text-ink-500"
                      }`}
                    >
                      {QUIZ_OPTIONS[index]?.name} {text}
                      {index === q.correctIndex ? "（正解）" : ""}
                    </span>
                  ))}
                </div>
                <p className="mt-2 text-[0.7rem] text-ink-600">
                  讀題 {q.prepSeconds} 秒 ｜ 作答 {q.answerSeconds} 秒 ｜ 公布{" "}
                  {q.revealSeconds} 秒 ｜ 滿分 {q.points}
                  {q.answerCount > 0 ? ` ｜ 已有 ${q.answerCount} 筆作答` : ""}
                </p>
              </div>

              <div className="flex shrink-0 gap-1">
                <IconButton
                  label="上移"
                  disabled={busy}
                  onClick={() => run(() => moveQuizQuestion(q.id, -1))}
                >
                  ↑
                </IconButton>
                <IconButton
                  label="下移"
                  disabled={busy}
                  onClick={() => run(() => moveQuizQuestion(q.id, 1))}
                >
                  ↓
                </IconButton>
                <IconButton
                  label="編輯"
                  disabled={busy}
                  onClick={() =>
                    setDraft({
                      id: q.id,
                      prompt: q.prompt,
                      imageUrl: q.imageUrl,
                      options: [...q.options],
                      correctIndex: q.correctIndex,
                      prepSeconds: q.prepSeconds,
                      answerSeconds: q.answerSeconds,
                      revealSeconds: q.revealSeconds,
                      points: q.points,
                    })
                  }
                >
                  改
                </IconButton>
                <IconButton
                  label="刪除"
                  disabled={busy}
                  danger
                  onClick={() => run(() => deleteQuizQuestion(q.id))}
                >
                  ×
                </IconButton>
              </div>
            </div>
          </li>
        ))}
      </ul>

      {/* 出題 */}
      {draft ? (
        <form
          onSubmit={save}
          className="mt-6 rounded-lg border border-ink-800 bg-ink-950/60 p-6"
        >
          <h3 className="text-sm text-ink-200">
            {draft.id ? "修改題目" : "新增題目"}
          </h3>

          <label htmlFor="quiz-prompt" className="mt-5 block text-xs text-ink-400">
            題目
          </label>
          <textarea
            id="quiz-prompt"
            required
            rows={2}
            maxLength={300}
            value={draft.prompt}
            onChange={(e) => setDraft({ ...draft, prompt: e.target.value })}
            placeholder="例如：藍鯨的心臟大約有多重？"
            className="mt-2 w-full resize-y rounded-lg border border-ink-700 bg-ink-950 px-4 py-2.5 text-sm text-ink-100 outline-none transition-colors duration-300 ease-world placeholder:text-ink-600 focus:border-signal-500"
          />

          {/* 配圖：圖片會在讀題階段就出現在大螢幕與手機上 */}
          <p className="mt-5 text-xs text-ink-400">配圖（可以不放）</p>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            {draft.imageUrl ? (
              <>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={draft.imageUrl}
                  alt="題目配圖"
                  className="h-20 w-auto rounded border border-ink-700 object-contain"
                />
                <button
                  type="button"
                  onClick={() => setDraft({ ...draft, imageUrl: null })}
                  className="rounded-lg border border-ink-700 px-4 py-2 text-xs text-ink-400 transition-colors duration-300 ease-world hover:bg-ink-800"
                >
                  移除圖片
                </button>
              </>
            ) : (
              <label className="cursor-pointer rounded-lg border border-ink-700 px-4 py-2 text-xs text-ink-300 transition-colors duration-300 ease-world hover:bg-ink-800">
                {uploading ? "上傳中" : "選擇圖片"}
                <input
                  type="file"
                  accept="image/*"
                  className="hidden"
                  disabled={uploading}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    e.target.value = "";
                    if (file) {
                      void pickImage(file);
                    }
                  }}
                />
              </label>
            )}
            <span className="text-xs text-ink-600">
              太大的圖會自動縮小再上傳
            </span>
          </div>

          <p className="mt-5 text-xs text-ink-400">
            四個選項（點左邊的生物設為正解）
          </p>
          <div className="mt-3 space-y-2">
            {QUIZ_OPTIONS.map((option, index) => (
              <div key={option.creatureKey} className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => setDraft({ ...draft, correctIndex: index })}
                  title={`把「${option.name}」設為正解`}
                  className={`flex shrink-0 items-center gap-2 rounded-lg border px-3 py-2 transition-colors duration-300 ease-world ${
                    draft.correctIndex === index
                      ? "border-signal-500 bg-signal-900/40"
                      : "border-ink-700 hover:bg-ink-800"
                  }`}
                >
                  <CreatureMark creatureKey={option.creatureKey} size={26} color={option.color} />
                  <span className="text-xs text-ink-300">{option.name}</span>
                </button>
                <input
                  required
                  maxLength={120}
                  value={draft.options[index] ?? ""}
                  onChange={(e) => {
                    const next = [...draft.options];
                    next[index] = e.target.value;
                    setDraft({ ...draft, options: next });
                  }}
                  placeholder={`${option.name}的答案`}
                  className="min-w-0 flex-1 rounded-lg border border-ink-700 bg-ink-950 px-3 py-2 text-sm text-ink-100 outline-none transition-colors duration-300 ease-world placeholder:text-ink-600 focus:border-signal-500"
                />
              </div>
            ))}
          </div>

          <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <NumberField
              id="quiz-prep"
              label="讀題秒數"
              min={0}
              max={60}
              value={draft.prepSeconds}
              onChange={(v) => setDraft({ ...draft, prepSeconds: v })}
            />
            <NumberField
              id="quiz-answer"
              label="作答秒數"
              min={5}
              max={180}
              value={draft.answerSeconds}
              onChange={(v) => setDraft({ ...draft, answerSeconds: v })}
            />
            <NumberField
              id="quiz-reveal"
              label="公布停留秒數"
              min={2}
              max={60}
              value={draft.revealSeconds}
              onChange={(v) => setDraft({ ...draft, revealSeconds: v })}
            />
            <NumberField
              id="quiz-points"
              label="滿分"
              min={100}
              max={10000}
              step={100}
              value={draft.points}
              onChange={(v) => setDraft({ ...draft, points: v })}
            />
          </div>

          <p className="mt-4 text-xs leading-relaxed text-ink-500">
            答對的分數隨作答時間遞減，秒答拿滿分，壓線答對拿一半。
            <br />
            按下「下一題」之後就不必再操作：讀題倒數結束自動開放作答，
            時間到自動公布答案，停留設定的秒數後自動顯示分數。
          </p>

          <div className="mt-6 flex gap-3">
            <button
              type="submit"
              disabled={busy}
              className="rounded-lg bg-signal-500 px-6 py-2.5 text-sm font-medium text-ink-950 transition-opacity duration-300 ease-world disabled:opacity-40"
            >
              {busy ? "儲存中" : "儲存"}
            </button>
            <button
              type="button"
              onClick={() => setDraft(null)}
              className="rounded-lg border border-ink-700 px-6 py-2.5 text-sm text-ink-300 transition-colors duration-300 ease-world hover:bg-ink-800"
            >
              取消
            </button>
          </div>
        </form>
      ) : (
        <button
          type="button"
          onClick={() => setDraft({ ...NEW_QUESTION })}
          className="mt-6 rounded-lg border border-ink-700 px-5 py-2.5 text-sm text-ink-300 transition-colors duration-300 ease-world hover:bg-ink-800"
        >
          新增題目
        </button>
      )}
    </section>
  );
}

function IconButton({
  label,
  children,
  disabled,
  danger,
  onClick,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
  readonly disabled: boolean;
  readonly danger?: boolean;
  readonly onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={`size-8 rounded border border-ink-700 text-xs transition-colors duration-300 ease-world disabled:opacity-30 ${
        danger
          ? "text-alert-500 hover:bg-alert-500/10"
          : "text-ink-400 hover:bg-ink-800"
      }`}
    >
      {children}
    </button>
  );
}

function NumberField({
  id,
  label,
  min,
  max,
  step,
  value,
  onChange,
}: {
  readonly id: string;
  readonly label: string;
  readonly min: number;
  readonly max: number;
  readonly step?: number;
  readonly value: number;
  readonly onChange: (value: number) => void;
}) {
  return (
    <div>
      <label htmlFor={id} className="block text-xs text-ink-400">
        {label}
      </label>
      <input
        id={id}
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="mt-2 w-full rounded-lg border border-ink-700 bg-ink-950 px-3 py-2 text-sm text-ink-100 outline-none transition-colors duration-300 ease-world focus:border-signal-500"
      />
    </div>
  );
}
