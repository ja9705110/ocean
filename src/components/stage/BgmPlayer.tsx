"use client";

import { useEffect, useRef, useState } from "react";

/**
 * 背景音樂。
 *
 * 瀏覽器一律禁止未經使用者互動的自動播放，因此必須有一個實體按鈕。
 * 這是規範限制不是可以繞過的問題——大螢幕開場時主持人點一下即可。
 */

interface BgmPlayerProps {
  readonly url: string;
}

export function BgmPlayer({ url }: BgmPlayerProps) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const audio = new Audio(url);
    audio.loop = true;
    audio.volume = 0.35;
    audioRef.current = audio;

    return () => {
      audio.pause();
      audioRef.current = null;
    };
  }, [url]);

  const toggle = () => {
    const audio = audioRef.current;
    if (!audio) {
      return;
    }

    if (playing) {
      audio.pause();
      setPlaying(false);
      return;
    }

    audio
      .play()
      .then(() => {
        setPlaying(true);
        setFailed(false);
      })
      .catch(() => setFailed(true));
  };

  return (
    <button
      type="button"
      onClick={toggle}
      className="absolute right-10 bottom-8 rounded-full border border-ink-700/70 bg-ink-950/60 px-5 py-2 text-xs text-ink-400 transition-colors duration-300 ease-world hover:text-ink-100"
    >
      {failed ? "音樂無法播放" : playing ? "暫停音樂" : "播放音樂"}
    </button>
  );
}
