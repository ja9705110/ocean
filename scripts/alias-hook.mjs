/**
 * 讓檢查腳本認得 "@/..." 這種路徑別名。
 *
 * 專案裡的 src 全部用 @/ 匯入（tsconfig 的 paths），但那是打包器的事，
 * 原生 Node 不認。檢查腳本直接跑 .ts 原始碼，一旦被測的模組
 * 自己匯入了另一個模組，就會爆 Cannot find package '@/lib'。
 *
 * 與其為了能被測試而把 src 裡的匯入改成相對路徑（那會讓
 * 「哪些檔案可以被測」變成一條看不見的規則），不如在這裡補上解析。
 *
 * 副檔名要自己補：Node 的 ESM 不做副檔名推測，而 @/ 後面寫的是
 * 不含副檔名的模組路徑。
 */

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SRC = new URL("../src/", import.meta.url);
const CANDIDATES = [".ts", ".tsx", "/index.ts", "/index.tsx"];

export function resolve(specifier, context, next) {
  if (!specifier.startsWith("@/")) {
    return next(specifier, context);
  }

  const base = new URL(specifier.slice(2), SRC);
  for (const suffix of CANDIDATES) {
    const candidate = new URL(base.href + suffix);
    if (existsSync(fileURLToPath(candidate))) {
      return next(candidate.href, context);
    }
  }

  throw new Error(`路徑別名解析不到：${specifier}`);
}
