'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { isSignedIn, signOut } from '@/lib/api';

const ITEMS: { href: string; key: any; icon: string }[] = [
  { href: '/overview', key: 'nav_overview', icon: '▣' },
  { href: '/map', key: 'nav_map', icon: '◈' },
  { href: '/projects', key: 'nav_projects', icon: '⚙' },
  { href: '/live', key: 'nav_live', icon: '●' },
  { href: '/relays', key: 'nav_relays', icon: '⚡' },
  { href: '/comms', key: 'nav_comms', icon: '⇄' },
  { href: '/provisioning', key: 'nav_provisioning', icon: '＋' },
  { href: '/faults', key: 'nav_faults', icon: '✖' },
  { href: '/alarms', key: 'nav_alarms', icon: '⚠' },
  { href: '/ai', key: 'nav_ai', icon: '✦' },
  { href: '/work-orders', key: 'nav_workorders', icon: '☑' },
  { href: '/executive', key: 'nav_executive', icon: '◆' },
  { href: '/admin', key: 'nav_admin', icon: '⌂' },
];

export function Sidebar() {
  const pathname = usePathname();
  const { t } = useI18n();
  const [signedIn, setSignedIn] = useState(false);

  // Ask the api module rather than reading localStorage directly: the session may live in
  // sessionStorage instead (NEXT_PUBLIC_SESSION_ENDS_ON_CLOSE), and reading the wrong store would
  // show "Sign in" to someone who is perfectly well signed in.
  useEffect(() => {
    setSignedIn(isSignedIn());
  }, [pathname]);

  return (
    <aside className="flex h-screen w-60 shrink-0 flex-col border-r border-graphite-700 bg-graphite-900">
      <div className="flex items-start gap-2.5 border-b border-graphite-700 px-3 py-4">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/logo.png"
          alt=""
          className="mt-0.5 h-9 w-9 shrink-0 object-contain"
          onError={(e) => {
            // The logo is optional: if apps/web/public/logo.png is missing the header must still
            // render rather than showing a broken-image icon.
            (e.currentTarget as HTMLImageElement).style.display = 'none';
          }}
        />
        <div className="min-w-0">
          <div className="text-sm font-semibold leading-tight text-graphite-100">{t('appName')}</div>
          <div className="mt-0.5 text-[10px] leading-snug text-graphite-400">{t('tagline')}</div>
        </div>
      </div>
      <nav className="flex-1 space-y-0.5 overflow-y-auto px-2 py-3">
        {ITEMS.map((item) => {
          const active = pathname?.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors ${
                active ? 'bg-accent/15 text-accent' : 'text-graphite-300 hover:bg-graphite-800 hover:text-graphite-100'
              }`}
            >
              <span className="w-4 text-center">{item.icon}</span>
              {t(item.key)}
            </Link>
          );
        })}
      </nav>
      <div className="border-t border-graphite-700 px-4 py-3">
        {signedIn ? (
          <button
            onClick={() => signOut()}
            className="w-full rounded-lg border border-graphite-600 px-3 py-1.5 text-xs text-graphite-300 hover:bg-graphite-800"
          >
            {t('sign_out')}
          </button>
        ) : (
          <Link href="/login" className="block w-full rounded-lg bg-accent/20 px-3 py-1.5 text-center text-xs font-medium text-accent hover:bg-accent/30">
            {t('sign_in')}
          </Link>
        )}
        <div className="mt-2 text-[10px] text-graphite-500">Simorgh Grid v0.2 — Phase 2</div>
      </div>
    </aside>
  );
}
