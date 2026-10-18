import type { Metadata } from "next";
import { ArchitectureWorkspace } from "@/components/architecture-workspace";

export const metadata: Metadata = { title: "Architecture" };

export default async function ArchitecturePage({ searchParams }: { searchParams: Promise<{ selected?: string }> }) {
  const { selected } = await searchParams;
  return <ArchitectureWorkspace selected={selected} />;
}
