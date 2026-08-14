import type { Metadata } from "next";
import { HostAuthGate } from "@/components/host/HostAuthGate";
import { SignatureSheet } from "@/components/host/SignatureSheet";

export const metadata: Metadata = {
  title: "簽到表",
};

export default async function SignatureSheetPage({
  params,
}: PageProps<"/host/[code]/signatures">) {
  const { code } = await params;

  return (
    <HostAuthGate>
      <SignatureSheet code={code.toUpperCase()} />
    </HostAuthGate>
  );
}
