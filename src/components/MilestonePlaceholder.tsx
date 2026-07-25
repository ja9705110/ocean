import Link from "next/link";

interface MilestonePlaceholderProps {
  /** 這個畫面預計在哪個里程碑實作，例如「M3」 */
  readonly milestone: string;
  readonly title: string;
  readonly description: string;
  /** 路由參數等除錯資訊，用來確認路由確實有接到值 */
  readonly detail?: string;
}

/**
 * 尚未實作的畫面佔位。
 * 只在 M0 使用，各入口實作後即移除。
 */
export function MilestonePlaceholder({
  milestone,
  title,
  description,
  detail,
}: MilestonePlaceholderProps) {
  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col justify-center px-8 py-24">
      <span className="text-[0.65rem] tracking-[0.3em] text-ink-600 uppercase">
        {milestone}
      </span>
      <h1 className="mt-6 text-3xl font-light text-ink-100">{title}</h1>
      <p className="mt-5 text-sm leading-relaxed text-ink-400">{description}</p>

      {detail ? (
        <p className="mt-8 font-mono text-xs text-ink-500">{detail}</p>
      ) : null}

      <Link
        href="/"
        className="mt-16 text-xs text-ink-600 underline-offset-4 transition-colors duration-300 ease-world hover:text-ink-300 hover:underline"
      >
        返回入口索引
      </Link>
    </main>
  );
}
