import Link from "next/link";
import { CodeJump } from "@/components/home/CodeJump";

/**
 * 首頁（C17）。
 *
 * 這一頁原本是專案剛開始時的開發索引：寫著「目前進度 M0：專案骨架」，
 * 三個連結全部寫死指向示範活動 DEMO01。從那之後所有東西都做完了，
 * 這一頁卻沒人動過——於是打開正式網址的人看到的是一頁跟現在的系統
 * 完全對不起來的東西，會以為部署失敗了。
 *
 * 現在它做兩件事，都是實際會用到的：
 *
 *   1. 主持人進控制台。所有設定、遊戲、抽獎都從那裡開始。
 *   2. 輸入活動代碼直接跳到大螢幕／報到／上傳餅乾。
 *      這些路徑沒有人記得住，也不該記。
 */

export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-3xl flex-col justify-center px-8 py-24">
      <header>
        <p className="text-xs tracking-[0.35em] text-ink-500 uppercase">
          Interactive Event Platform
        </p>
        <h1 className="mt-8 text-4xl leading-tight font-light text-ink-100 sm:text-5xl">
          每一條河，
          <br />
          都有自己的方向。
        </h1>
        <p className="mt-8 max-w-xl text-base leading-relaxed text-ink-400">
          參與者用手機簽名、拍下自己的作品，內容即時匯進大螢幕的世界，
          再從這個世界裡抽出中獎者、玩問答。
        </p>
      </header>

      {/* 主持人是唯一需要登入的角色，也是所有流程的起點 */}
      <Link
        href="/host"
        className="group mt-16 block rounded-lg border border-ink-700 bg-ink-950 p-6 transition-colors duration-300 ease-world hover:border-signal-500 hover:bg-ink-900"
      >
        <span className="block text-lg font-light text-ink-100 transition-colors duration-300 ease-world group-hover:text-signal-400">
          主持人控制台
        </span>
        <span className="mt-2 block text-sm leading-relaxed text-ink-500">
          建立活動、設定大螢幕、出題、控制遊戲與抽獎。需要登入。
        </span>
      </Link>

      <div className="mt-12">
        <CodeJump />
      </div>

      <footer className="mt-16 flex items-center gap-3 text-xs text-ink-600">
        <span className="inline-block size-1.5 animate-breathe rounded-full bg-signal-500" />
        <span>手機掃 QR Code 的人不會經過這一頁</span>
        <Link
          href="/health"
          className="ml-auto text-ink-500 underline-offset-4 transition-colors duration-300 ease-world hover:text-ink-300 hover:underline"
        >
          連線診斷
        </Link>
      </footer>
    </main>
  );
}
