import NextAuth, { type NextAuthConfig } from "next-auth";
import Google from "next-auth/providers/google";
import MicrosoftEntraID from "next-auth/providers/microsoft-entra-id";
import { isLocalDevelopment } from "@/lib/config";
import { lookupAccess, recordSignIn } from "@/lib/roles";

const providers: NextAuthConfig["providers"] = [];

if (process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET) {
  providers.push(
    Google({
      clientId: process.env.AUTH_GOOGLE_ID,
      clientSecret: process.env.AUTH_GOOGLE_SECRET,
    }),
  );
}

if (
  process.env.AUTH_MICROSOFT_ENTRA_ID_ID &&
  process.env.AUTH_MICROSOFT_ENTRA_ID_SECRET &&
  process.env.AUTH_MICROSOFT_ENTRA_ID_ISSUER
) {
  providers.push(
    MicrosoftEntraID({
      clientId: process.env.AUTH_MICROSOFT_ENTRA_ID_ID,
      clientSecret: process.env.AUTH_MICROSOFT_ENTRA_ID_SECRET,
      issuer: process.env.AUTH_MICROSOFT_ENTRA_ID_ISSUER,
    }),
  );
}

export const authProviderIds = providers.map((provider) =>
  typeof provider === "function" ? "configured" : provider.id,
);

export const { handlers, auth, signIn, signOut } = NextAuth({
  // The fallback is a literal in a public repository, so it may only ever sign
  // sessions on a developer's own machine. Anywhere else, a missing
  // AUTH_SECRET leaves this undefined and lib/config reports it.
  secret: process.env.AUTH_SECRET ?? (isLocalDevelopment() ? "atlas-development-only-secret" : undefined),
  providers,
  pages: { signIn: "/signin" },
  session: { strategy: "jwt", maxAge: 8 * 60 * 60 },
  callbacks: {
    // Admission is decided by lib/roles, the same rule every request uses,
    // so inviting someone from the admin console is enough to let them in.
    async signIn({ user, profile }) {
      const email = user.email ?? (typeof profile?.email === "string" ? profile.email : null);
      if (!email) return false;
      const access = await lookupAccess(email);
      if (!access.admitted) return false;
      await recordSignIn({ email, name: user.name, image: user.image });
      return true;
    },
    // The token carries identity only. Roles are looked up per request in
    // lib/authz, so a change or revocation applies on the next request
    // rather than when this 8-hour token expires.
  },
});
