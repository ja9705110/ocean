import type { Metadata } from "next";
import { HostAuthGate } from "@/components/host/HostAuthGate";
import { ArtworkSheet } from "@/components/host/ArtworkSheet";

export const metadata: Metadata = {
  title: "彩繪成果",
};

export default async function ArtworkSheetPage({
  params,
}: PageProps<"/host/[code]/artworks">) {
  const { code } = await params;

  return (
    <HostAuthGate>
      <ArtworkSheet code={code.toUpperCase()} />
    </HostAuthGate>
  );
}
