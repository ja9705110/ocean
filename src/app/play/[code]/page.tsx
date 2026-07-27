import type { Metadata } from "next";
import { PlayerSeat } from "@/components/game/PlayerSeat";

export const metadata: Metadata = {
  title: "入座",
};

/**
 * 玩家入座頁。網址就是桌卡上的加入碼，掃到哪張就進哪一桌。
 * 代碼是否有效由 join_game RPC 判斷，這裡不預先查詢——
 * 少一次往返，現場 250 人同時掃碼時差別很明顯。
 */
export default async function PlayPage({ params }: PageProps<"/play/[code]">) {
  const { code } = await params;
  return <PlayerSeat joinCode={code.toUpperCase()} />;
}
