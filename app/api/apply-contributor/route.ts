import { NextRequest, NextResponse } from "next/server";
import { requireServiceRoleClient } from "@/lib/adminApiAuth";

// Public contributor application — no caller auth (anyone can apply).
//
// Creates the auth user server-side via the service role with
// email_confirm: true, so the account works immediately regardless of this
// Supabase project's "Confirm email" setting, then inserts the pending
// contributors row. Previously this ran as a client-side supabase.auth.signUp()
// followed by a client insert relying on RLS (auth.uid() = user_id) — if the
// project has email confirmation turned on there'd be no session yet at
// insert time and the flow would silently fail. Routing through the service
// role sidesteps that entirely: apply -> admin approves -> log in, nothing
// else required. Deliberate simplification for throwaway/testing accounts;
// see the PR description for the tradeoff.
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const name: string | undefined = body?.name?.trim();
  const email: string | undefined = body?.email?.trim();
  const password: string | undefined = body?.password;
  const socialPlatform: string | undefined = body?.social_platform;
  const socialHandle: string | undefined = body?.social_handle?.trim();
  if (!name || !email || !socialPlatform || !socialHandle) {
    return NextResponse.json({ error: "name, email, social_platform, and social_handle are required" }, { status: 400 });
  }
  if (!password || password.length < 6) {
    return NextResponse.json({ error: "password is required and must be at least 6 characters" }, { status: 400 });
  }

  const svc = requireServiceRoleClient();
  if ("error" in svc) return NextResponse.json({ error: svc.error }, { status: svc.status });

  const { data: existing } = await svc.client.from("contributors").select("id").ilike("email", email).maybeSingle();
  if (existing) {
    return NextResponse.json({ error: "An application with this email already exists." }, { status: 409 });
  }

  const { data: created, error: createError } = await svc.client.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (createError || !created?.user) {
    return NextResponse.json({ error: createError?.message ?? "Failed to create account" }, { status: 502 });
  }

  const { error: insertError } = await svc.client.from("contributors").insert({
    user_id: created.user.id,
    name,
    social_platform: socialPlatform,
    social_handle: socialHandle,
    email,
  });
  if (insertError) {
    return NextResponse.json({ error: insertError.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
