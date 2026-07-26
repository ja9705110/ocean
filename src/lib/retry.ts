/**
 * 指數退避重試（規格第 16 節第 1 點：場館 Wi-Fi 不穩是最大風險）。
 * 預設 2s → 4s → 8s → 16s，全部失敗才把最後一個錯誤拋出。
 */

const DEFAULT_DELAYS_MS: readonly number[] = [2000, 4000, 8000, 16000];

export interface RetryOptions {
  readonly delaysMs?: readonly number[];
  /** 每次準備重試前呼叫，attempt 從 1 起算，用於更新「正在重試」的 UI */
  readonly onRetry?: (attempt: number, error: unknown) => void;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const delays = options.delaysMs ?? DEFAULT_DELAYS_MS;
  let lastError: unknown;

  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      const delay = delays[attempt];
      if (delay === undefined) {
        break;
      }

      options.onRetry?.(attempt + 1, error);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}
