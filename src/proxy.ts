import { createServerClient } from "@supabase/ssr";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { readSupabaseEnv } from "@/lib/env";

/**
 * 續期主持人的登入 session。
 *
 * Server Component 無法寫入 cookie，token 續期必須在這一層完成，
 * 否則主持人會在活動進行到一半時被登出（@supabase/ssr 的明確警告）。
 *
 * 只掛在 /host 路徑：參與者端與大螢幕端是匿名的，不需要這道處理，
 * 也不該為它們付出每次請求的認證成本。
 *
 * 檔名是 proxy 而不是 middleware：Next.js 16 起 middleware 這個慣例已棄用
 * （見 node_modules/next/dist/docs 的 version-16 升級指南）。
 */

/**
 * 續期最多等這麼久，超過就直接放行。
 *
 * 這一條是整個網站的單點故障：這裡只要卡住，/host 底下所有請求都會
 * 一起卡住，最後由平台回 504——畫面上看到的是整個後台掛掉，
 * 而實際上只是 Supabase 慢了一下。
 *
 * 續期失敗的代價很小：頁面本來就會自己檢查登入狀態，最壞是要求重新登入。
 * 拿「偶爾要重登」換「絕不整站掛掉」，這個交換沒有懸念。
 */
const REFRESH_TIMEOUT_MS = 2500;

export async function proxy(request: NextRequest) {
  const envResult = readSupabaseEnv();
  if (!envResult.ok) {
    return NextResponse.next();
  }

  const response = NextResponse.next({ request });
  const { url, anonKey } = envResult.env;

  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet, headers) {
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
        // 帶有 auth cookie 的回應絕不可被 CDN 快取，
        // 否則某位使用者的 session 會被送給另一位
        for (const [key, headerValue] of Object.entries(headers ?? {})) {
          response.headers.set(key, headerValue);
        }
      },
    },
  });

  // 觸發讀取 session，過期時會在此續期並經由 setAll 寫回。
  // 逾時的話那個 Promise 仍在背景跑，之後呼叫 setAll 只會寫到一個
  // 已經送出的回應上，是無害的空操作。
  try {
    await Promise.race([
      supabase.auth.getUser(),
      new Promise((resolve) => setTimeout(resolve, REFRESH_TIMEOUT_MS)),
    ]);
  } catch {
    // 續期失敗不該擋下請求，頁面自己會處理未登入的狀況
  }

  return response;
}

export const config = {
  matcher: ["/host/:path*"],
};
