import type { Metadata } from "next";
import { currentActor } from "@/lib/authz";
import { listDocuments } from "@/lib/repository";
import { listWikiPages } from "@/lib/wiki";
import { DocumentLibrary } from "@/components/document-library";

export const metadata: Metadata = { title: "Documents" };

export default async function DocumentsPage() {
  const actor = await currentActor();
  const [documents, wiki] = await Promise.all([listDocuments(), listWikiPages()]);
  return <DocumentLibrary initialDocuments={documents} wiki={wiki.map(({ slug, title, relativePath, summary, relatedBlocks }) => ({ slug, title, relativePath, summary, relatedBlocks }))} canEdit={actor?.role === "admin" || actor?.role === "editor"} />;
}
