import type { Metadata } from "next";
import { HostAuthGate } from "@/components/host/HostAuthGate";
import { CookieSheet } from "@/components/host/CookieSheet";

export const metadata: Metadata = {
  title: "餅乾照片",
};

export default async function CookieSheetPage({
  params,
}: PageProps<"/host/[code]/cookies">) {
  const { code } = await params;

  return (
    <HostAuthGate>
      <CookieSheet code={code.toUpperCase()} />
    </HostAuthGate>
  );
}
