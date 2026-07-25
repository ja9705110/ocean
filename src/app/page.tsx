import Link from "next/link";

/** 開發期的入口索引。正式活動時使用者不會走到這一頁。 */
const entries = [
  {
    href: "/join/DEMO01",
    label: "參與者",
    description: "掃碼進入，畫出代表自己的角色",
    milestone: "M2",
  },
  {
    href: "/stage/DEMO01",
    label: "世界大螢幕",
    description: "所有角色匯聚的共創世界",
    milestone: "M3",
  },
  {
    href: "/host",
    label: "主持人",
    description: "建立活動、控制抽獎流程",
    milestone: "M6",
  },
] as const;

export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-4xl flex-col justify-center px-8 py-24">
      <header>
        <p className="text-xs tracking-[0.35em] text-ink-500 uppercase">
          Interactive World Draw
        </p>
        <h1 className="mt-8 text-4xl leading-tight font-light text-ink-100 sm:text-5xl">
          每個人畫下的角色，
          <br />
          會游進同一個世界。
        </h1>
        <p className="mt-8 max-w-xl text-base leading-relaxed text-ink-400">
          參與者用手機畫出代表自己的角色，角色即時進入大螢幕上的共創世界，
          最後從這個世界裡選出中獎者。
        </p>
      </header>

      <nav className="mt-20 grid gap-px overflow-hidden rounded-lg bg-ink-800 sm:grid-cols-3">
        {entries.map((entry) => (
          <Link
            key={entry.href}
            href={entry.href}
            className="group bg-ink-950 p-6 transition-colors duration-500 ease-world hover:bg-ink-900"
          >
            <span className="text-[0.65rem] tracking-[0.2em] text-ink-600 uppercase">
              {entry.milestone}
            </span>
            <span className="mt-3 block text-lg font-light text-ink-200 transition-colors duration-500 ease-world group-hover:text-signal-400">
              {entry.label}
            </span>
            <span className="mt-2 block text-sm leading-relaxed text-ink-500">
              {entry.description}
            </span>
          </Link>
        ))}
      </nav>

      <footer className="mt-16 flex items-center gap-3 text-xs text-ink-600">
        <span className="inline-block size-1.5 animate-breathe rounded-full bg-signal-500" />
        <span>目前進度 M0：專案骨架</span>
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
