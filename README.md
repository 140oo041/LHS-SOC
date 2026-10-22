# Atlas

Atlas is an evidence-linked engineering workspace for the Coral SoC. It combines the interactive architecture model with a Git-versioned wiki (branches, change requests, reviewed merges), native task management, and a versioned document library. Grounded AI explanations are built but switched off.

## Local development

Requirements: Node.js 22+, npm, and Python 3.

```bash
cp .env.example .env.local
npm install --legacy-peer-deps
npm run dev
```

Without external services, development mode uses a local demo administrator, deterministic evidence search over the checked-in wiki, an in-memory Git repository seeded from `docs/` (so branches, edits, change requests, and merges all work), in-memory conversations/tasks/members, and temporary document storage. This makes every product surface reviewable without credentials.

## Production configuration

Every service below has a free tier that is enough for one team. Each feature stays off, with a plain message, until its settings are present; a half-configured one locks Atlas and names what is missing in the server log.

1. **Database (Neon).** Set `DATABASE_URL` (pooled) and `DATABASE_URL_UNPOOLED`. Vercel production builds apply pending migrations from `db/migrations/`; elsewhere run `npm run db:migrate`. Migrations must stay backward-compatible, because the previous deployment serves while the next one migrates.
2. **Sign-in (Google or Microsoft Entra ID).** Set the provider's `AUTH_*` values, `AUTH_SECRET`, and `ATLAS_ADMIN_EMAILS` (bootstrap administrators). Admit people with `ATLAS_ALLOWED_EMAIL_DOMAINS` or `ATLAS_ALLOWED_EMAILS`, or invite them in **Admin › People**, where roles are granted and revoked without a redeploy.
3. **Documents (Cloudflare R2 or any S3-compatible store).** Set `S3_*` and allow `GET`/`PUT` from the Atlas origin in the bucket's CORS rules. Browsers upload and download directly against the bucket; every upload of an existing document becomes a new revision.
4. **Wiki versioning (a GitHub App).** Set `GITHUB_*` as described in `.env.example`. Editors work on `atlas/…` branches, propose changes as change requests (pull requests), and an administrator merges each one after an approval from someone other than its author. Pushes from a clone show up through the webhook.
5. **Daily maintenance.** Set `CRON_SECRET`; `vercel.json` schedules `/api/cron/daily`, which expires old conversations, removes abandoned uploads, reconciles change requests, and finishes indexing.
6. **AI (off).** See the AI section of `.env.example`. The integration needs a code change to enable and a bounded budget to send anything.

Provider model identifiers are environment configuration rather than application constants. Generated images are returned to the requesting browser and are not stored by Atlas. Personal conversation threads expire after 30 days.

## Canonical sources

- `architecture/soc.yaml` is the architecture model. It is versioned on the same branches as the wiki: `/architecture?branch=atlas/…` shows a draft with its changes marked on the canvas (added green, changed amber, removed red), and editors change it on the canvas itself (drag blocks to move them, drag a corner to resize, drag from an edge handle to another block to connect, slide ports along edges, double-click empty space to add a block, Delete to remove, Ctrl/⌘+Z to undo) or from the inspector (edit fields, add a block inside, connect, remove). Each change becomes a structured edit that Atlas applies to the YAML without reformatting it, places automatically where it was not placed by hand (blocks added from a form go in free space; new ports face their peer), validates with the same cross-reference checks as `scripts/validate_model.py`, and commits to the branch. A change request can carry page and model edits together, and its page lists the model changes above the YAML diff.
- `/wiki/commits` (History, in the branch bar) draws every commit on every branch as a graph, like GitHub's network view; each commit opens to its model changes and diff. **Roll back to here** makes a new commit that sets `docs/` and `architecture/soc.yaml` back to that commit's versions; it never touches application code and never rewrites history, so a rollback can itself be rolled back. On a draft branch it commits directly; for the published version it goes on a new `atlas/rollback-…` branch and opens as a change request, so it is reviewed like any other change.
- `docs/` is the editable wiki. With the GitHub App configured, Atlas reads and edits it on the repository's branches; otherwise it reads the copy bundled with the deployment.
- `site/` remains the source for the embedded architecture viewer and read-only VS Code companion.
- `db/migrations/` defines collaborative application data as numbered migrations. Never edit one that has been applied; add the next number instead.

Run the complete verification suite with:

```bash
npm run check
```
