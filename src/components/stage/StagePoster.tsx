"use client";

import type { StagePoster as StagePosterText } from "@/lib/stageConfig";
import { posterIsEmpty } from "@/lib/stageConfig";

/**
 * 大螢幕上不動的主視覺文字（C2）。
 *
 * 河在流、簽名在流，但標題、日期、場地要像海報一樣定在那裡。
 * 這一塊排在畫面左側，跟右側的 QR Code 面板互不重疊。
 *
 * 為什麼用 DOM 而不是畫進 PixiJS：
 * 1. 中文在 canvas 裡要自己處理字型載入與斷行，投影機上很容易糊掉；
 *    瀏覽器的文字排版與次像素渲染是免費且更好的。
 * 2. 這些字是不動的。放進每幀重繪的畫布只是白白多一層繪製成本。
 *
 * 字級全部以 vw / vh 為單位：投影機的解析度每一場都不同，
 * 用 px 會在 4K 投影上小到看不見。
 */

interface StagePosterProps {
  readonly poster: StagePosterText;
}

export function StagePoster({ poster }: StagePosterProps) {
  if (posterIsEmpty(poster)) {
    return null;
  }

  const titleEnLines = poster.titleEn.split(/\s*\/\s*|\n/).filter(Boolean);

  return (
    <div className="pointer-events-none absolute inset-y-0 left-0 flex w-[46%] flex-col justify-center px-[4vw]">
      {/*
        由左向右的暗幕。沒有它，河道最亮的那幾道金線會正好穿過日期與落款
        那幾行，投到牆上完全讀不出來——這是投影最常見的失敗方式：
        在螢幕上看起來還行，投上去就糊成一片。
      */}
      <div className="absolute inset-y-0 -left-[2vw] w-[130%] bg-gradient-to-r from-[#02040c] via-[#02040c]/92 to-transparent" />

      {poster.eyebrow ? (
        <p className="relative text-[1.5vh] leading-relaxed tracking-[0.18em] text-[#e8c98c] whitespace-pre-line">
          {poster.eyebrow}
        </p>
      ) : null}

      {poster.title ? (
        <p
          className="relative mt-[1.5vh] text-[11vh] leading-none font-light tracking-[0.06em] text-[#f5d9a0]"
          // 金屬感：由亮到暗的漸層填在字上，跟主視覺的燙金一致
          style={{
            backgroundImage:
              "linear-gradient(160deg,#fff3d6 0%,#f2c063 42%,#b9822b 72%,#ffeec4 100%)",
            WebkitBackgroundClip: "text",
            backgroundClip: "text",
            color: "transparent",
          }}
        >
          {poster.title}
        </p>
      ) : null}

      {titleEnLines.length > 0 ? (
        <div className="relative mt-[2vh]">
          {titleEnLines.map((line) => (
            <p
              key={line}
              className="text-[2.2vh] leading-tight tracking-[0.35em] text-[#cfd8e6] uppercase"
            >
              {line}
            </p>
          ))}
        </div>
      ) : null}

      {poster.tagline ? (
        <p className="relative mt-[3vh] text-[1.9vh] leading-relaxed tracking-[0.1em] text-[#e8c98c] whitespace-pre-line">
          {poster.tagline}
        </p>
      ) : null}

      {poster.venue ? (
        <p className="relative mt-[4vh] text-[2vh] leading-relaxed tracking-[0.12em] text-[#dbe4f0] whitespace-pre-line">
          {poster.venue}
        </p>
      ) : null}

      {poster.dateText ? (
        <>
          <div className="relative mt-[2vh] h-px w-[30%] bg-[#3a557f]" />
          <p className="relative mt-[2vh] text-[2.4vh] tracking-[0.1em] text-[#c9b48a]">
            {poster.dateText}
          </p>
        </>
      ) : null}

      {poster.keywords ? (
        <p className="relative mt-[3vh] text-[1.7vh] tracking-[0.12em] text-[#9fb3cc]">
          {poster.keywords}
        </p>
      ) : null}

      {poster.footer ? (
        <p className="relative mt-[4vh] text-[1.6vh] tracking-[0.2em] text-[#c9a45f]">
          {poster.footer}
        </p>
      ) : null}
    </div>
  );
}
