import type { Metadata } from "next";
import { VisualLab } from "@/components/stage/VisualLab";

export const metadata: Metadata = {
  title: "主視覺測試台",
};

/**
 * 主視覺測試台。
 *
 * 刻意不放在主持人登入之後：這是拿來驗收河道的工具，
 * 而且圖片完全不上傳、只在瀏覽器裡處理，沒有任何資料會外流。
 * 要驗收的人不見得有後台帳號。
 */
export default function VisualLabPage() {
  return <VisualLab />;
}
