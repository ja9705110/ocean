import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { JoinFlow } from "@/components/join/JoinFlow";
import type { PublicEvent } from "@/lib/join/api";
import { readSupabaseEnv } from "@/lib/env";

export const metadata: Metadata = {
  title: "加入世界",
};

interface EventRow {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly subtitle: string | null;
  readonly world_template: string;
  readonly status: PublicEvent["status"];
  readonly participant_count: number;
}

/**
 * 活動查詢放在 Server Component：
 * 活動不存在時能回應乾淨的畫面，client bundle 也不需帶查詢邏輯。
 * RLS 只允許 anon 讀到公開狀態的活動，draft 在這裡等同不存在。
 */
async function fetchEventByCode(code: string): Promise<PublicEvent | null> {
  const envResult = readSupabaseEnv();
  if (!envResult.ok) {
    return null;
  }

  const { url, anonKey } = envResult.env;
  const response = await fetch(
    `${url}/rest/v1/events?select=id,code,name,subtitle,world_template,status,participant_count&code=eq.${encodeURIComponent(code)}`,
    {
      headers: { apikey: anonKey },
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    },
  );

  if (!response.ok) {
    throw new Error(`活動查詢失敗（HTTP ${response.status}）`);
  }

  const rows = (await response.json()) as EventRow[];
  const row = rows[0];

  if (!row) {
    return null;
  }

  return {
    id: row.id,
    code: row.code,
    name: row.name,
    subtitle: row.subtitle,
    worldTemplate: row.world_template,
    status: row.status,
    participantCount: row.participant_count,
  };
}

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

  return <JoinFlow event={event} />;
}
