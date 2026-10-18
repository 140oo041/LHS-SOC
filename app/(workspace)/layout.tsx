import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { currentActor } from "@/lib/authz";

export default async function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  const actor = await currentActor();
  if (!actor) redirect("/signin");
  return <AppShell actor={actor}>{children}</AppShell>;
}
