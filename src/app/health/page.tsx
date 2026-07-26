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
 * 描述部署中實際使用的 key，用來一眼分辨「新 key 沒部署上去」
 * 與「key 部署了但被拒絕」。anon / publishable key 本來就是公開資訊，
 * 顯示開頭片段沒有安全疑慮。
 */
function describeKey(anonKey: string): string {
  const kind = anonKey.startsWith("sb_publishable_")
    ? "新版 publishable key"
    : anonKey.startsWith("eyJ")
      ? "舊版 JWT anon key"
      : "無法辨識的格式";
  return `${kind}，開頭 ${anonKey.slice(0, 18)}…，長度 ${anonKey.length}`;
}

/**
 * 驗證連線、key 與 M1 migration，一次到位：直接查 events 表的示範活動。
 *
 * 刻意不打 PostgREST 根路徑：那是 OpenAPI 結構描述端點，新版 key 制度下
 * 只有 secret key 能存取（publishable key 會收到 401 Secret API key required），
 * 拿它當健康檢查會對正確的設定誤報失敗。
 *
 * 表不存在（未跑 migration）、種子不存在（未跑 seed）、key 被拒絕
 * 會各自給出不同提示。
 */
async function checkDatabaseReady(
  url: string,
  anonKey: string,
): Promise<CheckResult> {
  const label = "資料庫連線與資料表";

  try {
    const response = await fetch(
      `${url}/rest/v1/events?select=code,name,status,participant_count&code=eq.DEMO01`,
      {
        headers: { apikey: anonKey },
        cache: "no-store",
        signal: AbortSignal.timeout(8000),
      },
    );

    if (!response.ok) {
      const body = (await response.text()).slice(0, 160);

      if (response.status === 401 || response.status === 403) {
        return {
          label,
          status: "fail",
          detail: `HTTP ${response.status}：key 被拒絕。伺服器回應：${body || "(無內文)"}`,
        };
      }

      if (body.includes("PGRST205") || body.includes("does not exist")) {
        return {
          label,
          status: "fail",
          detail:
            "找不到 events 表：M1 的 SQL（m1_reset_and_rebuild.sql）尚未在 Supabase 執行成功。",
        };
      }

      return {
        label,
        status: "fail",
        detail: `HTTP ${response.status}，伺服器回應：${body || "(無內文)"}`,
      };
    }

    const rows: unknown = await response.json();

    if (!Array.isArray(rows) || rows.length === 0) {
      return {
        label,
        status: "fail",
        detail:
          "events 表存在，但找不到示範活動 DEMO01。請執行 M1 的種子 SQL。",
      };
    }

    const event = rows[0] as {
      name?: string;
      status?: string;
      participant_count?: number;
    };

    return {
      label,
      status: "pass",
      detail: `DEMO01「${event.name ?? "?"}」status=${event.status ?? "?"}，${event.participant_count ?? 0} 位參與者`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { label, status: "fail", detail: `無法查詢：${message}` };
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
    // 本專案的 Supabase 停用了舊版 JWT key，部署中的 key 必須是
    // sb_publishable_ 開頭；看到舊格式即表示新值沒有存成功或尚未重新部署
    checks.push({
      label: "使用中的 key",
      status: envResult.env.anonKey.startsWith("sb_publishable_")
        ? "pass"
        : "fail",
      detail: describeKey(envResult.env.anonKey),
    });
    checks.push(
      await checkDatabaseReady(envResult.env.url, envResult.env.anonKey),
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
        M1
      </span>
      <h1 className="mt-6 text-3xl font-light text-ink-100">連線診斷</h1>
      <p className="mt-5 text-sm leading-relaxed text-ink-400">
        {allPassed
          ? "Supabase 連線與資料庫都正常，可以進入 M2。"
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
