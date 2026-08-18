// Livevival i18n dictionary. Two languages: English ("en") and Bahasa Indonesia
// ("id"). The ID copy is intentionally semi-formal Gen-Z Indonesian — natural
// and casual, not stiff textbook Bahasa, but still readable to everyone.
//
// RULES (per product spec):
//  - In-game MLBB terms stay English: Lord, Turtle, Tower, MVP, SVP, KDA, K/D/A,
//    Savage, Maniac, Draft, Net Worth is translated but "Lord/Turtle" are not.
//  - Proper nouns from DATA are never in this file, so they always stay original:
//    hero names, player IGNs, team names, tournament names.
//  - Keys are dot-namespaced by surface (nav.*, common.*, match.*, admin.*).
//  - Values may contain {placeholders}, interpolated by t() at call time.

export type Lang = "en" | "id";

// Cookie the language choice is persisted under (read by the server layout to
// seed the initial render, written client-side by the toggle).
export const LANG_COOKIE = "livevival_lang";

export function normalizeLang(v: string | undefined | null): Lang {
  return v === "id" ? "id" : "en";
}

type Entry = { en: string; id: string };

export const MESSAGES = {
  // ── Navigation / menu ────────────────────────────────────────────────
  "nav.matches": { en: "Matches", id: "Pertandingan" },
  "nav.tournaments": { en: "Tournaments", id: "Turnamen" },
  "nav.players": { en: "Players", id: "Pemain" },
  "nav.teams": { en: "Teams", id: "Tim" },
  "nav.heroes": { en: "Heroes", id: "Hero" },
  "nav.applyContributor": { en: "Apply as Contributor", id: "Daftar jadi Kontributor" },
  "nav.rss": { en: "RSS Feed", id: "RSS Feed" },
  "nav.menu": { en: "Menu", id: "Menu" },
  "nav.openMenu": { en: "Open menu", id: "Buka menu" },
  "nav.home": { en: "Home", id: "Beranda" },

  // ── Common states / actions ──────────────────────────────────────────
  "common.live": { en: "LIVE", id: "LIVE" },
  "common.upcoming": { en: "Upcoming", id: "Akan Datang" },
  "common.finished": { en: "Finished", id: "Selesai" },
  "common.ongoing": { en: "Ongoing", id: "Berlangsung" },
  "common.scheduled": { en: "Scheduled", id: "Terjadwal" },
  "common.loading": { en: "Loading…", id: "Memuat…" },
  "common.today": { en: "Today", id: "Hari ini" },
  "common.tomorrow": { en: "Tomorrow", id: "Besok" },
  "common.yesterday": { en: "Yesterday", id: "Kemarin" },
  "common.vs": { en: "vs", id: "vs" },
  "common.viewAll": { en: "View all", id: "Lihat semua" },
  "common.back": { en: "Back", id: "Kembali" },
  "common.retry": { en: "Try again", id: "Coba lagi" },
  "common.share": { en: "Share", id: "Bagikan" },
  "common.search": { en: "Search", id: "Cari" },
  "common.noData": { en: "No data yet", id: "Belum ada data" },
  "common.watchLive": { en: "Watch live", id: "Tonton live" },
  "common.bestOf": { en: "Best of {n}", id: "Best of {n}" },

  // ── Public match page ────────────────────────────────────────────────
  "match.game": { en: "Game", id: "Game" },
  "match.netWorth": { en: "Net Worth", id: "Net Worth" },
  "match.winProbability": { en: "Win Probability", id: "Peluang Menang" },
  "match.liveEstimate": { en: "live estimate", id: "estimasi live" },
  "match.teamKills": { en: "team kills", id: "team kills" },
  "match.scoreboard": { en: "Scoreboard", id: "Papan Skor" },
  "match.statistics": { en: "Statistics", id: "Statistik" },
  "match.noStatsYet": { en: "No stats yet.", id: "Belum ada statistik." },
  "match.screenshots": { en: "Screenshots", id: "Tangkapan Layar" },
  "match.est": { en: "est.", id: "estimasi" },
  "match.objectives": { en: "Objectives", id: "Objektif" },
  "match.pickBanOrder": { en: "Pick & Ban Order", id: "Urutan Pick & Ban" },
  "match.draftAnalysis": { en: "Draft analysis", id: "Analisis Draft" },
  "match.draft": { en: "Draft", id: "Draft" },
  "match.draftRecap": { en: "Draft recap", id: "Rekap Draft" },
  "match.momentTimeline": { en: "Moment Timeline", id: "Linimasa Momen" },
  "match.keyMoments": { en: "Key Moments", id: "Momen Penting" },
  "match.gameOngoing": { en: "Game ongoing", id: "Game berlangsung" },
  "match.gameFinished": { en: "Game finished", id: "Game selesai" },
  "match.player": { en: "Player", id: "Pemain" },
  "match.role": { en: "Role", id: "Role" },
  "match.hero": { en: "Hero", id: "Hero" },
  "match.leadsGold": { en: "{team} leads +{amount} gold", id: "{team} unggul +{amount} gold" },
  "match.goldLeadOverTime": { en: "Gold lead over the game timer", id: "Keunggulan gold sepanjang waktu game" },
  "match.up": { en: "up", id: "unggul" },
  "match.down": { en: "down", id: "tertinggal" },
  "match.seriesScore": { en: "Series score", id: "Skor seri" },
  "match.wins": { en: "wins", id: "menang" },
  "match.mvp": { en: "MVP", id: "MVP" },
  "match.svp": { en: "SVP", id: "SVP" },
  "match.draftComplete": { en: "Draft complete", id: "Draft selesai" },
  "match.notStarted": { en: "Not started", id: "Belum mulai" },
  "match.pick": { en: "Pick", id: "Pick" },
  "match.ban": { en: "Ban", id: "Ban" },
  "match.map": { en: "Map", id: "Map" },
  "match.coveredManualVision": {
    en: "This match is covered using a manual vision system. Numbers might not be accurate. We will keep improving our system for better result.",
    id: "Pertandingan ini diliput pakai sistem visual manual. Angkanya bisa aja kurang akurat. Kami bakal terus benahin sistemnya biar makin oke.",
  },

  // ── Matches list / home ──────────────────────────────────────────────
  "matches.title": { en: "Matches", id: "Pertandingan" },
  "matches.liveNow": { en: "Live now", id: "Sedang Live" },
  "matches.upcomingMatches": { en: "Upcoming matches", id: "Pertandingan Mendatang" },
  "matches.recentResults": { en: "Recent results", id: "Hasil Terbaru" },
  "matches.noLive": { en: "No live matches right now", id: "Nggak ada match live sekarang" },
  "matches.noUpcoming": { en: "No upcoming matches scheduled", id: "Belum ada match terjadwal" },
  "matches.searchPlaceholder": { en: "Search team or tournament...", id: "Cari tim atau turnamen..." },
  "matches.noneHere": { en: "No matches here.", id: "Nggak ada match di sini." },
  "matches.loadingMatches": { en: "Loading matches...", id: "Memuat pertandingan..." },
  "matches.sortEarliest": { en: "Date: earliest first", id: "Tanggal: paling awal dulu" },
  "matches.sortLatest": { en: "Date: latest first", id: "Tanggal: paling akhir dulu" },
  "home.tagline": {
    en: "Live MLBB esports scores, drafts, and analytics",
    id: "Skor, draft, dan analitik esports MLBB secara live",
  },
  "home.liveNow": { en: "Live now", id: "Sedang Live" },
  "home.upcomingNextDays": { en: "Upcoming — next {n} days", id: "Mendatang — {n} hari ke depan" },
  "home.noUpcomingInDays": {
    en: "No upcoming matches scheduled in the next {n} days.",
    id: "Belum ada match terjadwal dalam {n} hari ke depan.",
  },
  "common.tbd": { en: "TBD", id: "TBD" },
  "common.liveBadge": { en: "Live", id: "Live" },
  "home.noLiveCheckUpcoming": {
    en: "No matches live right now — check upcoming below.",
    id: "Nggak ada match live sekarang — cek yang mendatang di bawah.",
  },

  // ── Language / theme toggles ─────────────────────────────────────────
  "toggle.language": { en: "Language", id: "Bahasa" },
  "toggle.switchToId": { en: "Switch to Bahasa Indonesia", id: "Ganti ke Bahasa Indonesia" },
  "toggle.switchToEn": { en: "Switch to English", id: "Ganti ke Bahasa Inggris" },

  // ── Admin (high-visibility surfaces; extended incrementally) ──────────
  "admin.dashboard": { en: "Dashboard", id: "Dasbor" },
  "admin.matches": { en: "Matches", id: "Pertandingan" },
  "admin.commentary": { en: "Commentary", id: "Komentar" },
  "admin.liveConsole": { en: "Live console", id: "Konsol Live" },
  "admin.teamKills": { en: "Team kills", id: "Team kills" },
  "admin.reset": { en: "Reset", id: "Reset" },
  "admin.save": { en: "Save", id: "Simpan" },
  "admin.cancel": { en: "Cancel", id: "Batal" },
  "admin.edit": { en: "Edit", id: "Ubah" },
  "admin.delete": { en: "Delete", id: "Hapus" },
  "admin.add": { en: "Add", id: "Tambah" },
} as const satisfies Record<string, Entry>;

export type MsgKey = keyof typeof MESSAGES;

// Pure lookup usable from anywhere (server or client), given an explicit lang.
export function translate(lang: Lang, key: MsgKey, vars?: Record<string, string | number>): string {
  const entry = MESSAGES[key] as Entry | undefined;
  let s = entry ? entry[lang] ?? entry.en : (key as string);
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
  return s;
}
