import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { CheckinFlow } from "@/components/checkin/CheckinFlow";
import { JoinFlow } from "@/components/join/JoinFlow";
import { fetchEventByCode } from "@/lib/server/events";

export const metadata: Metadata = {
  title: "加入世界",
};

export default async function JoinPage({ params }: PageProps<"/join/[code]">) {
  await connection();

  const { code } = await params;
  // QR Code 的網址一律大寫，手動輸入小寫也視為相同活動
  const normalizedCode = code.toUpperCase();
  const event = await fetchEventByCode(normalizedCode);

  if (!event) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-8 py-16">
        <h1 className="text-2xl font-light text-ink-100">找不到這場活動</h1>
        <p className="mt-4 text-sm leading-relaxed text-ink-400">
          活動代碼「{normalizedCode}
          」不存在或尚未開放。請確認 QR Code 是否正確，或詢問主持人。
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

  // 同一個 QR Code、同一條網址，主持人在後台切換要走哪一種報到方式。
  // 印好的 QR Code 不必因為改玩法而重印。
  if (event.joinMode === "signature") {
    return <CheckinFlow event={event} />;
  }

  return <JoinFlow event={event} />;
}
