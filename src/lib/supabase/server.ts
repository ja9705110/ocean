import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireSupabaseEnv } from "@/lib/env";

/**
 * 伺服器端的 Supabase client（anon key + 使用者 cookie session）。
 *
 * 目前僅供主持人端（M6）的 SSR 使用。每次請求都必須新建一個，
 * 絕對不可跨請求共用，否則會把某位使用者的 session 洩漏給另一位。
 *
 * 注意：這裡用的仍是 anon key，權限一樣受 RLS 約束。
 * service role key 不會出現在這支檔案裡。
 */
export async function createSupabaseServerClient(): Promise<SupabaseClient> {
  const cookieStore = await cookies();
  const { url, anonKey } = requireSupabaseEnv();

  return createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // 從 Server Component 呼叫時無法寫入 cookie，這是預期行為。
          // token 續期改由 middleware 負責（M6 導入登入流程時一併建立）。
        }
      },
    },
  });
}
