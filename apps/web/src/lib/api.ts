const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

const ACCESS_KEY = 'simorgh_token';
const REFRESH_KEY = 'simorgh_refresh_token';

/**
 * API client with automatic token refresh.
 *
 * The access token lives two hours. Before this, the browser stored only that token and threw away
 * the refresh token the login response already contained, so every session died after two hours
 * with a bare "Invalid or expired token" and no way back except clearing storage by hand.
 *
 * Now a 401 triggers one refresh attempt and the original request is retried. Concurrent requests
 * share a single in-flight refresh — otherwise a dashboard that fires six requests on load would
 * start six refreshes, and the rotating refresh token means five of them would fail.
 */

/**
 * Where the session is kept, and therefore how long it survives.
 *
 * Default (localStorage): the session outlives the browser. Closing and reopening lands you back on
 * the dashboard without signing in again — convenient, and the reason a returning user sees the
 * welcome screen and then the dashboard with no login in between. That is a kept session, not a
 * caching fault.
 *
 * NEXT_PUBLIC_SESSION_ENDS_ON_CLOSE=true switches to sessionStorage: the session dies with the
 * browser window, so every launch is welcome → sign in → dashboard. That is the stricter and more
 * appropriate choice for a shared workstation or a control room, where a walk-up user should not
 * inherit whoever used the machine last. It is off by default because turning it on signs everyone
 * out whenever they close the browser, which should be a decision, not a surprise.
 *
 * Either way the refresh token still expires after 30 days server-side, and the access token after
 * two hours — this only decides whether the browser keeps them across restarts.
 */
const SESSION_ENDS_ON_CLOSE = process.env.NEXT_PUBLIC_SESSION_ENDS_ON_CLOSE === 'true';

function store(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return SESSION_ENDS_ON_CLOSE ? window.sessionStorage : window.localStorage;
  } catch {
    return null; // private mode / storage blocked
  }
}

function read(key: string): string | null {
  try {
    return store()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function write(key: string, value: string | null) {
  const s = store();
  if (!s) return;
  try {
    if (value === null) s.removeItem(key);
    else s.setItem(key, value);
  } catch {
    /* storage unavailable — the session simply will not persist */
  }
}

function getToken(): string | null {
  return read(ACCESS_KEY);
}

/** Shared across callers so parallel 401s cause exactly one refresh. */
let refreshInFlight: Promise<string | null> | null = null;

async function refreshAccessToken(): Promise<string | null> {
  if (refreshInFlight) return refreshInFlight;

  const refreshToken = read(REFRESH_KEY);
  if (!refreshToken) return null;

  refreshInFlight = (async () => {
    try {
      const res = await fetch(`${API_URL}/api/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });
      if (!res.ok) {
        // The refresh token is dead too — clear both so the app stops retrying with bad credentials.
        clearToken();
        return null;
      }
      const data = await res.json();
      setToken(data.accessToken, data.refreshToken);
      return data.accessToken as string;
    } catch {
      return null;
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}

/**
 * Seconds remaining on a JWT, read from its `exp` claim. Returns null if the token is unreadable.
 *
 * This is a display/refresh-timing aid only. The token is never trusted here — the API verifies the
 * signature on every request. Decoding is deliberately hand-rolled so the browser bundle does not
 * pull in a JWT library to read one number.
 */
function secondsUntilExpiry(token: string): number | null {
  try {
    const part = token.split('.')[1];
    if (!part) return null;
    const json = atob(part.replace(/-/g, '+').replace(/_/g, '/'));
    const exp = JSON.parse(json)?.exp;
    if (typeof exp !== 'number') return null;
    return exp - Math.floor(Date.now() / 1000);
  } catch {
    return null;
  }
}

/**
 * Refresh before the request rather than after a rejection.
 *
 * Reactive refresh alone was not enough. Most read endpoints are open in demo mode, so a browser
 * left overnight kept rendering pages perfectly with a long-dead access token and only discovered
 * the problem at the moment the operator pressed a button — which is exactly the "Invalid or
 * expired token" that got reported. Renewing a token that is expired or within a minute of it means
 * the failure never reaches the screen.
 */
async function ensureFreshToken(): Promise<string | null> {
  const token = getToken();
  if (!token) return null;
  const left = secondsUntilExpiry(token);
  if (left !== null && left < 60) return (await refreshAccessToken()) ?? token;
  return token;
}

/** Thrown when the session cannot be recovered, so callers can send the user to sign in. */
export class SessionExpiredError extends Error {
  constructor() {
    super('Your session has expired. Please sign in again.');
    this.name = 'SessionExpiredError';
  }
}

export async function apiFetch<T = any>(path: string, init?: RequestInit): Promise<T> {
  const send = async (token: string | null) =>
    fetch(`${API_URL}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(init?.headers ?? {}),
      },
      cache: 'no-store',
    });

  let res = await send(await ensureFreshToken());

  // One refresh, one retry. Only when we actually had a token: a 401 on an anonymous request means
  // the endpoint needs sign-in, not that a session expired.
  if (res.status === 401 && getToken()) {
    const fresh = await refreshAccessToken();
    if (fresh) {
      res = await send(fresh);
    } else {
      clearToken();
      throw new SessionExpiredError();
    }
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    if (res.status === 401) throw new SessionExpiredError();
    // Preserve structured detail (e.g. the `problems` array from path validation) for callers that
    // want to render each item, while keeping `message` readable for those that do not.
    const err = new Error(body.error || `Request failed: ${res.status}`) as Error & {
      status?: number;
      problems?: string[];
      body?: unknown;
    };
    err.status = res.status;
    if (Array.isArray(body.problems)) err.problems = body.problems;
    err.body = body;
    throw err;
  }

  // 204 and other empty responses would otherwise throw on .json().
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export function apiUrl(path: string) {
  return `${API_URL}${path}`;
}

export function wsUrl() {
  return process.env.NEXT_PUBLIC_WS_URL || 'ws://localhost:4000/ws';
}

export function setToken(token: string, refreshToken?: string) {
  write(ACCESS_KEY, token);
  if (refreshToken) write(REFRESH_KEY, refreshToken);
}

export function clearToken() {
  write(ACCESS_KEY, null);
  write(REFRESH_KEY, null);
}

/**
 * End the session and leave the page.
 *
 * Clearing the token was not enough, and this was a real hole: "Sign out" only emptied storage and
 * flipped a label in the sidebar. The dashboard stayed exactly where it was, still showing every
 * project, relay, fault and alarm it had already loaded, until a background refresh eventually
 * failed and printed "Your session has expired" over the top of the data it was supposed to be
 * protecting. Anyone walking up to that machine could read the whole fleet from a screen that
 * claimed to be signed out.
 *
 * The redirect is a FULL page load (location.replace, not the router), for two reasons: it discards
 * every component's in-memory copy of the data rather than merely unmounting the view, and
 * `replace` keeps the populated page out of history so the browser's Back button cannot return to
 * it.
 *
 * The welcome flag is cleared too, so signing out and back in replays welcome → sign in → dashboard
 * from the beginning — which is what a second run of a demonstration needs.
 */
export function signOut(redirectTo = '/login') {
  clearToken();
  try {
    window.sessionStorage.removeItem('simorgh_welcome_seen');
  } catch {
    /* storage blocked — the redirect below still happens */
  }
  window.location.replace(redirectTo);
}

export function isSignedIn(): boolean {
  return Boolean(getToken());
}
