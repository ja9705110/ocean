"use client";

import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";

/**
 * 主持人登入閘門。
 *
 * 使用 Supabase 的 email + 密碼認證。刻意不用 magic link：
 * 活動現場的網路與信箱收信都不可靠，主持人被登出時需要能立刻重新登入，
 * 不能依賴「去收一封信」。
 */

interface HostAuthGateProps {
  /**
   * 登入後顯示的內容。
   * 刻意用一般的 ReactNode 而非 render prop：Server Component 不能
   * 把函式當 props 傳給 Client Component，頁面就得整個變成 client。
   */
  readonly children: ReactNode;
}

type Mode = "signin" | "signup";

export function HostAuthGate({ children }: HostAuthGateProps) {
  const [ready, setReady] = useState(false);
  const [email, setEmail] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("signin");
  const [formEmail, setFormEmail] = useState("");
  const [formPassword, setFormPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const supabase = getSupabaseBrowserClient();
    let active = true;

    supabase.auth
      .getUser()
      .then(({ data }) => {
        if (active) {
          setEmail(data.user?.email ?? null);
          setReady(true);
        }
      })
      .catch(() => {
        if (active) {
          setReady(true);
        }
      });

    const { data: subscription } = supabase.auth.onAuthStateChange(
      (_event, session) => {
        setEmail(session?.user.email ?? null);
      },
    );

    return () => {
      active = false;
      subscription.subscription.unsubscribe();
    };
  }, []);

  const submit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setBusy(true);
      setError(null);
      setMessage(null);

      const supabase = getSupabaseBrowserClient();

      try {
        if (mode === "signup") {
          const { data, error: signUpError } = await supabase.auth.signUp({
            email: formEmail.trim(),
            password: formPassword,
          });
          if (signUpError) {
            throw new Error(signUpError.message);
          }
          // 專案若開啟信箱驗證，此時尚無 session
          if (!data.session) {
            setMessage("註冊成功。請到信箱收驗證信，完成後回來登入。");
            setMode("signin");
          }
        } else {
          const { error: signInError } = await supabase.auth.signInWithPassword(
            {
              email: formEmail.trim(),
              password: formPassword,
            },
          );
          if (signInError) {
            throw new Error(signInError.message);
          }
        }
      } catch (submitError) {
        setError(
          submitError instanceof Error
            ? submitError.message
            : String(submitError),
        );
      } finally {
        setBusy(false);
      }
    },
    [mode, formEmail, formPassword],
  );

  const signOut = useCallback(async () => {
    await getSupabaseBrowserClient().auth.signOut();
  }, []);

  /*
   * 後台一律套淺色。
   *
   * 深色是給大螢幕與手機的：那些是在暗場裡投影、或活動中看一眼就收。
   * 後台是活動前坐在明亮房間裡盯著它打字、拉滑桿、核名冊，
   * 深底淺字看久了眼睛撐不住。
   *
   * 包在這裡而不是每一頁自己加：以後多開的後台頁面自動就是淺色的。
   * 實際換色是在 globals.css 的 .host-light 裡把 ink 色票整組翻過來，
   * 所有既有的 class 都不用改。
   */
  if (!ready) {
    return (
      <div className="host-light">
        <main className="flex min-h-dvh items-center justify-center">
          <span className="size-2 animate-breathe rounded-full bg-signal-500" />
        </main>
      </div>
    );
  }

  if (email) {
    return (
      <div className="host-light">
        <div className="fixed top-0 right-0 z-10 flex items-center gap-4 px-8 py-5 text-xs text-ink-500">
          <span>{email}</span>
          <button
            type="button"
            onClick={() => void signOut()}
            className="underline-offset-4 transition-colors duration-300 ease-world hover:text-ink-300 hover:underline"
          >
            登出
          </button>
        </div>
        {children}
      </div>
    );
  }

  return (
    <div className="host-light">
      <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-8 py-16">
        <p className="text-xs tracking-[0.35em] text-ink-500 uppercase">Host</p>
        <h1 className="mt-6 text-3xl font-light text-ink-100">主持人</h1>
        <p className="mt-4 text-sm leading-relaxed text-ink-400">
          {mode === "signin" ? "登入以建立與管理活動。" : "建立主持人帳號。"}
        </p>

        <form className="mt-12" onSubmit={(e) => void submit(e)}>
          <label htmlFor="host-email" className="block text-sm text-ink-300">
            電子郵件
          </label>
          <input
            id="host-email"
            type="email"
            required
            autoComplete="email"
            value={formEmail}
            onChange={(e) => setFormEmail(e.target.value)}
            className="mt-3 w-full rounded-lg border border-ink-700 bg-ink-900 px-4 py-3 text-base text-ink-100 outline-none transition-colors duration-300 ease-world focus:border-signal-500"
          />

          <label
            htmlFor="host-password"
            className="mt-6 block text-sm text-ink-300"
          >
            密碼
          </label>
          <input
            id="host-password"
            type="password"
            required
            minLength={8}
            autoComplete={
              mode === "signin" ? "current-password" : "new-password"
            }
            value={formPassword}
            onChange={(e) => setFormPassword(e.target.value)}
            className="mt-3 w-full rounded-lg border border-ink-700 bg-ink-900 px-4 py-3 text-base text-ink-100 outline-none transition-colors duration-300 ease-world focus:border-signal-500"
          />
          {mode === "signup" ? (
            <p className="mt-2 text-xs text-ink-600">至少 8 個字元。</p>
          ) : null}

          {error ? (
            <p className="mt-6 text-xs leading-relaxed text-alert-500">
              {error}
            </p>
          ) : null}
          {message ? (
            <p className="mt-6 text-xs leading-relaxed text-signal-400">
              {message}
            </p>
          ) : null}

          <button
            type="submit"
            disabled={busy}
            className="mt-8 w-full rounded-lg bg-signal-500 py-3.5 text-base font-medium text-ink-950 transition-opacity duration-300 ease-world disabled:opacity-40"
          >
            {busy ? "處理中" : mode === "signin" ? "登入" : "建立帳號"}
          </button>
        </form>

        <button
          type="button"
          onClick={() => {
            setMode(mode === "signin" ? "signup" : "signin");
            setError(null);
            setMessage(null);
          }}
          className="mt-6 text-xs text-ink-500 underline-offset-4 transition-colors duration-300 ease-world hover:text-ink-300 hover:underline"
        >
          {mode === "signin" ? "還沒有帳號？建立一個" : "已有帳號？前往登入"}
        </button>
      </main>
    </div>
  );
}
