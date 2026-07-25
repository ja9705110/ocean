import type { Metadata } from "next";
import { MilestonePlaceholder } from "@/components/MilestonePlaceholder";

export const metadata: Metadata = {
  title: "主持人",
};

export default function HostIndexPage() {
  return (
    <MilestonePlaceholder
      milestone="M6"
      title="主持人"
      description="建立活動、設定世界模板與抽獎人數、產生 QR Code。此畫面將於 M6 實作。"
    />
  );
}
