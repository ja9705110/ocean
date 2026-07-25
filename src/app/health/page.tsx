import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { readSupabaseEnv } from "@/lib/env";

export const metadata: Metadata = {
  title: "連線診斷",
};

type CheckStatus = "pass" | "fail";

interface CheckResult {
  readonly label: string;
  readonly status: CheckStatus;
  readonly detail: string;
}

/**
 * 驗證 Supabase 連線是否可用。
 *
 * 此時資料表尚未建立（M1 才有 migration），因此不查任何表，
 * 改打 PostgREST 的根路徑：它會驗證 URL 與 anon key 是否成對且有效。
 */
async function checkSupabaseReachable(
  url: string,
  anonKey: string,
): Promise<CheckResult> {
  const label = "Supabase REST 端點";

  try {
    const response = await fetch(`${url}/rest/v1/`, {
      headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}` },
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });

    if (response.status === 401 || response.status === 403) {
      return {
        label,
        status: "fail",
        detail: `HTTP ${response.status}：URL 可連線，但 anon key 被拒絕。請確認兩者取自同一個 Supabase 專案。`,
      };
    }

    if (!response.ok) {
      return {
        label,
        status: "fail",
        detail: `HTTP ${response.status} ${response.statusText}`,
      };
    }

    return { label, status: "pass", detail: `HTTP ${response.status}` };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { label, status: "fail", detail: `無法連線：${message}` };
  }
}

export default async function HealthPage() {
  // 這一頁必須每次請求都重新檢查，不可在建置階段預先渲染
  await connection();

  const envResult = readSupabaseEnv();
  const checks: CheckResult[] = [];

  if (envResult.ok) {
    checks.push({
      label: "環境變數",
      status: "pass",
      detail: new URL(envResult.env.url).host,
    });
    checks.push(
      await checkSupabaseReachable(envResult.env.url, envResult.env.anonKey),
    );
  } else {
    checks.push({
      label: "環境變數",
      status: "fail",
      detail: `缺少 ${envResult.missing.join("、")}`,
    });
  }

  const allPassed = checks.every((check) => check.status === "pass");

  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col justify-center px-8 py-24">
      <span className="text-[0.65rem] tracking-[0.3em] text-ink-600 uppercase">
        M0
      </span>
      <h1 className="mt-6 text-3xl font-light text-ink-100">連線診斷</h1>
      <p className="mt-5 text-sm leading-relaxed text-ink-400">
        {allPassed
          ? "Supabase 連線正常，可以進入 M1 建立資料表。"
          : "設定尚未完成。請依下方項目修正後重新整理。"}
      </p>

      <ul className="mt-12 divide-y divide-ink-800 border-y border-ink-800">
        {checks.map((check) => (
          <li
            key={check.label}
            className="flex items-baseline gap-4 py-4 text-sm"
          >
            <span
              className={`inline-block size-1.5 shrink-0 translate-y-[-0.15em] rounded-full ${
                check.status === "pass" ? "bg-signal-500" : "bg-alert-500"
              }`}
              aria-hidden
            />
            <span className="w-40 shrink-0 text-ink-200">{check.label}</span>
            <span className="font-mono text-xs break-all text-ink-500">
              {check.detail}
            </span>
          </li>
        ))}
      </ul>

      {!envResult.ok ? (
        <p className="mt-8 text-xs leading-relaxed text-ink-500">
          本機開發請複製 .env.local.example 為 .env.local
          並填入值；部署環境請在 Vercel 專案的 Environment Variables 中設定。
          NEXT_PUBLIC_ 變數在建置階段內嵌，設定後需要重新部署才會生效。
        </p>
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
