export default function AdminHome() {
  return (
    <div className="text-white space-y-2">
      <h1 className="lv-heading text-lg">Admin dashboard</h1>
      <p className="text-sm text-white/50">
        Use the nav above to manage tournaments, teams, players, heroes, matches, and streams.
        Liquipedia import runs automatically on a schedule (see .github/workflows), and an
        always-on poller (Railway) keeps live/imminent matches close to real-time. A match can be
        switched to local-OCR (admin PC) control from its live console at any time.
      </p>
    </div>
  );
}
