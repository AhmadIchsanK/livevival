import { NextRequest, NextResponse } from "next/server";
import { requireCaller } from "@/lib/adminApiAuth";
import { sendEmail } from "@/lib/email";

// Fired after an admin approves/rejects a contributor application (see
// app/admin/contributor-requests/page.tsx). The status change itself has
// already been written by the time this is called — email delivery is
// best-effort, so this always returns 200 with `sent: false` on failure
// rather than making the decision look like it didn't go through.
export async function POST(req: NextRequest) {
  const auth = await requireCaller(req, "admin");
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const body = await req.json().catch(() => null);
  const email: string | undefined = body?.email?.trim();
  const name: string | undefined = body?.name;
  const status: string | undefined = body?.status;
  const note: string | undefined = body?.note;
  if (!email || (status !== "approved" && status !== "rejected")) {
    return NextResponse.json({ error: "email and status ('approved'|'rejected') are required" }, { status: 400 });
  }

  const origin = req.nextUrl.origin;
  const subject =
    status === "approved" ? "Your LIVEVIVAL contributor application was approved" : "Your LIVEVIVAL contributor application";
  const html =
    status === "approved"
      ? `<p>Hi ${name ?? ""},</p><p>Your contributor application has been approved. You can sign in at <a href="${origin}/contributor/login">${origin}/contributor/login</a>.</p>`
      : `<p>Hi ${name ?? ""},</p><p>Your contributor application was not approved.${note ? ` Note: ${note}` : ""}</p>`;

  const result = await sendEmail(email, subject, html);
  return NextResponse.json({ ok: true, sent: result.sent, error: result.error });
}
