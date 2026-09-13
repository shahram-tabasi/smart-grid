'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch, SessionExpiredError } from './api';

/**
 * Race-safe data loading for list and detail screens.
 *
 * Every list page previously did this:
 *
 *     useEffect(() => {
 *       apiFetch(`/api/relays?${params}`).then((d) => setRelays(d.relays));
 *     }, [manufacturer, search]);
 *
 * which has three defects that all reached the operator:
 *
 *  1. NO CANCELLATION. Typing "TEH" fires three requests. The broad "T" query returns the most rows
 *     and is the slowest, so it usually lands last — the filter box reads "TEH" while the table
 *     below shows the results for "T". On a protection console, reading a relay list that does not
 *     match the filter you can see is how the wrong device gets worked on. Each run now takes a
 *     sequence number and only the newest is allowed to write state.
 *  2. NO .catch. A rejected fetch left the page showing an empty table. On the alarms screen that
 *     rendered "No alarms in this filter." — the API being unreachable was displayed as a healthy,
 *     alarm-free fleet. Silence is the one thing an operations tool must never report as "all clear".
 *  3. NO DEBOUNCE on free-text search, so every keystroke hit the database.
 *
 * `path` is a plain string, so it is a correct and stable dependency; callers build it with the
 * filters already interpolated and no useMemo is needed.
 */
export interface ApiDataState<T> {
  data: T | null;
  error: string | null;
  /** True only for the first load. Filter changes keep the old rows visible and set `refreshing`. */
  loading: boolean;
  /** True while any request is in flight, including a filter change over already-rendered rows. */
  refreshing: boolean;
  reload: () => void;
}

export function useApiData<T>(path: string | null, options?: { debounceMs?: number }): ApiDataState<T> {
  const debounceMs = options?.debounceMs ?? 0;

  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [loaded, setLoaded] = useState(false);

  // Incremented per request; a response whose id is not the latest is discarded. This is what makes
  // fast filter clicks and fast typing safe.
  const requestId = useRef(0);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    if (path === null) return;

    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;
    const id = ++requestId.current;

    const run = async () => {
      setRefreshing(true);
      try {
        const result = await apiFetch<T>(path);
        // A newer request started while this one was in flight — its answer is the correct one.
        if (cancelled || id !== requestId.current) return;
        setData(result);
        setError(null);
      } catch (err: any) {
        if (cancelled || id !== requestId.current) return;
        if (err instanceof SessionExpiredError) {
          // Send the operator back to sign in rather than showing an empty screen they cannot fix.
          if (typeof window !== 'undefined') {
            window.location.href = `/login?next=${encodeURIComponent(window.location.pathname)}`;
          }
          return;
        }
        setError(err?.message || 'Could not load data from the API.');
      } finally {
        if (!cancelled && id === requestId.current) {
          setRefreshing(false);
          setLoaded(true);
        }
      }
    };

    if (debounceMs > 0) timer = setTimeout(run, debounceMs);
    else void run();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [path, debounceMs, reloadToken]);

  const reload = useCallback(() => setReloadToken((n) => n + 1), []);

  return { data, error, loading: !loaded && refreshing, refreshing, reload };
}
