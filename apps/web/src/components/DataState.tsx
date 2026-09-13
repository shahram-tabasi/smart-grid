'use client';

import { useI18n } from '@/lib/i18n';

/**
 * The one place a screen says "I could not load this."
 *
 * Before this existed, a failed fetch rendered an empty table with the row counter reading 0 — the
 * screen claimed there were no relays, no faults, no alarms, when in fact nothing had been asked.
 * An operations console that reports an unreachable API as an all-clear is worse than one that
 * shows nothing at all, because the operator believes it.
 */
export function ErrorPanel({ message, onRetry }: { message: string; onRetry?: () => void }) {
  const { t } = useI18n();
  return (
    <div className="card border-status-critical/40 bg-status-critical/5 p-5 text-center">
      <p className="text-sm font-medium text-status-critical">{t('could_not_load')}</p>
      <p className="mx-auto mt-1.5 max-w-lg text-xs leading-relaxed text-graphite-400">{message}</p>
      <p className="mx-auto mt-2 max-w-lg text-[11px] leading-relaxed text-graphite-500">
        {t('not_all_clear')}
      </p>
      {onRetry && (
        <button
          onClick={onRetry}
          className="mt-3 rounded-lg border border-graphite-600 px-4 py-1.5 text-xs text-graphite-200 hover:bg-graphite-800"
        >
          {t('retry')}
        </button>
      )}
    </div>
  );
}

export function LoadingPanel({ label }: { label?: string }) {
  const { t } = useI18n();
  return (
    <div className="card p-8 text-center">
      <div className="mx-auto mb-3 h-5 w-5 animate-spin rounded-full border-2 border-graphite-600 border-t-accent" />
      <p className="text-xs text-graphite-500">{label ?? t('loading')}</p>
    </div>
  );
}
