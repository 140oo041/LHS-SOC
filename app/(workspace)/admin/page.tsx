import type { Metadata } from "next";
import { currentActor } from "@/lib/authz";
import { hasDatabase } from "@/lib/db";
import { latestKnowledgeRevision } from "@/lib/repository";
import { listMembers } from "@/lib/roles";
import { AdminConsole } from "@/components/admin-console";

export const metadata: Metadata = { title: "Administration" };

export default async function AdminPage() {
  const actor = await currentActor();
  const isAdmin = actor?.role === "admin";
  return (
    <AdminConsole
      actorRole={actor?.role ?? "viewer"}
      actorEmail={actor?.email ?? ""}
      initialRevision={await latestKnowledgeRevision()}
      // The member list is only fetched for an admin; nobody else may see it.
      initialMembers={isAdmin ? await listMembers() : []}
      persistent={hasDatabase()}
    />
  );
}
