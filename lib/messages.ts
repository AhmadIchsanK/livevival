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

// BCP-47 locale for Intl/toLocale* date formatting, so months and weekdays
// render in the chosen language ("Agustus 2026", "Kam, 20 Agu").
export function localeFor(lang: Lang): string {
  return lang === "id" ? "id-ID" : "en-US";
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
  "common.loadingShort": { en: "Loading...", id: "Memuat..." },
  "players.searchPlaceholder": { en: "Search players or teams...", id: "Cari pemain atau tim..." },
  "teams.searchPlaceholder": { en: "Search teams, location, or region...", id: "Cari tim, lokasi, atau region..." },
  "teams.loadingRoster": { en: "Loading roster...", id: "Memuat roster..." },
  "tournaments.searchPlaceholder": { en: "Search tournaments...", id: "Cari turnamen..." },
  "heroes.searchPlaceholder": { en: "Search heroes...", id: "Cari hero..." },

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
  "match.phase.waiting": { en: "Waiting", id: "Menunggu" },
  "match.phase.draftInProgress": { en: "Draft in progress", id: "Draft berlangsung" },
  "match.phase.matchFinished": { en: "Match finished", id: "Pertandingan selesai" },
  "match.phase.technicalPause": { en: "Technical pause", id: "Jeda teknis" },
  "match.hideChat": { en: "Hide chat", id: "Sembunyikan chat" },
  "match.chat": { en: "Chat", id: "Chat" },
  "match.copyLink": { en: "Copy link", id: "Salin link" },
  "match.copied": { en: "Copied!", id: "Tersalin!" },
  "match.startsIn": { en: "Starts in {t}", id: "Mulai dalam {t}" },
  "match.recapWon": { en: "Recap — {name} won", id: "Rekap — {name} menang" },
  "match.notStartedYet": { en: "Not started yet", id: "Belum dimulai" },
  "match.watchGameN": { en: "Watch Game {n} ↗ (link not embeddable)", id: "Tonton Game {n} ↗ (link nggak bisa di-embed)" },
  "match.portrait": { en: "Portrait", id: "Potret" },
  "match.landscape": { en: "Landscape", id: "Lanskap" },
  "match.mvpLabel": { en: "Game {n} MVP:", id: "MVP Game {n}:" },
  "match.svpLabel": { en: "SVP:", id: "SVP:" },
  "match.forfeitWin": {
    en: "{name} win by default — this match was decided without any games being played.",
    id: "{name} menang WO — match ini ditentukan tanpa ada game yang dimainkan.",
  },
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
  "home.calendarLegend": { en: "Green = at least one match that day.", id: "Hijau = ada minimal satu match hari itu." },
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
  "search.placeholder": { en: "Search tournaments, players, teams, heroes, matches...", id: "Cari turnamen, pemain, tim, hero, pertandingan..." },
  "search.button": { en: "Search", id: "Cari" },
  "search.filterByCategory": { en: "Filter by category", id: "Saring berdasarkan kategori" },
  "search.cat.match": { en: "Match", id: "Pertandingan" },
  "search.cat.tournament": { en: "Tournament", id: "Turnamen" },
  "search.cat.player": { en: "Player", id: "Pemain" },
  "search.cat.team": { en: "Team", id: "Tim" },
  "search.cat.hero": { en: "Hero", id: "Hero" },
  "toggle.language": { en: "Language", id: "Bahasa" },
  "toggle.switchToId": { en: "Switch to Bahasa Indonesia", id: "Ganti ke Bahasa Indonesia" },
  "toggle.switchToEn": { en: "Switch to English", id: "Ganti ke Bahasa Inggris" },

  // ── Admin (high-visibility surfaces; extended incrementally) ──────────
  "admin.dashboard": { en: "Dashboard", id: "Dasbor" },
  "admin.dash.refresh": { en: "↻ Refresh", id: "↻ Segarkan" },
  "admin.dash.refreshing": { en: "Refreshing…", id: "Menyegarkan…" },
  "admin.dash.liveNow": { en: "Live now", id: "Sedang Live" },
  "admin.dash.upcoming": { en: "Upcoming", id: "Akan Datang" },
  "admin.dash.finished": { en: "Finished", id: "Selesai" },
  "admin.dash.streamCoverage": { en: "Stream link coverage (30d)", id: "Cakupan link stream (30h)" },
  "admin.dash.chartVolume": { en: "Match volume — last 12 months", id: "Volume pertandingan — 12 bulan terakhir" },
  "admin.dash.chartParticipation": { en: "Tournament participation — top 10 by match count", id: "Partisipasi turnamen — top 10 berdasarkan jumlah match" },
  "admin.dash.chartTier": { en: "Matches by tournament tier", id: "Pertandingan per tier turnamen" },
  "admin.dash.chartPlatform": { en: "Platform engagement — streams by platform", id: "Engagement platform — stream per platform" },
  "admin.dash.matches": { en: "Matches", id: "Pertandingan" },
  "admin.unknown": { en: "Unknown", id: "Nggak diketahui" },
  "admin.unknownTournament": { en: "Unknown tournament", id: "Turnamen nggak diketahui" },
  "admin.matches": { en: "Matches", id: "Pertandingan" },
  "admin.commentary": { en: "Commentary", id: "Komentar" },
  "admin.liveConsole": { en: "Live console", id: "Konsol Live" },
  // Admin nav group titles
  "admin.grp.overview": { en: "Overview", id: "Ikhtisar" },
  "admin.grp.content": { en: "Content", id: "Konten" },
  "admin.grp.automation": { en: "Automation", id: "Otomasi" },
  "admin.grp.community": { en: "Community", id: "Komunitas" },
  "admin.grp.account": { en: "Account", id: "Akun" },
  // Admin nav item labels
  "admin.nav.tournaments": { en: "Tournaments", id: "Turnamen" },
  "admin.nav.teams": { en: "Teams", id: "Tim" },
  "admin.nav.players": { en: "Players", id: "Pemain" },
  "admin.nav.heroes": { en: "Heroes", id: "Hero" },
  "admin.nav.matches": { en: "Matches", id: "Pertandingan" },
  "admin.nav.streams": { en: "Streams", id: "Streaming" },
  "admin.nav.momentTemplates": { en: "Moment Templates", id: "Template Momen" },
  "admin.nav.autoCommentary": { en: "Auto-commentary", id: "Auto-komentar" },
  "admin.nav.telegram": { en: "Telegram Notifications", id: "Notifikasi Telegram" },
  "admin.nav.dataSync": { en: "Data Sync", id: "Sinkron Data" },
  "admin.nav.manageContributors": { en: "Manage Contributors", id: "Kelola Kontributor" },
  "admin.nav.contributorRequests": { en: "Contributor Requests", id: "Permintaan Kontributor" },
  "admin.nav.changeLog": { en: "Change Log", id: "Riwayat Perubahan" },
  "admin.nav.changePassword": { en: "Change Password", id: "Ganti Password" },
  "admin.nav.manageAdmins": { en: "Manage Admins", id: "Kelola Admin" },
  "admin.teamKills": { en: "Team kills", id: "Team kills" },
  "admin.teamKillsColon": { en: "Team kills:", id: "Team kills:" },
  "admin.liveScoreboard": { en: "Live scoreboard", id: "Papan Skor Live" },
  "admin.netWorth": { en: "Net worth", id: "Net Worth" },
  "admin.objectives": { en: "Objectives", id: "Objektif" },
  "admin.momentTimeline": { en: "Moment Timeline", id: "Linimasa Momen" },
  "admin.logMoment": { en: "Log a moment", id: "Catat Momen" },
  "admin.resetTitle": { en: "Reset this team's kill override (fall back to the summed player kills)", id: "Reset override kill tim ini (balik ke jumlah kill pemain)" },
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
