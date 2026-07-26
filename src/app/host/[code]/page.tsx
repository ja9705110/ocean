import type { Metadata } from "next";
import { HostAuthGate } from "@/components/host/HostAuthGate";
import { HostConsole } from "@/components/host/HostConsole";

export const metadata: Metadata = {
  title: "控制台",
};

export default async function HostConsolePage({
  params,
}: PageProps<"/host/[code]">) {
  const { code } = await params;

  return (
    <HostAuthGate>
      <HostConsole code={code.toUpperCase()} />
    </HostAuthGate>
  );
}
