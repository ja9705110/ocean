import type { Metadata } from "next";
import { QuizStage } from "@/components/quiz/QuizStage";

export const metadata: Metadata = {
  title: "海洋問答大螢幕",
};

/**
 * 遊戲的大螢幕。網址帶的是場次 id 而不是活動代碼——
 * 一場活動可以有好幾個場次（下午場、晚場、重玩一輪），
 * 用活動代碼會指不清楚是哪一個。
 *
 * 主持人不會手打這個網址，後台有按鈕直接開。
 */
export default async function GameStagePage({
  params,
}: PageProps<"/game/[sessionId]">) {
  const { sessionId } = await params;
  return <QuizStage sessionId={sessionId} />;
}
