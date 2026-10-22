import type { Metadata } from "next";
import { currentActor } from "@/lib/authz";
import { maxDirectUploadBytes } from "@/lib/config";
import { hasDatabase } from "@/lib/db";
import { canAdmin, canEdit } from "@/lib/domain";
import { listDocuments } from "@/lib/documents";
import { listWikiPages } from "@/lib/wiki";
import { DocumentLibrary } from "@/components/document-library";

export const metadata: Metadata = { title: "Documents" };

const NO_STORAGE =
  "No database is attached, so managed attachments cannot be kept yet. The repository sources below are " +
  "read straight from Git and are unaffected. Set DATABASE_URL and S3_* to enable uploads.";

export default async function DocumentsPage() {
  const actor = await currentActor();
  const editor = actor ? canEdit(actor.role) : false;
  // Editors also receive archived documents so they can restore them.
  const [documents, wiki] = await Promise.all([listDocuments({ includeArchived: editor }), listWikiPages()]);
  return (
    <DocumentLibrary
      initialDocuments={documents}
      wiki={wiki.map(({ slug, title, relativePath, summary, relatedBlocks }) => ({ slug, title, relativePath, summary, relatedBlocks }))}
      canEdit={editor}
      canAdmin={actor ? canAdmin(actor.role) : false}
      maxBytes={maxDirectUploadBytes()}
      notice={hasDatabase() ? undefined : NO_STORAGE}
    />
  );
}
