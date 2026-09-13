'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { apiFetch, apiUrl, isSignedIn } from '@/lib/api';

/**
 * Startup screen.
 *
 * The progress bar reports REAL work, not a timed animation. Each stage is an actual request that
 * either succeeds or fails, and the bar advances as they complete. A fake loading bar on an
 * operations tool is worse than none: it teaches the operator that the indicator means nothing, so
 * when something genuinely hangs they will not notice.
 *
 * Consequences of that choice:
 *  - if the API is down, this screen SAYS so and offers to continue anyway, rather than sitting at
 *    72% forever;
 *  - the stage that failed is named, which is usually enough to diagnose the problem.
 */

interface Stage {
  key: string;
  labelEn: string;
  labelFa: string;
  run: () => Promise<void>;
}

/**
 * How long the screen is shown.
 *
 * Each stage waits at least MIN_STAGE_MS so the sequence is readable when the API answers
 * instantly — on a local machine all four requests finish in well under a second, which made the
 * whole screen flash past before anyone could read it. Four stages plus the final hold is roughly
 * five seconds, which is what a demo in front of management needs.
 *
 * A slow API only ever makes this longer, never shorter: the minimum is a floor, not a fixed timer,
 * so the bar still reports real work. Both values are overridable without touching code, e.g. in
 * .env: NEXT_PUBLIC_WELCOME_STAGE_MS=1200 and NEXT_PUBLIC_WELCOME_HOLD_MS=1500. Set the stage value
 * to 0 to go straight through, and the Skip button is always there for someone in a hurry.
 */
const MIN_STAGE_MS = Number(process.env.NEXT_PUBLIC_WELCOME_STAGE_MS ?? 900);
/** Time the completed 100% state stays on screen before the fade begins. */
const HOLD_MS = Number(process.env.NEXT_PUBLIC_WELCOME_HOLD_MS ?? 1200);
const FADE_MS = 600;

/**
 * Runs one startup stage. Goes through apiFetch so the request carries the session token when there
 * is one: reads require authentication, and a plain fetch would 401 on every stage and report the
 * API as down to a user who is perfectly well signed in.
 */
async function fetchOk(path: string) {
  await apiFetch(path);
}

/**
 * The public readiness check — the only call available before anyone has signed in.
 *
 * Returns the parsed body on BOTH paths. An unreachable database answers 503 with a perfectly good
 * body naming the cause; throwing that away meant the screen fell back to "The API is not
 * responding", which is the opposite of true — the API answered, it was the database that was down —
 * and would send someone to restart the wrong service.
 */
type Health = { status?: string; database?: string };

async function checkServer(onBody: (h: Health) => void): Promise<void> {
  let res: Response;
  try {
    res = await fetch(apiUrl('/health'), { signal: AbortSignal.timeout(8000), cache: 'no-store' });
  } catch {
    // Genuinely unreachable: no response at all.
    onBody({ status: 'unreachable' });
    throw new Error('api unreachable');
  }
  const body: Health = await res.json().catch(() => ({}));
  onBody(body);
  if (!res.ok) throw new Error(body.database === 'unreachable' ? 'database unreachable' : `health ${res.status}`);
}

export function WelcomeScreen({ onDone, lang = 'en' }: { onDone: () => void; lang?: 'en' | 'fa' }) {
  const fa = lang === 'fa';
  const [stageIndex, setStageIndex] = useState(0);
  const [progress, setProgress] = useState(0);
  const [failed, setFailed] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const startedRef = useRef(false);
  const healthRef = useRef<Health | null>(null);
  // Mirrored into state so the failure panel re-renders with the right diagnosis; a ref alone does
  // not trigger a render, so the panel showed the generic message even after the cause was known.
  const [health, setHealth] = useState<Health | null>(null);
  // Read once, at mount: whether the visitor already has a session decides what can be checked.
  const [signedIn] = useState(() => isSignedIn());

  /**
   * The stages differ before and after sign-in, and both sets do real work.
   *
   * This screen now runs BEFORE the login form, which is where a startup screen belongs — you learn
   * the system is reachable while the artwork is on screen, instead of discovering it by typing a
   * password into a server that is down. But before sign-in the only endpoint that answers is
   * /health: every data endpoint requires a session. Rather than invent stages that do nothing, the
   * pre-login run reports the two things that are genuinely checkable, and the fuller warm-up runs
   * only when there is a session to warm with.
   */
  const stages: Stage[] = useMemo(() => {
    if (!signedIn) {
      return [
        {
          key: 'connect',
          labelEn: 'Contacting Server',
          labelFa: 'ارتباط با سرور',
          run: () => checkServer((h) => { healthRef.current = h; setHealth(h); }),
        },
        {
          key: 'services',
          labelEn: 'Checking Services',
          labelFa: 'بررسی سرویس‌ها',
          run: async () => {
            // The health call above already answered this; failing here names the database
            // specifically, which is the difference between "try again" and "start the database".
            if (healthRef.current?.database !== 'ok') throw new Error('database unreachable');
          },
        },
        {
          key: 'signin',
          labelEn: 'Ready to Sign In',
          labelFa: 'آمادهٔ ورود',
          run: async () => {},
        },
      ];
    }

    return [
      { key: 'init', labelEn: 'Initializing', labelFa: 'راه‌اندازی', run: () => checkServer((h) => { healthRef.current = h; setHealth(h); }) },
      { key: 'mapping', labelEn: 'Grid Mapping', labelFa: 'نقشه‌برداری شبکه', run: () => fetchOk('/api/map/markers') },
      { key: 'assets', labelEn: 'Connecting Assets', labelFa: 'اتصال تجهیزات', run: () => fetchOk('/api/dashboard/kpis') },
      {
        key: 'workspace',
        labelEn: 'Preparing Workspace',
        labelFa: 'آماده‌سازی میزکار',
        run: async () => {
          // Warm the two heaviest first screens so the dashboard lands populated.
          await Promise.allSettled([fetchOk('/api/alarms'), fetchOk('/api/comms/protocols')]);
        },
      },
    ];
  }, [signedIn]);

  useEffect(() => {
    // React 18 StrictMode mounts effects twice in development; without this guard the sequence
    // would run twice and the bar would jump backwards.
    if (startedRef.current) return;
    startedRef.current = true;

    let cancelled = false;
    const timers: ReturnType<typeof setTimeout>[] = [];

    (async () => {
      for (let i = 0; i < stages.length; i++) {
        if (cancelled) return;
        setStageIndex(i);
        const started = Date.now();
        try {
          await stages[i].run();
        } catch (err) {
          if (cancelled) return;
          setFailed(fa ? stages[i].labelFa : stages[i].labelEn);
          return;
        }
        const elapsed = Date.now() - started;
        if (elapsed < MIN_STAGE_MS) await new Promise((r) => setTimeout(r, MIN_STAGE_MS - elapsed));
        if (cancelled) return;
        setProgress(Math.round(((i + 1) / stages.length) * 100));
      }
      if (cancelled) return;
      // Hold on the finished state so the completed checklist is actually seen, then fade out.
      await new Promise((r) => setTimeout(r, HOLD_MS));
      if (cancelled) return;
      setDone(true);
      timers.push(setTimeout(() => !cancelled && onDone(), FADE_MS));
    })();

    return () => {
      cancelled = true;
      // Without this, a fast unmount (navigating away, or StrictMode's double-invoke) left a timer
      // that called onDone() on an unmounted screen.
      timers.forEach(clearTimeout);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      className={`fixed inset-0 z-50 flex flex-col items-center justify-end transition-opacity duration-500 ${
        done ? 'pointer-events-none opacity-0' : 'opacity-100'
      }`}
      style={{
        backgroundColor: '#050b16',
        backgroundImage: "image-set(url('/welcome.jpg') 1x, url('/welcome.jpg') 2x)",
        backgroundSize: 'cover',
        backgroundPosition: 'center',
      }}
    >
      {/* Low-res copy loads first on a slow link so the screen is never blank. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/welcome-small.jpg" alt="" aria-hidden className="pointer-events-none absolute inset-0 -z-10 h-full w-full object-cover" />

      {/*
        Mask over the lower part of the artwork.

        The supplied welcome.jpg is a finished design that ALREADY CONTAINS a painted progress bar
        frozen at 72%, its four stage labels, the Simorgh Technology mark and a version string. The
        live indicator drew a second set on top, so the screen showed two progress bars at two
        different percentages, one ghosted under the other — it read as a rendering fault.

        The painted furniture occupies roughly the bottom quarter of the image, so the mask is
        opaque there and fades out upward: the artwork's subject (the phoenix, the substation) is
        untouched, the painted mock-up is covered, and the real indicator below is the only one on
        screen. Masking in CSS rather than editing the JPG keeps the customer's original asset
        intact, so a redesigned image can be dropped in without redoing this.
      */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-[46%] bg-gradient-to-t from-[#050b16] via-[#050b16] via-55% to-transparent" />

      <div className="relative mb-[8vh] w-full max-w-2xl px-8">
        {failed ? (
          <div className="rounded-xl border border-amber-500/40 bg-[#0b1220]/90 p-5 text-center backdrop-blur">
            <p className="text-sm font-medium text-amber-400">
              {fa ? `مرحله «${failed}» انجام نشد` : `Could not complete "${failed}"`}
            </p>
            <p className="mt-1.5 text-xs leading-relaxed text-slate-400">
              {health?.database === 'unreachable'
                ? fa
                  ? 'سرور بالا است اما به پایگاه داده وصل نمی‌شود. سرویس PostgreSQL و مقدار DATABASE_URL را بررسی کنید.'
                  : 'The server is running but cannot reach the database. Check that PostgreSQL is up and DATABASE_URL is correct.'
                : fa
                ? 'سرور API پاسخ نمی‌دهد. بررسی کنید که API بالا باشد و NEXT_PUBLIC_API_URL درست تنظیم شده باشد.'
                : 'The API is not responding. Check that it is running and that NEXT_PUBLIC_API_URL is correct.'}
            </p>
            <div className="mt-4 flex justify-center gap-2">
              <button
                onClick={() => window.location.reload()}
                className="rounded-lg bg-amber-500/90 px-4 py-2 text-xs font-medium text-black hover:bg-amber-400"
              >
                {fa ? 'تلاش دوباره' : 'Retry'}
              </button>
              <button
                onClick={onDone}
                className="rounded-lg border border-slate-600 px-4 py-2 text-xs text-slate-300 hover:bg-slate-800"
              >
                {fa ? 'ادامه به هر حال' : 'Continue anyway'}
              </button>
            </div>
          </div>
        ) : (
          <>
            <p className="mb-3 text-center text-sm tracking-wide text-slate-300">
              {fa ? 'در حال آماده‌سازی محیط هوشمند شبکه…' : 'Initializing Intelligent Grid Environment…'}
            </p>

            <div className="flex items-center gap-3">
              <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-slate-800/80 ring-1 ring-inset ring-white/10">
                <div
                  className="h-full rounded-full transition-[width] duration-500 ease-out"
                  style={{
                    width: `${progress}%`,
                    background: 'linear-gradient(90deg,#c9a227 0%,#f4d67a 55%,#fff3c4 100%)',
                    boxShadow: '0 0 12px rgba(244,214,122,.55)',
                  }}
                />
              </div>
              <span className="w-11 text-right font-mono text-sm text-slate-200">{progress}%</span>
            </div>

            <div className="mt-5 flex items-start justify-between">
              {stages.map((s, i) => {
                const complete = progress >= ((i + 1) / stages.length) * 100;
                const active = i === stageIndex && !complete;
                return (
                  <div key={s.key} className="flex flex-1 flex-col items-center gap-1.5">
                    <span
                      className={`flex h-4 w-4 items-center justify-center rounded-full border text-[9px] transition-colors ${
                        complete
                          ? 'border-amber-400 bg-amber-400 text-black'
                          : active
                          ? 'border-sky-400 bg-sky-400/20 text-sky-300'
                          : 'border-slate-600 bg-transparent text-transparent'
                      }`}
                    >
                      {complete ? '✓' : '•'}
                    </span>
                    <span
                      className={`text-center text-[10px] leading-tight transition-colors ${
                        active ? 'text-sky-300' : complete ? 'text-slate-300' : 'text-slate-500'
                      }`}
                    >
                      {fa ? s.labelFa : s.labelEn}
                    </span>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>

      <div className="relative mb-4 flex w-full items-center justify-between px-8 text-[10px] text-slate-500">
        <span>Simorgh Technology</span>
        <button onClick={onDone} className="pointer-events-auto rounded px-2 py-1 hover:text-slate-300">
          {fa ? 'رد کردن' : 'Skip'}
        </button>
        <span>Version 1.0.0</span>
      </div>
    </div>
  );
}
