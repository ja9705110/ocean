import type { Metadata } from "next";
import { MilestonePlaceholder } from "@/components/MilestonePlaceholder";

export const metadata: Metadata = {
  title: "世界大螢幕",
};

export default async function StagePage({
  params,
}: PageProps<"/stage/[code]">) {
  const { code } = await params;

  return (
    <MilestonePlaceholder
      milestone="M3"
      title="世界大螢幕"
      description="PixiJS 渲染的共創世界。M3 建立背景與環境動畫，M4 接上 Realtime，M7 加入抽獎演出。"
      detail={`活動代碼 ${code}`}
    />
  );
}
