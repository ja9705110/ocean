import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { CookieUploader } from "@/components/cookie/CookieUploader";
import { fetchEventByCode } from "@/lib/server/events";

export const metadata: Metadata = {
  title: "上傳餅乾",
};

/**
 * 餅乾上傳頁。網址跟報到頁一樣是活動代碼，另外印一張 QR Code
 * 放在彩繪桌上就好——不必再發一次通知，也不必記另一組代碼。
 */
export default async function CookiePage({
  params,
}: PageProps<"/cookie/[code]">) {
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
          請確認 QR Code 是否正確，或詢問主持人。
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

  return (
    <CookieUploader
      eventId={event.id}
      eventName={event.name}
      eventStatus={event.status}
    />
  );
}
