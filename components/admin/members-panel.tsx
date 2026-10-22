"use client";

import { useState } from "react";
import type { Role } from "@/lib/domain";
import type { AccessSource, Member } from "@/lib/roles";

const sourceLabels: Record<AccessSource, string> = {
  bootstrap: "ATLAS_ADMIN_EMAILS",
  membership: "granted here",
  environment: "environment list",
  domain: "allowed domain",
  development: "local development",
  revoked: "revoked",
  none: "not admitted",
};

const ROLES: Role[] = ["admin", "editor", "viewer"];

export function MembersPanel({ initialMembers, actorEmail, persistent }: { initialMembers: Member[]; actorEmail: string; persistent: boolean }) {
  const [members, setMembers] = useState(initialMembers);
  const [draft, setDraft] = useState<{ email: string; role: Role }>({ email: "", role: "editor" });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function send(url: string, init: RequestInit, success: string) {
    setBusy(true);
    setMessage("");
    const response = await fetch(url, { ...init, headers: { "Content-Type": "application/json" } });
    const data = await response.json().catch(() => ({}));
    if (response.ok) {
      setMembers(data.members);
      setMessage(success);
    } else {
      setMessage(data.error ?? "That change was not saved.");
    }
    setBusy(false);
  }

  const memberUrl = (email: string) => `/api/admin/members/${encodeURIComponent(email)}`;

  return (
    <section className="admin-section members-section">
      <div>
        <h2>People</h2>
        <p>Roles apply from each person&apos;s next request. Revoking someone signs them out even if their domain is allowed. Administrators named in ATLAS_ADMIN_EMAILS can only be changed there.</p>
        {!persistent && <p><strong>No database is configured</strong>, so changes here last only until the server restarts.</p>}
      </div>
      <div className="members-body">
        <form
          className="member-invite"
          onSubmit={(event) => {
            event.preventDefault();
            void send("/api/admin/members", { method: "POST", body: JSON.stringify(draft) }, `${draft.email} can now sign in as ${draft.role}.`).then(() =>
              setDraft({ email: "", role: draft.role }),
            );
          }}
        >
          <label>Email<input type="email" required value={draft.email} onChange={(event) => setDraft({ ...draft, email: event.target.value })} placeholder="name@company.com" /></label>
          <label>Role<select value={draft.role} onChange={(event) => setDraft({ ...draft, role: event.target.value as Role })}>{ROLES.map((role) => <option key={role} value={role}>{role}</option>)}</select></label>
          <button className="primary-button" type="submit" disabled={busy}>Add person</button>
        </form>
        <table className="member-table">
          <thead><tr><th>Person</th><th>Role</th><th>Access from</th><th>Last sign-in</th><th><span className="sr-only">Actions</span></th></tr></thead>
          <tbody>
            {members.map((member) => {
              const locked = member.source === "bootstrap";
              return (
                <tr key={member.email} className={member.admitted ? undefined : "member-denied"}>
                  <td><strong>{member.name}</strong><small>{member.email}{member.email === actorEmail ? " (you)" : ""}</small></td>
                  <td>
                    {locked || !member.admitted ? (
                      member.admitted ? member.role : "—"
                    ) : (
                      <select
                        aria-label={`Role for ${member.email}`}
                        value={member.role}
                        disabled={busy}
                        onChange={(event) => void send(memberUrl(member.email), { method: "PATCH", body: JSON.stringify({ role: event.target.value }) }, `${member.email} is now ${event.target.value}.`)}
                      >
                        {ROLES.map((role) => <option key={role} value={role}>{role}</option>)}
                      </select>
                    )}
                  </td>
                  <td>{sourceLabels[member.source]}</td>
                  <td>{member.lastSignInAt ? new Date(member.lastSignInAt).toLocaleDateString() : "never"}</td>
                  <td>
                    {!locked && member.admitted && (
                      <button
                        type="button"
                        className="text-button"
                        disabled={busy}
                        onClick={() => {
                          if (window.confirm(`Revoke access for ${member.email}? They are signed out on their next request.`)) {
                            void send(memberUrl(member.email), { method: "DELETE" }, `${member.email} can no longer sign in.`);
                          }
                        }}
                      >
                        Revoke
                      </button>
                    )}
                    {!locked && !member.admitted && (
                      <button
                        type="button"
                        className="text-button"
                        disabled={busy}
                        onClick={() => void send(memberUrl(member.email), { method: "PATCH", body: JSON.stringify({ role: "viewer" }) }, `${member.email} can sign in again as viewer.`)}
                      >
                        Restore as viewer
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
            {!members.length && <tr><td colSpan={5}>Nobody has signed in yet.</td></tr>}
          </tbody>
        </table>
        {message && <p className="admin-message" role="status">{message}</p>}
      </div>
    </section>
  );
}
