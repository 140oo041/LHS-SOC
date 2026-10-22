"use server";

import { cookies } from "next/headers";
import { demoAuthEnabled } from "@/lib/config";
import { DEMO_ACCOUNT_COOKIE, DEMO_ACCOUNTS } from "@/lib/demo-accounts";

/** Local development only: become another of the demo accounts. */
export async function switchDemoAccount(email: string): Promise<{ ok: boolean }> {
  if (!demoAuthEnabled() || !DEMO_ACCOUNTS.some((account) => account.email === email)) return { ok: false };
  (await cookies()).set(DEMO_ACCOUNT_COOKIE, email, { httpOnly: true, sameSite: "lax", path: "/" });
  return { ok: true };
}
