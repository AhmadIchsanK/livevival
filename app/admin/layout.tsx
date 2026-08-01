"use client";

import { useEffect, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";
import { BrandMark } from "@/components/Brand";

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
      <main className="min-h-screen flex items-center justify-center text-white/50 text-sm">
        Checking access...
      </main>
    );
  }

  if (!admin) {
    return (
      <main className="min-h-screen flex items-center justify-center text-white text-sm">
        Not authorized. This account has no admin role assigned.
      </main>
    );
  }

  const navItems = [
    { href: "/admin/tournaments", label: "Tournaments" },
    { href: "/admin/teams", label: "Teams" },
    { href: "/admin/players", label: "Players" },
    { href: "/admin/heroes", label: "Heroes" },
    { href: "/admin/matches", label: "Matches" },
    { href: "/admin/streams", label: "Streams" },
  ];

  return (
    <div className="min-h-screen">
      <header className="flex items-center justify-between px-6 py-3.5 border-b border-white/10 bg-ink/80 backdrop-blur sticky top-0 z-20">
        <div className="flex items-center gap-8">
          <a href="/admin" className="flex items-center gap-2 shrink-0">
            <BrandMark className="h-6 w-6 text-signal" />
            <span className="font-display font-light text-sm tracking-tight text-paper hidden sm:inline">
              LIVE<span className="text-signal">VIVAL</span>{" "}
              <span className="text-white/30 text-[10px] uppercase tracking-widest align-middle ml-1">Admin</span>
            </span>
          </a>
          <nav className="flex gap-5 flex-wrap">
            {navItems.map((item) => (
              <a
                key={item.href}
                href={item.href}
                className={`lv-nav-link ${pathname?.startsWith(item.href) ? "text-signal" : ""}`}
              >
                {item.label}
              </a>
            ))}
          </nav>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-white/40 hidden md:inline">
            {admin.email} · <span className="text-white/25">{admin.role}</span>
          </span>
          <button onClick={handleLogout} className="lv-btn-ghost">
            Sign out
          </button>
        </div>
      </header>
      <div className="p-6">{children}</div>
    </div>
  );
}
