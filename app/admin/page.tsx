export default function AdminHome() {
  return (
    <div className="text-white space-y-2">
      <h1 className="text-lg font-bold">Admin dashboard</h1>
      <p className="text-sm text-white/50">
        Use the nav above to manage matches, teams, and livestreams. Liquipedia
        import runs automatically on a schedule (see .github/workflows) — the
        Groq vision worker (Railway) drives auto-detected matches, and any
        match can be switched to manual control from its live console.
      </p>
    </div>
  );
}
