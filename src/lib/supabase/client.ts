"use client";

import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireSupabaseEnv } from "@/lib/env";

/**
 * 瀏覽器端的 Supabase client（anon key）。
 *
 * 三個前端入口都用這一支：
 * - 參與者端以匿名身分寫入 participants
 * - 大螢幕端與主持人端會在此之上帶入登入 session
 *
 * 刻意做成單例：Realtime 連線數是 Supabase 的計費與硬性上限資源，
 * 每次呼叫都新建 client 會在同一個分頁開出多條 WebSocket。
 */
let browserClient: SupabaseClient | undefined;

export function getSupabaseBrowserClient(): SupabaseClient {
  if (!browserClient) {
    const { url, anonKey } = requireSupabaseEnv();
    browserClient = createBrowserClient(url, anonKey);
  }

  return browserClient;
}
