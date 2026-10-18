import Image from "next/image";
import { redirect } from "next/navigation";
import { auth, authProviderIds, signIn } from "@/auth";

export default async function SignInPage() {
  const session = await auth();
  if (session) redirect("/architecture");
  const demoAvailable = process.env.NODE_ENV !== "production" && process.env.ATLAS_DEMO_AUTH !== "false";
  return (
    <main className="signin-page">
      <section className="signin-story">
        <div className="signin-brand"><Image src="/logo.png" width={48} height={48} alt="" /><span>Atlas</span></div>
        <h1>Find the design decision behind the diagram.</h1>
        <p>Architecture, evidence, explanations, project work, and documents stay attached to the same stable engineering concepts.</p>
        <div className="signin-route" aria-hidden="true">
          <span>Question</span><i /><span>Evidence</span><i /><span>Decision</span><i /><span>Work</span>
        </div>
      </section>
      <section className="signin-panel">
        <div>
          <h2>Enter Coral SoC</h2>
          <p>Use your organization identity. Atlas does not manage passwords.</p>
          {authProviderIds.includes("google") && (
            <form action={async () => { "use server"; await signIn("google", { redirectTo: "/architecture" }); }}>
              <button className="signin-action" type="submit">Continue with Google</button>
            </form>
          )}
          {authProviderIds.includes("microsoft-entra-id") && (
            <form action={async () => { "use server"; await signIn("microsoft-entra-id", { redirectTo: "/architecture" }); }}>
              <button className="signin-action" type="submit">Continue with Microsoft</button>
            </form>
          )}
          {!authProviderIds.length && !demoAvailable && <p className="inline-error">No identity provider is configured. Ask an Atlas administrator to configure organization SSO.</p>}
          {demoAvailable && <a className="signin-action demo" href="/architecture">Open local development workspace</a>}
          <small>Access is limited to approved organization domains. Activity may be recorded for security and support.</small>
        </div>
      </section>
    </main>
  );
}
