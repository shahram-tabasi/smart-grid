'use client';

import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { Sidebar } from '@/components/Sidebar';
import { WelcomeScreen } from '@/components/WelcomeScreen';
import { useI18n } from '@/lib/i18n';
import { isSignedIn } from '@/lib/api';

/**
 * Application shell: decides whether the startup screen is shown, then renders the app.
 *
 * The welcome screen appears once per browser session rather than on every navigation — an
 * operations tool that replays a splash each time you click a link is an obstacle, not a feature.
 * sessionStorage (not localStorage) is deliberate: it comes back on the next launch, which is when
 * someone demonstrating the system actually wants it.
 */

/** Pages reachable without signing in. Everything else redirects to the login screen. */
const PUBLIC_PATHS = ['/login'];

const WELCOME_SEEN_KEY = 'simorgh_welcome_seen';

function welcomeAlreadySeen(): boolean {
  try {
    return window.sessionStorage.getItem(WELCOME_SEEN_KEY) === '1';
  } catch {
    // Private mode or blocked storage: show it. Not important enough to fail over.
    return false;
  }
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { lang } = useI18n();
  const isPublicPage = PUBLIC_PATHS.includes(pathname);

  // undefined = still deciding; avoids flashing the dashboard before the splash mounts.
  const [showWelcome, setShowWelcome] = useState<boolean | undefined>(undefined);
  const [authChecked, setAuthChecked] = useState(false);

  /**
   * Send anyone without a session to the sign-in page.
   *
   * The API is the real boundary and refuses unauthenticated reads, but without this the app still
   * rendered its full navigation and an empty dashboard to a stranger, which both looks broken and
   * reveals the shape of the system. The redirect carries the page they wanted so they land there
   * after signing in rather than always on the overview.
   *
   * This is a convenience, not a security control: the browser is not where access is decided, and
   * nothing here is trusted by the server.
   */
  useEffect(() => {
    const check = () => {
      if (isPublicPage) {
        setAuthChecked(true);
        return;
      }
      if (!isSignedIn()) {
        const next = encodeURIComponent(pathname || '/overview');
        window.location.replace(`/login?next=${next}`);
        return;
      }
      setAuthChecked(true);
    };

    check();

    // Also react to the session disappearing WITHOUT a navigation. Signing out in another tab, or
    // any code clearing the token, previously left this tab sitting on a fully populated dashboard
    // — the data stayed on screen until a background refresh happened to fail. `storage` fires in
    // the other tabs, and the focus check catches the case where this tab was in the background.
    window.addEventListener('storage', check);
    window.addEventListener('focus', check);
    return () => {
      window.removeEventListener('storage', check);
      window.removeEventListener('focus', check);
    };
  }, [pathname, isPublicPage]);

  /**
   * The startup screen comes FIRST — before the login form, not after it.
   *
   * The intended sequence is welcome → sign in → dashboard. That ordering is the right one: the
   * splash is where you learn the server is reachable and the database is up, and learning that
   * before typing a password is more useful than learning it after. So the welcome screen now plays
   * over the login page too, and by the time the form is revealed the system has already said
   * whether it can serve.
   *
   * It is decided on every navigation rather than once at mount. With an empty dependency array the
   * decision taken on the first page stuck forever, and since signing in is a client-side navigation
   * that does not remount this component, the screen vanished from the product entirely.
   *
   * The sessionStorage flag still limits it to once per browser session, so it plays before login
   * and does NOT play again on the way to the dashboard.
   */
  useEffect(() => {
    setShowWelcome(!welcomeAlreadySeen());
  }, [pathname, isPublicPage]);

  const dismiss = () => {
    try {
      window.sessionStorage.setItem(WELCOME_SEEN_KEY, '1');
    } catch {
      /* ignore */
    }
    setShowWelcome(false);
  };

  // Render nothing at all until both questions are settled, so a signed-out visitor never sees the
  // navigation flash past on the way to the login page.
  if (showWelcome === undefined || !authChecked) {
    return <div className="min-h-screen flex-1 bg-graphite-950" />;
  }

  // The login page gets no sidebar, and MUST take the full width of the flex body — without flex-1
  // this <main> shrank to the width of the sign-in card, which pinned the card against the left
  // edge of the window instead of centring it. The welcome screen renders over it, so the artwork
  // is what the visitor sees first and the form appears as it fades.
  if (isPublicPage) {
    return (
      <>
        {showWelcome && <WelcomeScreen onDone={dismiss} lang={lang === 'fa' ? 'fa' : 'en'} />}
        <main className="min-h-screen flex-1">{children}</main>
      </>
    );
  }

  return (
    <>
      {showWelcome && <WelcomeScreen onDone={dismiss} lang={lang === 'fa' ? 'fa' : 'en'} />}
      <Sidebar />
      <main className="min-h-screen flex-1 overflow-x-hidden">{children}</main>
    </>
  );
}
