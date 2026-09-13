import { pool } from '../db/pool';

/**
 * Retrieval layer for the Simorgh AI service.
 *
 * Two retrieval strategies, chosen by what the database actually supports:
 *  - semantic (pgvector cosine similarity) when the extension is installed and an embedding
 *    provider is configured;
 *  - lexical (Postgres full-text search) otherwise.
 *
 * Lexical is not merely a degraded fallback: relay codes, ANSI numbers and IEC information numbers
 * match far better lexically than semantically, so when both are available the results are merged.
 *
 * Everything retrieved carries a citation, because the specification requires the AI to show the
 * evidence behind any important conclusion, and an answer whose sources cannot be checked is worse
 * than no answer in a protection context.
 */

export const EMBEDDING_DIMENSIONS = 1536;

export interface KnowledgeChunk {
  id: string;
  sourceKind: string;
  title: string;
  content: string;
  citation: string;
  relayId?: string | null;
  projectId?: string | null;
  score: number;
  retrievedBy: 'semantic' | 'lexical';
}

let pgvectorAvailable: boolean | null = null;

export async function hasPgVector(): Promise<boolean> {
  if (pgvectorAvailable !== null) return pgvectorAvailable;
  try {
    const { rows } = await pool.query(`SELECT 1 FROM pg_extension WHERE extname = 'vector'`);
    pgvectorAvailable = rows.length > 0;
  } catch {
    pgvectorAvailable = false;
  }
  return pgvectorAvailable;
}

// ---------------------------------------------------------------------------------------------
// Embeddings
// ---------------------------------------------------------------------------------------------

export interface EmbeddingProvider {
  readonly name: string;
  embed(texts: string[]): Promise<number[][]>;
}

/**
 * OpenAI-compatible embeddings. Deliberately generic: many organisations running OT infrastructure
 * cannot send data to a public API, so this points at any compatible endpoint — including a
 * self-hosted model inside the utility's own network, which is the expected deployment here.
 */
class HttpEmbeddingProvider implements EmbeddingProvider {
  readonly name: string;
  constructor(private baseUrl: string, private apiKey: string, private model: string) {
    this.name = `${model}@${new URL(baseUrl).host}`;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const res = await fetch(`${this.baseUrl.replace(/\/$/, '')}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify({ model: this.model, input: texts }),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) throw new Error(`embedding provider returned HTTP ${res.status}`);
    const data: any = await res.json();
    return data.data.map((d: any) => d.embedding);
  }
}

export function getEmbeddingProvider(): EmbeddingProvider | null {
  const baseUrl = process.env.AI_EMBEDDING_BASE_URL;
  const model = process.env.AI_EMBEDDING_MODEL;
  if (!baseUrl || !model) return null;
  return new HttpEmbeddingProvider(baseUrl, process.env.AI_EMBEDDING_API_KEY ?? '', model);
}

// ---------------------------------------------------------------------------------------------
// Retrieval
// ---------------------------------------------------------------------------------------------

export interface RetrievalScope {
  relayId?: string | null;
  projectId?: string | null;
  manufacturer?: string | null;
  model?: string | null;
  protectionFunction?: string | null;
  limit?: number;
}

/** Semantic retrieval over pgvector. */
async function retrieveSemantic(queryEmbedding: number[], scope: RetrievalScope): Promise<KnowledgeChunk[]> {
  const limit = scope.limit ?? 8;
  const conditions: string[] = [];
  const params: any[] = [`[${queryEmbedding.join(',')}]`];

  // Scope the search so a fault on one relay does not retrieve an unrelated site's history as if
  // it were evidence. Relay/project matches are preferred but general knowledge is still allowed in.
  if (scope.relayId) {
    params.push(scope.relayId);
    conditions.push(`(relay_id = $${params.length} OR relay_id IS NULL)`);
  }
  if (scope.projectId) {
    params.push(scope.projectId);
    conditions.push(`(project_id = $${params.length} OR project_id IS NULL)`);
  }
  params.push(limit);

  const { rows } = await pool.query(
    `SELECT id, source_kind, title, content, citation, relay_id, project_id,
            1 - (embedding <=> $1::vector) AS score
     FROM knowledge_chunks
     WHERE embedding IS NOT NULL
       ${conditions.length ? `AND ${conditions.join(' AND ')}` : ''}
     ORDER BY embedding <=> $1::vector
     LIMIT $${params.length}`,
    params
  );

  return rows.map((r) => ({
    id: r.id,
    sourceKind: r.source_kind,
    title: r.title,
    content: r.content,
    citation: r.citation,
    relayId: r.relay_id,
    projectId: r.project_id,
    score: Number(r.score),
    retrievedBy: 'semantic' as const,
  }));
}

/** Lexical retrieval over the generated tsvector. */
async function retrieveLexical(query: string, scope: RetrievalScope): Promise<KnowledgeChunk[]> {
  const limit = scope.limit ?? 8;
  const conditions: string[] = [];
  const params: any[] = [query];

  if (scope.relayId) {
    params.push(scope.relayId);
    conditions.push(`(relay_id = $${params.length} OR relay_id IS NULL)`);
  }
  if (scope.projectId) {
    params.push(scope.projectId);
    conditions.push(`(project_id = $${params.length} OR project_id IS NULL)`);
  }
  params.push(limit);

  const { rows } = await pool.query(
    `SELECT id, source_kind, title, content, citation, relay_id, project_id,
            ts_rank(content_tsv, websearch_to_tsquery('english', $1)) AS score
     FROM knowledge_chunks
     WHERE content_tsv @@ websearch_to_tsquery('english', $1)
       ${conditions.length ? `AND ${conditions.join(' AND ')}` : ''}
     ORDER BY score DESC
     LIMIT $${params.length}`,
    params
  );

  return rows.map((r) => ({
    id: r.id,
    sourceKind: r.source_kind,
    title: r.title,
    content: r.content,
    citation: r.citation,
    relayId: r.relay_id,
    projectId: r.project_id,
    score: Number(r.score),
    retrievedBy: 'lexical' as const,
  }));
}

/**
 * Hybrid retrieval. Runs whichever strategies are available and fuses the rankings.
 * Reciprocal rank fusion is used rather than raw score comparison because cosine similarity and
 * ts_rank are not on the same scale and averaging them directly would be meaningless.
 */
export async function retrieve(query: string, scope: RetrievalScope = {}): Promise<KnowledgeChunk[]> {
  const results: KnowledgeChunk[][] = [];

  const lexical = await retrieveLexical(query, scope).catch(() => []);
  if (lexical.length) results.push(lexical);

  if (await hasPgVector()) {
    const provider = getEmbeddingProvider();
    if (provider) {
      try {
        const [embedding] = await provider.embed([query]);
        const semantic = await retrieveSemantic(embedding, scope);
        if (semantic.length) results.push(semantic);
      } catch {
        // Retrieval degrading to lexical is acceptable; failing the whole analysis is not.
      }
    }
  }

  if (results.length === 0) return [];
  if (results.length === 1) return results[0];

  const K = 60; // standard RRF damping constant
  const fused = new Map<string, { chunk: KnowledgeChunk; score: number }>();
  for (const list of results) {
    list.forEach((chunk, index) => {
      const existing = fused.get(chunk.id);
      const contribution = 1 / (K + index + 1);
      if (existing) existing.score += contribution;
      else fused.set(chunk.id, { chunk, score: contribution });
    });
  }

  return [...fused.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, scope.limit ?? 8)
    .map((f) => ({ ...f.chunk, score: f.score }));
}

// ---------------------------------------------------------------------------------------------
// Corpus maintenance
// ---------------------------------------------------------------------------------------------

/**
 * Index a resolved fault into the corpus. Called when an engineer confirms a root cause — that
 * confirmation is the highest-value training signal the system has, because it is a human expert
 * saying what actually happened.
 */
export async function indexResolvedFault(faultId: string): Promise<void> {
  const { rows } = await pool.query(
    `SELECT f.id, f.fault_code, f.fault_type, f.protection_function, f.severity, f."timestamp",
            f.current_a, f.voltage_kv, f.root_cause_status, f.resolution_notes,
            r.id AS relay_id, r.relay_code, r.manufacturer, r.model,
            p.id AS project_id, p.province_id, p.city_id, pnl.name AS panel_name
     FROM faults f
     LEFT JOIN relays r ON r.id = f.relay_id
     LEFT JOIN panels pnl ON pnl.id = f.panel_id
     JOIN projects p ON p.id = f.project_id
     WHERE f.id = $1`,
    [faultId]
  );
  const f = rows[0];
  if (!f) return;

  const content = [
    `Fault ${f.fault_code}: ${f.fault_type} on ${f.panel_name ?? 'unknown panel'}.`,
    f.relay_code ? `Relay ${f.relay_code} (${f.manufacturer} ${f.model}).` : '',
    f.protection_function ? `Protection function that operated: ${f.protection_function}.` : 'No protection function operated.',
    f.current_a ? `Fault current ${f.current_a} A.` : '',
    f.voltage_kv ? `Voltage ${f.voltage_kv} kV.` : '',
    f.resolution_notes ? `Engineer resolution: ${f.resolution_notes}` : '',
  ]
    .filter(Boolean)
    .join(' ');

  await pool.query(
    `INSERT INTO knowledge_chunks
       (source_kind, project_id, province_id, city_id, relay_id, fault_id, manufacturer, model,
        protection_function, title, content, citation)
     VALUES ('FAULT_HISTORY',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT DO NOTHING`,
    [
      f.project_id,
      f.province_id,
      f.city_id,
      f.relay_id,
      f.id,
      f.manufacturer,
      f.model,
      f.protection_function,
      `${f.fault_type} — ${f.fault_code}`,
      content,
      `Fault record ${f.fault_code} (${new Date(f.timestamp).toISOString().slice(0, 10)})`,
    ]
  );

  await embedPendingChunks(50);
}

/** Compute embeddings for chunks that do not have one yet. */
export async function embedPendingChunks(batchSize = 100): Promise<number> {
  if (!(await hasPgVector())) return 0;
  const provider = getEmbeddingProvider();
  if (!provider) return 0;

  const { rows } = await pool.query(
    `SELECT id, title, content FROM knowledge_chunks WHERE embedding IS NULL LIMIT $1`,
    [batchSize]
  );
  if (!rows.length) return 0;

  try {
    const embeddings = await provider.embed(rows.map((r) => `${r.title}\n\n${r.content}`));
    for (let i = 0; i < rows.length; i++) {
      await pool.query(`UPDATE knowledge_chunks SET embedding = $2::vector WHERE id = $1`, [
        rows[i].id,
        `[${embeddings[i].join(',')}]`,
      ]);
    }
    return rows.length;
  } catch {
    // Leave them unembedded; lexical retrieval still finds them.
    return 0;
  }
}
