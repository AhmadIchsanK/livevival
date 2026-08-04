// Best-effort transactional email via Resend's REST API — the only email
// need in this app that isn't already covered by Supabase Auth's own
// templates (invite/recovery). No SDK dependency, just a plain fetch.
//
// RESEND_API_KEY / RESEND_FROM_EMAIL aren't provisioned in this deployment
// as of this writing. Every call site treats a failed/unconfigured send as
// non-fatal — the underlying DB action (approve/reject/promote) already
// succeeded — and surfaces `sent: false` so the caller can show a soft
// notice instead of blocking on it.
export async function sendEmail(to: string, subject: string, html: string): Promise<{ sent: boolean; error?: string }> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM_EMAIL;
  if (!apiKey || !from) {
    return { sent: false, error: "Email not configured — set RESEND_API_KEY and RESEND_FROM_EMAIL." };
  }

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to, subject, html }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { sent: false, error: body?.message ?? `Resend API error (${res.status})` };
    }
    return { sent: true };
  } catch (err) {
    return { sent: false, error: err instanceof Error ? err.message : "Failed to send email." };
  }
}
