import { supabase } from "@/lib/supabaseClient";

async function checkSupabaseConnection() {
  try {
    const { error } = await supabase.auth.getSession();
    if (error) return { ok: false, message: error.message };
    return { ok: true, message: "Connected" };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : "Unknown error" };
  }
}

export default async function Home() {
  const connection = await checkSupabaseConnection();

  return (
    <main className="min-h-screen flex flex-col items-center justify-center px-6 font-mono">
      <div className="max-w-lg w-full border border-white/10 rounded-lg p-8 space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-white">Livevival</h1>
          <p className="text-sm text-white/50 mt-1">RevivalTV Esports Live Score — build skeleton</p>
        </div>

        <div className="flex items-center gap-3 text-sm">
          <span
            className={`h-2.5 w-2.5 rounded-full ${
              connection.ok ? "bg-emerald-400" : "bg-red-500"
            }`}
          />
          <span className="text-white/80">
            Supabase connection: {connection.ok ? "OK" : `Failed (${connection.message})`}
          </span>
        </div>

        <p className="text-xs text-white/40 leading-relaxed">
          This is Phase 1 of the build — a working deploy target wired to Supabase.
          The real public site design comes in a later phase.
        </p>
      </div>
    </main>
  );
}
