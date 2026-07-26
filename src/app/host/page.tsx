import type { Metadata } from "next";
import { EventList } from "@/components/host/EventList";
import { HostAuthGate } from "@/components/host/HostAuthGate";

export const metadata: Metadata = {
  title: "主持人",
};

export default function HostIndexPage() {
  return (
    <HostAuthGate>
      <EventList />
    </HostAuthGate>
  );
}
