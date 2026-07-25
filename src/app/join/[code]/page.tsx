import type { Metadata } from "next";
import { MilestonePlaceholder } from "@/components/MilestonePlaceholder";

export const metadata: Metadata = {
  title: "加入世界",
};

export default async function JoinPage({ params }: PageProps<"/join/[code]">) {
  const { code } = await params;

  return (
    <MilestonePlaceholder
      milestone="M2"
      title="加入世界"
      description="參與者輸入姓名、畫出角色、命名並送出。此畫面將於 M2 實作。"
      detail={`活動代碼 ${code}`}
    />
  );
}
