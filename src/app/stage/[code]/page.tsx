import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { StageView } from "@/components/stage/StageView";
import { fetchEventByCode } from "@/lib/server/events";

export const metadata: Metadata = {
  title: "世界大螢幕",
};

export default async function StagePage({
  params,
}: PageProps<"/stage/[code]">) {
  await connection();

  const { code } = await params;
  const normalizedCode = code.toUpperCase();
  const event = await fetchEventByCode(normalizedCode);

  if (!event) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-8 py-16">
        <h1 className="text-2xl font-light text-ink-100">找不到這場活動</h1>
        <p className="mt-4 text-sm leading-relaxed text-ink-400">
          活動代碼「{normalizedCode}」不存在或尚未開放。
        </p>
        <Link
          href="/"
          className="mt-12 text-xs text-ink-600 underline-offset-4 hover:underline"
        >
          返回首頁
        </Link>
      </main>
    );
  }

  return <StageView event={event} />;
}
