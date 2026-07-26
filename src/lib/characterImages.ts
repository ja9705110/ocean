import { requireSupabaseEnv } from "@/lib/env";

/**
 * 角色圖片網址解析。
 * Storage 是公開 bucket，直接組 CDN 網址，不需簽名。
 *
 * 每位角色有兩種尺寸（M2 上傳時一併產生）：
 * - 原始路徑（512px）：手機端顯示自己的角色
 * - @256 後綴（256px）：大螢幕用，350 張全量載入時記憶體才安全
 */

export function characterImageUrl(imagePath: string): string {
  const { url } = requireSupabaseEnv();
  return `${url}/storage/v1/object/public/characters/${imagePath}`;
}

/** 大螢幕用的 256px 版本網址 */
export function characterSmallImageUrl(imagePath: string): string {
  const smallPath = imagePath.replace(/\.(webp|png)$/, "@256.$1");
  return characterImageUrl(smallPath);
}
