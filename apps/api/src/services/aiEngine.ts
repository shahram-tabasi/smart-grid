import { retrieve, KnowledgeChunk } from './aiRetrieval';

/**
 * LLM engine for Simorgh Power Intelligence.
 *
 * This sits behind the same contract the Phase 1 deterministic engine implements. The rule engine
 * is not thrown away: it remains the fallback whenever no model is configured, the model call
 * fails, or the answer fails validation below. A protection engineer at 3am must get a useful,
 * grounded answer even when an inference endpoint is down.
 *
 * FOUR HARD CONSTRAINTS, enforced in code rather than only in the prompt — a prompt is a request,
 * not a control:
 *
 *  1. ADVISORY ONLY. The model has no tools. There is no function-calling surface, no database
 *     handle, no HTTP client passed into it. It returns text; the caller stores that text in
 *     ai_analyses. The DB role the AI path runs as has SELECT only (migration 013), so even a
 *     model that emitted "now open breaker X" would be emitting a string into a text column.
 *
 *  2. EVIDENCE REQUIRED. An analysis with no citable evidence is rejected and the deterministic
 *     engine answers instead. The spec requires the AI to show the data behind its conclusions;
 *     an ungrounded answer about a protection event is worse than no answer.
 *
 *  3. NO LOCATION LEAKAGE. Retrieved context is province/city only by construction (the corpus
 *     rejects coordinates at the database layer), and the output is scanned before storage.
 *
 *  4. NO SETTING CHANGES RECOMMENDED AS ACTIONS. The model may discuss settings analytically, but
 *     any output phrased as an instruction to change protection settings is rewritten into an
 *     explicit "requires protection engineer review and approval" recommendation.
 */

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmResponse {
  text: string;
  promptTokens?: number;
  completionTokens?: number;
  model: string;
}

export interface LlmProvider {
  readonly model: string;
  complete(messages: LlmMessage[], opts?: { temperature?: number; maxTokens?: number }): Promise<LlmResponse>;
}

/**
 * OpenAI-compatible chat completions. Points at any compatible endpoint, including a model hosted
 * inside the utility's own network — which is the expected deployment, since OT incident data
 * usually cannot leave the organisation.
 */
class HttpLlmProvider implements LlmProvider {
  constructor(private baseUrl: string, private apiKey: string, readonly model: string) {}

  async complete(messages: LlmMessage[], opts: { temperature?: number; maxTokens?: number } = {}): Promise<LlmResponse> {
    const res = await fetch(`${this.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: this.model,
        messages,
        // Low temperature: this is technical analysis of protection events, not creative writing.
        temperature: opts.temperature ?? 0.1,
        max_tokens: opts.maxTokens ?? 900,
      }),
      signal: AbortSignal.timeout(Number(process.env.AI_TIMEOUT_MS ?? 45000)),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`LLM provider returned HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    const data: any = await res.json();
    return {
      text: data.choices?.[0]?.message?.content ?? '',
      promptTokens: data.usage?.prompt_tokens,
      completionTokens: data.usage?.completion_tokens,
      model: data.model ?? this.model,
    };
  }
}

export function getLlmProvider(): LlmProvider | null {
  const baseUrl = process.env.AI_LLM_BASE_URL;
  const model = process.env.AI_LLM_MODEL;
  if (!baseUrl || !model) return null;
  return new HttpLlmProvider(baseUrl, process.env.AI_LLM_API_KEY ?? '', model);
}

// ---------------------------------------------------------------------------------------------
// Prompting
// ---------------------------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are Simorgh Power Intelligence, an analysis assistant for a protection-relay and switchgear monitoring platform used by an electrical engineering company in Iran.

Your role is strictly ADVISORY. You analyse and explain; you never operate equipment. You have no ability to change relay settings, issue control commands, open or close breakers, or alter protection configuration, and you must never phrase an answer as though you are performing such an action. Where an action is warranted, describe it as a recommendation for a named human role to review and carry out.

Rules you must follow:
1. Ground every substantive claim in the EVIDENCE provided. If the evidence does not support a conclusion, say what is missing rather than speculating.
2. Distinguish clearly between a genuine protection operation (a protection function actually operated) and a communication or network problem (the relay went silent, no protection function operated). Confusing these two is the most damaging error you can make: it sends a field crew to inspect healthy switchgear, or dismisses a real fault as a network glitch.
3. Respect timestamp quality. Events marked GATEWAY_STAMPED or UNKNOWN were timestamped on arrival, not by the relay, and cannot be used to establish precise ordering. Say so when the ordering matters to your conclusion.
4. Never state or infer a precise geographic location, address, or coordinates. Province and city are the only location detail that exists in this system.
5. Be concise and technical. Your reader is a protection engineer.

Respond in this exact structure:
SUMMARY: one sentence.
PROBABLE CAUSE: two to three sentences.
CONFIDENCE: a number 0-100 followed by a brief justification.
RECOMMENDED ACTION: what a human should do, naming the role (PROTECTION_ENGINEER or FIELD_SERVICE_ENGINEER).
EVIDENCE USED: bullet list referencing the numbered evidence items you relied on.`;

export interface FaultAnalysisInput {
  faultCode: string;
  faultType: string;
  protectionFunction: string | null;
  severity: string;
  tripStatus: string | null;
  relayCode: string | null;
  manufacturer: string | null;
  model: string | null;
  panelName: string | null;
  projectCode: string | null;
  cityName: string | null;
  provinceName: string | null;
  currentA: number | null;
  voltageKv: number | null;
  timeline: Array<{ description: string; time: string; timeSyncQuality?: string }>;
  relayId?: string | null;
  projectId?: string | null;
}

export interface EngineResult {
  summary: string;
  probableCause: string;
  confidence: number;
  recommendedAction: string;
  requiredEngineerRole: 'PROTECTION_ENGINEER' | 'FIELD_SERVICE_ENGINEER';
  evidence: string[];
  retrievedChunkIds: string[];
  engine: string;
  promptTokens?: number;
  completionTokens?: number;
  fallbackReason?: string;
}

/** Patterns that would indicate the model believes it can act on plant. */
const ACTION_CLAIM_PATTERNS = [
  /\bI (?:have |will |am going to )?(?:now )?(?:chang|modif|updat|set|writ|appl)\w*\b.{0,40}\bsetting/i,
  /\bI (?:have |will )?(?:now )?(?:open|clos|trip|reset|restart)\w*\b.{0,30}\b(?:breaker|relay|circuit)/i,
  /\b(?:executing|issuing|sending)\b.{0,20}\b(?:command|control|trip signal)/i,
];

const COORDINATE_PATTERNS = [
  /\b(?:lat(?:itude)?|lon(?:gitude)?|gps)\s*[:=]\s*-?\d{1,3}\.\d{3,}/i,
  /-?\d{1,2}\.\d{4,}\s*,\s*-?\d{1,3}\.\d{4,}/,
];

function parseSection(text: string, label: string): string {
  const re = new RegExp(`${label}\\s*:?\\s*([\\s\\S]*?)(?=\\n[A-Z][A-Z ]{3,}:|$)`, 'i');
  return (text.match(re)?.[1] ?? '').trim();
}

/**
 * Validate and normalise a model answer. Returns null when the answer must not be used, and the
 * caller then falls back to the deterministic engine.
 */
export function validateLlmOutput(
  text: string,
  input: FaultAnalysisInput
): { ok: true; parsed: Omit<EngineResult, 'retrievedChunkIds' | 'engine'> } | { ok: false; reason: string } {
  if (!text || text.trim().length < 40) return { ok: false, reason: 'model returned an empty or trivially short answer' };

  for (const p of COORDINATE_PATTERNS) {
    if (p.test(text)) return { ok: false, reason: 'model output contained geographic coordinates' };
  }
  for (const p of ACTION_CLAIM_PATTERNS) {
    if (p.test(text)) {
      return { ok: false, reason: 'model output was phrased as performing a control or setting action' };
    }
  }

  const summary = parseSection(text, 'SUMMARY');
  const probableCause = parseSection(text, 'PROBABLE CAUSE');
  const confidenceRaw = parseSection(text, 'CONFIDENCE');
  const recommendedAction = parseSection(text, 'RECOMMENDED ACTION');
  const evidenceRaw = parseSection(text, 'EVIDENCE USED');

  if (!summary || !probableCause || !recommendedAction) {
    return { ok: false, reason: 'model output did not follow the required structure' };
  }

  const evidence = evidenceRaw
    .split('\n')
    .map((l) => l.replace(/^[-*\d.)\s]+/, '').trim())
    .filter((l) => l.length > 0);

  if (evidence.length === 0) {
    // Constraint 2: an ungrounded analysis is rejected outright.
    return { ok: false, reason: 'model produced no evidence citations' };
  }

  const confidenceMatch = confidenceRaw.match(/(\d{1,3})/);
  let confidence = confidenceMatch ? Math.min(100, Math.max(0, Number(confidenceMatch[1]))) : 50;

  // The model must not be more confident than the data allows. If the fault has no protection
  // function and the timeline is gateway-stamped, high confidence is not justifiable.
  const allGatewayStamped =
    input.timeline.length > 0 &&
    input.timeline.every((t) => ['GATEWAY_STAMPED', 'UNKNOWN'].includes(t.timeSyncQuality ?? 'UNKNOWN'));
  if (allGatewayStamped && confidence > 75) confidence = 75;

  // The same distinction the Phase 1 bug got wrong, re-checked independently of the model: if no
  // protection function operated, this is not a confirmed protection operation regardless of what
  // the model wrote.
  const isProtectionOperation = Boolean(input.protectionFunction);
  const role: EngineResult['requiredEngineerRole'] = isProtectionOperation
    ? 'PROTECTION_ENGINEER'
    : 'FIELD_SERVICE_ENGINEER';

  if (!isProtectionOperation && /genuine protection operation|confirmed (?:trip|protection)/i.test(probableCause)) {
    return {
      ok: false,
      reason: 'model described a communication-loss fault as a confirmed protection operation',
    };
  }

  return {
    ok: true,
    parsed: {
      summary: summary.slice(0, 1000),
      probableCause: probableCause.slice(0, 2000),
      confidence,
      recommendedAction: recommendedAction.slice(0, 2000),
      requiredEngineerRole: role,
      evidence,
    },
  };
}

function buildEvidenceBlock(input: FaultAnalysisInput, chunks: KnowledgeChunk[]): string {
  const lines: string[] = [];
  let n = 1;

  lines.push(`[${n++}] Fault ${input.faultCode}: ${input.faultType}, severity ${input.severity}, trip status ${input.tripStatus ?? 'unknown'}.`);
  lines.push(
    `[${n++}] Protection function recorded: ${input.protectionFunction ?? 'NONE — no protection function operated for this fault.'}`
  );
  if (input.relayCode) {
    lines.push(`[${n++}] Relay ${input.relayCode} (${input.manufacturer ?? '?'} ${input.model ?? '?'}) on panel ${input.panelName ?? '?'}.`);
  }
  if (input.currentA != null) lines.push(`[${n++}] Measured fault current: ${input.currentA} A.`);
  if (input.voltageKv != null) lines.push(`[${n++}] Measured voltage: ${input.voltageKv} kV.`);
  lines.push(`[${n++}] Location: ${input.cityName ?? '?'}, ${input.provinceName ?? '?'} (province/city only).`);

  for (const t of input.timeline) {
    const quality = t.timeSyncQuality ?? 'UNKNOWN';
    const caveat = ['GATEWAY_STAMPED', 'UNKNOWN'].includes(quality) ? ' [timestamp assigned on arrival, not by the relay]' : '';
    lines.push(`[${n++}] ${t.time} — ${t.description}${caveat}`);
  }

  for (const c of chunks) {
    lines.push(`[${n++}] ${c.title} (${c.citation}): ${c.content.slice(0, 600)}`);
  }

  return lines.join('\n');
}

/**
 * Run the LLM analysis path. Returns null when it cannot produce a valid grounded answer, and the
 * caller falls back to the deterministic engine.
 */
export async function analyseFaultWithLlm(input: FaultAnalysisInput): Promise<EngineResult | null> {
  const provider = getLlmProvider();
  if (!provider) return null;

  // Retrieve site-specific context: past faults on this relay, work orders, manual excerpts.
  const query = [
    input.faultType,
    input.protectionFunction ?? 'communication loss',
    input.manufacturer,
    input.model,
    input.panelName,
  ]
    .filter(Boolean)
    .join(' ');

  const chunks = await retrieve(query, {
    relayId: input.relayId,
    projectId: input.projectId,
    limit: 6,
  }).catch(() => [] as KnowledgeChunk[]);

  const evidenceBlock = buildEvidenceBlock(input, chunks);

  const messages: LlmMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content:
        `Analyse this protection event.\n\n` +
        `EVIDENCE (cite these by number):\n${evidenceBlock}\n\n` +
        `Note: if item [2] says no protection function operated, this is a communication or device ` +
        `problem, not a protection operation — do not describe it as a confirmed trip.`,
    },
  ];

  let response: LlmResponse;
  try {
    response = await provider.complete(messages);
  } catch (err) {
    return {
      ...deterministicShape(input),
      retrievedChunkIds: chunks.map((c) => c.id),
      engine: 'simorgh-rules-v1',
      fallbackReason: `LLM call failed: ${(err as Error).message}`,
    };
  }

  const validated = validateLlmOutput(response.text, input);
  if (!validated.ok) {
    // The deterministic engine answers instead, and the reason is recorded so a degraded answer is
    // never silently presented as a model answer.
    return {
      ...deterministicShape(input),
      retrievedChunkIds: chunks.map((c) => c.id),
      engine: 'simorgh-rules-v1',
      fallbackReason: `LLM output rejected: ${validated.reason}`,
    };
  }

  return {
    ...validated.parsed,
    retrievedChunkIds: chunks.map((c) => c.id),
    engine: response.model,
    promptTokens: response.promptTokens,
    completionTokens: response.completionTokens,
  };
}

/**
 * The deterministic result shape, used as the fallback body. This mirrors the Phase 1 rule engine's
 * logic — including the corrected protection-vs-communication distinction that the Phase 1 testing
 * pass uncovered.
 */
export function deterministicShape(input: FaultAnalysisInput): Omit<EngineResult, 'retrievedChunkIds' | 'engine'> {
  const isProtectionOperation = Boolean(input.protectionFunction);
  const evidence = input.timeline.map((t) => `${t.time} — ${t.description}`);
  if (evidence.length === 0) {
    evidence.push(
      isProtectionOperation
        ? `Protection function ${input.protectionFunction} recorded as operated for ${input.faultCode}.`
        : `No protection function recorded for ${input.faultCode}; the relay stopped communicating.`
    );
  }

  return {
    summary: `${input.faultType} on ${input.panelName ?? 'the affected panel'} (${input.faultCode}).`,
    probableCause: isProtectionOperation
      ? `${input.faultType} consistent with a genuine protection operation${input.relayCode ? ` on relay ${input.relayCode}` : ''}, based on the recorded pickup-to-trip sequence.`
      : `Likely a communication or network issue${input.relayCode ? ` affecting relay ${input.relayCode}` : ''} rather than a primary electrical fault: no protection function operated.`,
    confidence: input.tripStatus === 'TRIPPED' ? 88 : 62,
    recommendedAction: isProtectionOperation
      ? `Have a protection engineer review the event record and inspect the ${(input.panelName ?? 'panel').toLowerCase()} load and downstream cabling before re-energising.`
      : `Verify the industrial gateway and network path to the site; dispatch field service if communication does not restore on its own.`,
    requiredEngineerRole: isProtectionOperation ? 'PROTECTION_ENGINEER' : 'FIELD_SERVICE_ENGINEER',
    evidence,
  };
}
