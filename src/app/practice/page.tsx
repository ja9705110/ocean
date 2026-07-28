import type { Metadata } from "next";
import { PracticeSession } from "@/components/game/PracticeSession";

export const metadata: Metadata = {
  title: "試划",
};

/**
 * 試划頁。不掛在任何活動底下，網址固定就是 /practice——
 * 主持人在場勘時可以直接用自己的手機開，不必先建活動、建場次。
 */
export default function PracticePage() {
  return <PracticeSession />;
}
