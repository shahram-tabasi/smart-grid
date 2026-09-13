'use client';

import { useI18n } from '@/lib/i18n';

export function TopBar({ title, subtitle }: { title: string; subtitle?: string }) {
  const { lang, setLang, t } = useI18n();

  return (
    <header className="flex items-center justify-between border-b border-graphite-700 bg-graphite-900/60 px-6 py-4 backdrop-blur">
      <div>
        <h1 className="text-lg font-semibold text-graphite-50">{title}</h1>
        {subtitle ? <p className="text-xs text-graphite-400">{subtitle}</p> : null}
      </div>
      <div className="flex items-center gap-3">
        <span className="rounded-full border border-status-warning/30 bg-status-warning/10 px-3 py-1 text-[11px] font-medium text-status-warning">
          {t('demo_badge')}
        </span>
        <div className="flex overflow-hidden rounded-lg border border-graphite-600 text-xs">
          <button
            onClick={() => setLang('en')}
            className={`px-2.5 py-1.5 ${lang === 'en' ? 'bg-accent text-white' : 'bg-graphite-800 text-graphite-300'}`}
          >
            EN
          </button>
          <button
            onClick={() => setLang('fa')}
            className={`px-2.5 py-1.5 ${lang === 'fa' ? 'bg-accent text-white' : 'bg-graphite-800 text-graphite-300'}`}
          >
            فا
          </button>
        </div>
      </div>
    </header>
  );
}
