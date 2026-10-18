import NextAuth, { type NextAuthConfig } from "next-auth";
import Google from "next-auth/providers/google";
import MicrosoftEntraID from "next-auth/providers/microsoft-entra-id";
import type { Role } from "@/lib/domain";

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

function commaList(value?: string) {
  return new Set(
    (value ?? "")
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean),
  );
}

function roleForEmail(email?: string | null): Role {
  const normalized = email?.toLowerCase() ?? "";
  if (commaList(process.env.ATLAS_ADMIN_EMAILS).has(normalized)) return "admin";
  if (commaList(process.env.ATLAS_EDITOR_EMAILS).has(normalized)) return "editor";
  return "viewer";
}

export const authProviderIds = providers.map((provider) =>
  typeof provider === "function" ? "configured" : provider.id,
);

export const { handlers, auth, signIn, signOut } = NextAuth({
  secret:
    process.env.AUTH_SECRET ??
    (process.env.NODE_ENV !== "production" ? "atlas-development-only-secret" : undefined),
  providers,
  pages: { signIn: "/signin" },
  session: { strategy: "jwt", maxAge: 8 * 60 * 60 },
  callbacks: {
    async signIn({ user, profile }) {
      const email = user.email ?? (typeof profile?.email === "string" ? profile.email : null);
      if (!email) return false;
      const allowedDomains = commaList(process.env.ATLAS_ALLOWED_EMAIL_DOMAINS);
      if (!allowedDomains.size) return process.env.NODE_ENV !== "production";
      const domain = email.toLowerCase().split("@")[1];
      return allowedDomains.has(domain);
    },
    async jwt({ token, user }) {
      if (user?.email) token.role = roleForEmail(user.email);
      token.role ??= roleForEmail(token.email);
      return token;
    },
    async session({ session, token }) {
      session.user.role = (token.role as Role | undefined) ?? "viewer";
      return session;
    },
  },
});
