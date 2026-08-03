import type { Metadata } from "next";
import { createClient } from "@supabase/supabase-js";

// Human-readable counterpart to /api/telegram-feed/[matchId] — built for
// the Rashid Slack/Discord integration: a per-match link that, when pasted
// anywhere (Slack, Discord, a browser tab), shows exactly what the
// Telegram bot posted. The JSON API route satisfies "read this
// programmatically"; it does nothing useful when a human just opens the
// link or pastes it into a chat app, since neither renders raw JSON and
// link-unfurling only ever reads a page's own OG/Twitter meta tags, never
// an API response. This page covers both: a plain readable list for a
// direct open, and generateMetadata below sets the unfurl preview to the
// single latest notification's own text, so Slack/Discord show that text
// directly in the link preview without anyone needing to click through.
export const dynamic = "force-dynamic";

type Notification = { message: string; notification_type: string | null; sent_at: string };

function supabaseClient() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
}

// Telegram messages are posted with parse_mode: "HTML" (see
// app/api/telegram/notify/route.ts) — strips that markup for the plain-text
// unfurl description and the <p> fallback rendering below, since neither
// context renders HTML.
function stripHtml(text: string): string {
  return text.replace(/<[^>]+>/g, "").trim();
}

async function loadNotifications(matchId: string): Promise<{ matchLabel: string | null; notifications: Notification[] }> {
  const supabase = supabaseClient();
  const { data: match } = await supabase
    .from("matches")
    .select("team_a:teams!matches_team_a_id_fkey(name), team_b:teams!matches_team_b_id_fkey(name)")
    .eq("id", matchId)
    .maybeSingle();
  const matchLabel = match
    ? [
        (match.team_a as unknown as { name: string } | null)?.name,
        (match.team_b as unknown as { name: string } | null)?.name,
      ]
        .filter(Boolean)
        .join(" vs ") || null
    : null;

  const { data: notifications } = await supabase
    .from("telegram_notifications")
    .select("message, notification_type, sent_at")
    .eq("match_id", matchId)
    .not("message", "is", null)
    .order("sent_at", { ascending: false });

  return { matchLabel, notifications: (notifications ?? []) as Notification[] };
}

export async function generateMetadata({ params }: { params: { matchId: string } }): Promise<Metadata> {
  const { matchLabel, notifications } = await loadNotifications(params.matchId);
  const latest = notifications[0];
  const title = matchLabel ? `Telegram feed — ${matchLabel} — Livevival` : "Telegram feed — Livevival";
  const description = latest
    ? stripHtml(latest.message)
    : "No Telegram notifications have been sent for this match yet.";

  return {
    title,
    description,
    openGraph: { title, description, type: "article" },
    twitter: { card: "summary", title, description },
  };
}

export default async function TelegramFeedPage({ params }: { params: { matchId: string } }) {
  const { matchLabel, notifications } = await loadNotifications(params.matchId);

  return (
    <main className="min-h-screen bg-ink text-paper px-6 py-10 max-w-xl mx-auto space-y-6">
      <header className="space-y-1">
        <p className="text-xs text-white/40 uppercase tracking-wider">Telegram feed</p>
        <h1 className="font-display font-light text-2xl tracking-tight">{matchLabel ?? "Match"}</h1>
      </header>

      {notifications.length === 0 ? (
        <p className="text-white/40 text-sm">No Telegram notifications have been sent for this match yet.</p>
      ) : (
        <div className="space-y-3">
          {notifications.map((n, i) => (
            <div key={i} className="lv-card-flush px-4 py-3 space-y-1">
              <p className="whitespace-pre-wrap text-sm">{stripHtml(n.message)}</p>
              <p className="text-[10px] text-white/30">{new Date(n.sent_at).toLocaleString()}</p>
            </div>
          ))}
        </div>
      )}

      <a href={`/match/${params.matchId}`} className="lv-nav-link inline-block">
        View full match page →
      </a>
    </main>
  );
}
