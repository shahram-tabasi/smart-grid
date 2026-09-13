'use client';

import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { apiFetch, setToken } from '@/lib/api';
import { useI18n } from '@/lib/i18n';

/**
 * Sign-in.
 *
 * This page used to print the shared demo password in plain text and list every seeded account's
 * email address underneath the form. That was a convenience for the first evaluation build, but it
 * is exactly what a person from outside the company sees first, and it teaches anyone looking over
 * a shoulder both half of a credential pair and the company's account naming. Removed at the
 * customer's request: this is now an ordinary sign-in form.
 *
 * The accounts themselves are unchanged. They are documented in docs/OPERATIONS_MANUAL.md, which is
 * where credentials belong.
 */
export default function LoginPage() {
  const { t } = useI18n();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await apiFetch<{ accessToken: string; refreshToken: string; user: any }>('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email: email.trim().toLowerCase(), password }),
      });
      // Store BOTH tokens. Keeping only the access token was why sessions died after two hours.
      setToken(res.accessToken, res.refreshToken);
      // Return the user to whatever they were trying to reach when the session expired.
      const next = searchParams.get('next');
      router.push(next && next.startsWith('/') ? next : '/overview');
    } catch (err: any) {
      setError(err?.message ?? 'Sign in failed');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <div className="card w-full max-w-sm p-6">
        <div className="mb-6 flex flex-col items-center text-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/logo.png"
            alt=""
            className="mb-3 h-20 w-20 object-contain"
            onError={(e) => {
              (e.currentTarget as HTMLImageElement).style.display = 'none';
            }}
          />
          <h1 className="text-lg font-semibold text-graphite-100">Simorgh Grid</h1>
          <p className="mt-0.5 text-[11px] leading-snug text-graphite-400" dir="rtl">
            مرکز فرماندهی پروژه‌های برقی و حفاظت الکترو کویر
          </p>
        </div>

        <form onSubmit={submit} className="space-y-3">
          <div>
            <label htmlFor="email" className="mb-1 block text-xs text-graphite-400">
              {t('email')}
            </label>
            <input
              id="email"
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded-lg border border-graphite-600 bg-graphite-850 px-3 py-2 text-sm text-graphite-100 focus:border-accent focus:outline-none"
            />
          </div>

          <div>
            <label htmlFor="password" className="mb-1 block text-xs text-graphite-400">
              {t('password')}
            </label>
            <div className="relative">
              <input
                id="password"
                type={showPassword ? 'text' : 'password'}
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full rounded-lg border border-graphite-600 bg-graphite-850 px-3 py-2 pr-16 text-sm text-graphite-100 focus:border-accent focus:outline-none"
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded px-2 py-1 text-[11px] text-graphite-400 hover:bg-graphite-700 hover:text-graphite-200"
              >
                {showPassword ? t('hide') : t('show')}
              </button>
            </div>
          </div>

          {error && (
            <div className="rounded-lg border border-status-critical/40 bg-status-critical/10 px-3 py-2">
              <p className="text-xs text-status-critical">{error}</p>
            </div>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="w-full rounded-lg bg-accent py-2 text-sm font-medium text-white hover:bg-accent-dim disabled:opacity-60"
          >
            {submitting ? t('signing_in') : t('sign_in')}
          </button>
        </form>

        <p className="mt-5 border-t border-graphite-700 pt-4 text-center text-[11px] leading-relaxed text-graphite-600">
          {t('authorised_only')}
        </p>
      </div>
    </div>
  );
}
