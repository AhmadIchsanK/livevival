"use client";

import { useEffect, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";
import { BrandMark } from "@/components/Brand";
import { ThemeToggle } from "@/components/ThemeToggle";

type ContributorInfo = { id: string; name: string; status: "pending" | "approved" | "rejected"; decision_note: string | null };

export default function ContributorLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [checking, setChecking] = useState(true);
  const [contributor, setContributor] = useState<ContributorInfo | null>(null);
  const [noRow, setNoRow] = useState(false);

  useEffect(() => {
    let active = true;

    async function check() {
      const { data: sessionData } = await supabase.auth.getSession();
      const session = sessionData.session;

      if (!session) {
        if (active && pathname !== "/contributor/login") router.push("/contributor/login");
        if (active) setChecking(false);
        return;
      }

      const { data: row } = await supabase
        .from("contributors")
        .select("id, name, status, decision_note")
        .eq("user_id", session.user.id)
        .maybeSingle();

      if (active) {
        setContributor(row as ContributorInfo | null);
        setNoRow(!row);
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
    router.push("/contributor/login");
  }

  if (pathname === "/contributor/login") return <>{children}</>;

  if (checking) {
    return (
      <main className="min-h-screen flex items-center justify-center text-white/50 text-sm">
        Checking access...
      </main>
    );
  }

  if (noRow) {
    return (
      <main className="min-h-screen flex flex-col items-center justify-center gap-3 text-white text-sm text-center px-6">
        <p>No contributor application found for this account.</p>
        <a href="/apply-contributor" className="text-signal hover:underline">
          Apply as a contributor
        </a>
      </main>
    );
  }

  if (contributor?.status === "pending") {
    return (
      <main className="min-h-screen flex flex-col items-center justify-center gap-2 text-white text-sm text-center px-6">
        <p className="text-lg font-semibold">Application pending</p>
        <p className="text-white/60">An admin hasn't reviewed your application yet — check back later.</p>
        <button onClick={handleLogout} className="lv-btn-ghost mt-4">
          Sign out
        </button>
      </main>
    );
  }

  if (contributor?.status === "rejected") {
    return (
      <main className="min-h-screen flex flex-col items-center justify-center gap-2 text-white text-sm text-center px-6 max-w-sm mx-auto">
        <p className="text-lg font-semibold">Application not approved</p>
        {contributor.decision_note && <p className="text-white/60">{contributor.decision_note}</p>}
        <button onClick={handleLogout} className="lv-btn-ghost mt-4">
          Sign out
        </button>
      </main>
    );
  }

  const navItems = [
    { href: "/contributor/tournaments", label: "Tournaments" },
    { href: "/contributor/teams", label: "Teams" },
    { href: "/contributor/players", label: "Players" },
    { href: "/contributor/heroes", label: "Heroes" },
    { href: "/contributor/matches", label: "Matches" },
    { href: "/contributor/streams", label: "Streams" },
    { href: "/contributor/requests", label: "My Requests" },
    { href: "/contributor/change-password", label: "Change Password" },
  ];

  return (
    <div className="min-h-screen">
      <header className="flex items-center justify-between px-6 py-3.5 border-b border-white/10 bg-ink/80 backdrop-blur sticky top-0 z-20">
        <div className="flex items-center gap-8">
          <a href="/contributor" className="flex items-center gap-2 shrink-0">
            <BrandMark className="h-6 w-6" />
            <span className="font-display font-light text-sm tracking-tight text-paper hidden sm:inline">
              LIVE<span className="text-signal">VIVAL</span>{" "}
              <span className="text-white/30 text-[10px] uppercase tracking-widest align-middle ml-1">Contributor</span>
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
          <span className="text-xs text-white/40 hidden md:inline">{contributor?.name}</span>
          <a href="/" className="lv-nav-link" target="_blank" rel="noopener noreferrer">
            View site ↗
          </a>
          <ThemeToggle />
          <button onClick={handleLogout} className="lv-btn-ghost">
            Sign out
          </button>
        </div>
      </header>
      <div className="p-6">{children}</div>
    </div>
  );
}
