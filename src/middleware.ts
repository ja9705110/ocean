import { createServerClient } from "@supabase/ssr";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { readSupabaseEnv } from "@/lib/env";

/**
 * 續期主持人的登入 session。
 *
 * Server Component 無法寫入 cookie，token 續期必須在 middleware 完成，
 * 否則主持人會在活動進行到一半時被登出（@supabase/ssr 的明確警告）。
 *
 * 只掛在 /host 路徑：參與者端與大螢幕端是匿名的，不需要這道處理，
 * 也不該為它們付出每次請求的認證成本。
 */
export async function middleware(request: NextRequest) {
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
        for (const [key, headerValue] of Object.entries(headers)) {
          response.headers.set(key, headerValue);
        }
      },
    },
  });

  // 觸發讀取 session，過期時會在此續期並經由 setAll 寫回
  await supabase.auth.getUser();

  return response;
}

export const config = {
  matcher: ["/host/:path*"],
};
