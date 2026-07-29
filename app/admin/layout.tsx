"use client";

import { useEffect, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";

type AdminInfo = { email: string; role: "super_admin" | "moderator" };

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [checking, setChecking] = useState(true);
  const [admin, setAdmin] = useState<AdminInfo | null>(null);

  useEffect(() => {
    let active = true;

    async function check() {
      const { data: sessionData } = await supabase.auth.getSession();
      const session = sessionData.session;

      if (!session) {
        if (active && pathname !== "/admin/login") router.push("/admin/login");
        if (active) setChecking(false);
        return;
      }

      const { data: adminRow } = await supabase
        .from("admins")
        .select("email, role")
        .eq("user_id", session.user.id)
        .maybeSingle();

      if (active) {
        setAdmin(adminRow as AdminInfo | null);
        setChecking(false);
      }
    }

    check();
    return () => {
      active = false;
    };
  }, [pathname, router]);

  async function handleLogout() {
    await supabase.auth.signOut();
    router.push("/admin/login");
  }

  if (pathname === "/admin/login") return <>{children}</>;

  if (checking) {
    return (
      <main className="min-h-screen flex items-center justify-center font-mono text-white/50 text-sm">
        Checking access...
      </main>
    );
  }

  if (!admin) {
    return (
      <main className="min-h-screen flex items-center justify-center font-mono text-white text-sm">
        Not authorized. This account has no admin role assigned.
      </main>
    );
  }

  return (
    <div className="min-h-screen font-mono">
      <header className="flex items-center justify-between px-6 py-4 border-b border-white/10">
        <div className="flex items-center gap-6">
          <span className="text-white text-sm">
            Signed in as <span className="text-white/60">{admin.email}</span> ({admin.role})
          </span>
          <nav className="flex gap-4 text-xs">
            <a href="/admin/teams" className="text-white/50 hover:text-white">Teams</a>
            <a href="/admin/matches" className="text-white/50 hover:text-white">Matches</a>
          </nav>
        </div>
        <button
          onClick={handleLogout}
          className="text-xs text-white/50 hover:text-white border border-white/10 rounded px-3 py-1.5"
        >
          Sign out
        </button>
      </header>
      <div className="p-6">{children}</div>
    </div>
  );
}
