import type { Metadata } from "next";
import { Suspense } from "react";
import { CopilotWorkspace } from "@/components/copilot-workspace";

export const metadata: Metadata = { title: "Copilot" };

export default function CopilotPage() {
  return <Suspense fallback={<div className="surface-loading">Opening the evidence desk…</div>}><CopilotWorkspace /></Suspense>;
}
