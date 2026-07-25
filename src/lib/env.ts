/**
 * 環境變數的單一讀取入口。
 *
 * 重要：`process.env.NEXT_PUBLIC_*` 必須以字面量形式撰寫，
 * Next.js 才能在建置階段把值內嵌進 bundle。
 * 用變數動態組出 key（例如 process.env[name]）在瀏覽器端會拿到 undefined。
 */

const SUPABASE_URL: string | undefined = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY: string | undefined =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

/** Supabase 連線所需的公開設定 */
export interface SupabaseEnv {
  readonly url: string;
  readonly anonKey: string;
}

/** 讀取結果：成功時帶設定，失敗時列出缺少哪些變數 */
export type SupabaseEnvResult =
  | { readonly ok: true; readonly env: SupabaseEnv }
  | { readonly ok: false; readonly missing: readonly string[] };

/**
 * 讀取 Supabase 環境變數，不會拋出例外。
 * 給需要「優雅降級」的畫面使用（例如 /health 診斷頁）。
 */
export function readSupabaseEnv(): SupabaseEnvResult {
  const missing: string[] = [];

  if (!SUPABASE_URL) {
    missing.push("NEXT_PUBLIC_SUPABASE_URL");
  }
  if (!SUPABASE_ANON_KEY) {
    missing.push("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  }

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return { ok: false, missing };
  }

  return { ok: true, env: { url: SUPABASE_URL, anonKey: SUPABASE_ANON_KEY } };
}

/**
 * 讀取 Supabase 環境變數，缺少時立刻拋出。
 * 給「沒有設定就無法運作」的路徑使用，讓錯誤在啟動時就爆，
 * 而不是拖到使用者按下送出時才出現難以理解的 401。
 */
export function requireSupabaseEnv(): SupabaseEnv {
  const result = readSupabaseEnv();

  if (!result.ok) {
    throw new Error(
      `缺少必要的環境變數：${result.missing.join("、")}。` +
        `請參考 .env.local.example 建立 .env.local，或在 Vercel 專案設定中補上。`,
    );
  }

  return result.env;
}
