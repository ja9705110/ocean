import type { Metadata } from "next";
import { MilestonePlaceholder } from "@/components/MilestonePlaceholder";

export const metadata: Metadata = {
  title: "控制台",
};

export default async function HostConsolePage({
  params,
}: PageProps<"/host/[code]">) {
  const { code } = await params;

  return (
    <MilestonePlaceholder
      milestone="M6"
      title="活動控制台"
      description="開放與鎖定報名、參與者清單與隱藏功能於 M6 實作；抽獎控制於 M7 實作。"
      detail={`活動代碼 ${code}`}
    />
  );
}
