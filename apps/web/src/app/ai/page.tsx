'use client';

import { useState } from 'react';
import { TopBar } from '@/components/TopBar';
import { apiFetch } from '@/lib/api';
import { useI18n } from '@/lib/i18n';

interface Message { role: 'user' | 'assistant'; content: string; evidence?: any[] }

const SUGGESTIONS = [
  'Show me the projects with the highest fault rate this month',
  'Which relay has the most repeated trips?',
  'Which cities have the highest number of faults?',
  'Which projects are at risk of delay?',
  'Which relay should be inspected first?',
  'Are several apparently separate alarms actually related to one root cause?',
];

export default function AiChatPage() {
  const { t } = useI18n();
  const [messages, setMessages] = useState<Message[]>([
    { role: 'assistant', content: 'I\'m Simorgh Grid Copilot. Ask me about fault rates, relay health, at-risk projects, or what happened in a specific city — I\'ll always show the data behind my answer.' },
  ]);
  const [sessionId, setSessionId] = useState<string | undefined>();
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);

  async function send(text?: string) {
    const message = text ?? input;
    if (!message.trim()) return;
    // A second send while the first is still open would post again with sessionId still undefined,
    // and the API creates a new ai_chat_sessions row per session-less request. The conversation then
    // splits permanently across two sessions and the answers render in completion order, not ask
    // order. One request at a time is the only way to keep the stored history coherent.
    if (loading) return;
    setMessages((m) => [...m, { role: 'user', content: message }]);
    setInput('');
    setLoading(true);
    try {
      const res = await apiFetch<{ sessionId: string; answer: string; evidence: any[] }>('/api/ai/chat', {
        method: 'POST',
        body: JSON.stringify({ sessionId, message }),
      });
      setSessionId(res.sessionId);
      setMessages((m) => [...m, { role: 'assistant', content: res.answer, evidence: res.evidence }]);
    } catch (e: any) {
      setMessages((m) => [...m, { role: 'assistant', content: `Sign in to use the copilot (${e.message}).` }]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex h-screen flex-col">
      <TopBar title="✦ Simorgh Grid Copilot" subtitle={t('ai_sub')} />
      <div className="flex-1 overflow-y-auto p-6">
        <div className="mx-auto max-w-3xl space-y-4">
          {messages.map((m, i) => (
            <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-xl rounded-2xl px-4 py-3 text-sm ${m.role === 'user' ? 'bg-accent text-white' : 'card text-graphite-100'}`}>
                <p>{m.content}</p>
                {m.evidence && m.evidence.length > 0 && (
                  <details className="mt-2 text-xs opacity-80">
                    <summary className="cursor-pointer text-graphite-400">{t('evidence')} ({m.evidence.length})</summary>
                    <pre className="mt-1 max-w-full overflow-x-auto rounded-lg bg-graphite-900 p-2 text-[10px] text-graphite-400">
                      {JSON.stringify(m.evidence, null, 2)}
                    </pre>
                  </details>
                )}
              </div>
            </div>
          ))}
          {loading && <div className="text-xs text-graphite-500">{t('thinking')}</div>}
        </div>
      </div>
      <div className="border-t border-graphite-700 p-4">
        <div className="mx-auto max-w-3xl">
          <div className="mb-2 flex flex-wrap gap-2">
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                onClick={() => send(s)}
                disabled={loading}
                className="rounded-full border border-graphite-600 px-3 py-1 text-xs text-graphite-300 hover:border-accent hover:text-accent disabled:opacity-40"
              >
                {s}
              </button>
            ))}
          </div>
          <form onSubmit={(e) => { e.preventDefault(); send(); }} className="flex gap-2">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={t('ask_placeholder')}
              className="flex-1 rounded-xl border border-graphite-600 bg-graphite-850 px-4 py-2.5 text-sm focus:border-accent focus:outline-none"
            />
            <button
              type="submit"
              disabled={loading || !input.trim()}
              className="rounded-xl bg-accent px-5 py-2.5 text-sm font-medium text-white hover:bg-accent-dim disabled:opacity-50"
            >
              {loading ? t('sending') : t('send')}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
