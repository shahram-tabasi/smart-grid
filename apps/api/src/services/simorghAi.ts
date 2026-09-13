import { pool } from '../db/pool';
import { analyseFaultWithLlm, deterministicShape, FaultAnalysisInput, EngineResult } from './aiEngine';
import { retrieve } from './aiRetrieval';

/**
 * Simorgh Power Intelligence / Simorgh Grid Copilot — deterministic, rule-based Phase-1 implementation
 * behind the AI service contract described in docs/ARCHITECTURE.md §8.
 *
 * HARD BOUNDARY: every function in this file only ever SELECTs data and, where noted, INSERTs an
 * analysis/chat record. Nothing here writes to relays, breakers, panels, switchgear, substations,
 * projects, or protection_functions — there is no code path from this file to a control action.
 * Swapping this rule-based engine for an LLM-backed one later (with pgvector/Qdrant retrieval) means
 * replacing the internals of this file; the contract (function signatures + evidence-citing answers)
 * stays the same.
 */

export interface ChatAnswer {
  answer: string;
  evidence: Array<Record<string, unknown>>;
}

async function projectsWithHighestFaultRate(days = 30, limit = 5) {
  const { rows } = await pool.query(
    `SELECT p.code, p.name, COUNT(f.id) AS fault_count,
            COUNT(f.id) FILTER (WHERE f.severity = 'CRITICAL') AS critical_count
     FROM faults f JOIN projects p ON p.id = f.project_id
     WHERE f."timestamp" > now() - ($1 || ' days')::interval
     GROUP BY p.id, p.code, p.name
     ORDER BY fault_count DESC LIMIT $2`,
    [days, limit]
  );
  return rows;
}

async function relaysWithMostTrips(limit = 5) {
  const { rows } = await pool.query(
    `SELECT relay_code, manufacturer, model, trip_count, health_status, health_score
     FROM relays WHERE trip_count > 0 ORDER BY trip_count DESC LIMIT $1`,
    [limit]
  );
  return rows;
}

async function citiesWithHighestFaults(days = 90, limit = 5) {
  const { rows } = await pool.query(
    `SELECT c.name_en, c.name_fa, COUNT(f.id) AS fault_count
     FROM faults f JOIN cities c ON c.id = f.city_id
     WHERE f."timestamp" > now() - ($1 || ' days')::interval
     GROUP BY c.id, c.name_en, c.name_fa ORDER BY fault_count DESC LIMIT $2`,
    [days, limit]
  );
  return rows;
}

async function projectsAtRiskOfDelay(limit = 5) {
  const { rows } = await pool.query(
    `SELECT code, name, status, expected_completion, overall_progress, health_score
     FROM projects
     WHERE status NOT IN ('RUNNING','COMPLETED','BLOCKED')
       AND expected_completion IS NOT NULL
       AND (expected_completion < (now() + INTERVAL '30 days') AND overall_progress < 85)
     ORDER BY expected_completion ASC LIMIT $1`,
    [limit]
  );
  return rows;
}

async function relayToInspectFirst() {
  const { rows } = await pool.query(
    `SELECT relay_code, manufacturer, model, health_score, health_status, trip_count, alarm_count,
            comm_status
     FROM relays ORDER BY health_score ASC LIMIT 1`
  );
  return rows[0];
}

async function cityActivityToday(cityName: string) {
  const { rows } = await pool.query(
    `SELECT f.fault_code, f.fault_type, f.severity, f."timestamp", p.code AS project_code
     FROM faults f JOIN projects p ON p.id = f.project_id JOIN cities c ON c.id = f.city_id
     WHERE (c.name_en ILIKE $1 OR c.name_fa ILIKE $1) AND f."timestamp" > now() - INTERVAL '24 hours'
     ORDER BY f."timestamp" DESC`,
    [`%${cityName}%`]
  );
  return rows;
}

async function correlatedAlarmGroups(limit = 5) {
  const { rows } = await pool.query(
    `SELECT g.id, g.root_cause, COUNT(a.id) AS alarm_count
     FROM alarm_correlation_groups g JOIN alarms a ON a.correlation_group_id = g.id
     GROUP BY g.id, g.root_cause HAVING COUNT(a.id) > 1 ORDER BY alarm_count DESC LIMIT $1`,
    [limit]
  );
  return rows;
}

/**
 * Very small intent router over a natural-language question. This is intentionally simple pattern
 * matching (not an LLM) for Phase 1 — see the file header. It always answers with the evidence rows
 * that back the answer, per spec §28 ("AI must always show the evidence/data behind important
 * conclusions").
 */
export async function answerChatQuestion(question: string): Promise<ChatAnswer> {
  const q = question.toLowerCase();

  if (/(highest|worst|most).*(fault|trip)/.test(q) || /fault rate/.test(q)) {
    const rows = await projectsWithHighestFaultRate();
    if (!rows.length) return { answer: 'No faults recorded in the last 30 days across any project.', evidence: [] };
    const top = rows.slice(0, 3).map((r) => `${r.code} (${r.fault_count} faults, ${r.critical_count} critical)`).join(', ');
    return { answer: `${Math.min(rows.length, 3)} projects show elevated fault activity in the last 30 days: ${top}.`, evidence: rows };
  }

  if (/repeated trip|most trip|frequent trip/.test(q)) {
    const rows = await relaysWithMostTrips();
    if (!rows.length) return { answer: 'No relay has recorded more than one trip recently.', evidence: [] };
    const r0 = rows[0];
    return {
      answer: `Relay ${r0.relay_code} (${r0.manufacturer} ${r0.model}) has the most repeated trips — ${r0.trip_count} in the recorded history, current health status ${r0.health_status}.`,
      evidence: rows,
    };
  }

  if (/which relay.*inspect|inspect first|inspect.*priority/.test(q)) {
    const relay = await relayToInspectFirst();
    if (!relay) return { answer: 'No relay data available.', evidence: [] };
    return {
      answer: `${relay.relay_code} (${relay.manufacturer} ${relay.model}) should be inspected first — health score ${relay.health_score}/100 (${relay.health_status}), ${relay.trip_count} trips, ${relay.alarm_count} open alarms, communication ${relay.comm_status}.`,
      evidence: [relay],
    };
  }

  if (/highest number of fault|which cit(y|ies)/.test(q)) {
    const rows = await citiesWithHighestFaults();
    if (!rows.length) return { answer: 'No fault data available across cities yet.', evidence: [] };
    const top = rows.slice(0, 3).map((r) => `${r.name_en} (${r.fault_count})`).join(', ');
    return { answer: `Highest fault counts in the last 90 days: ${top}.`, evidence: rows };
  }

  if (/risk of delay|delayed|schedule risk/.test(q)) {
    const rows = await projectsAtRiskOfDelay();
    if (!rows.length) return { answer: 'No projects currently flagged at risk of missing their expected completion date.', evidence: [] };
    const top = rows.slice(0, 5).map((r) => `${r.code} (${r.overall_progress}% complete, due ${new Date(r.expected_completion).toISOString().slice(0, 10)})`).join(', ');
    return { answer: `${rows.length} project(s) are at risk of delay: ${top}.`, evidence: rows };
  }

  if (/what happened in|today/.test(q)) {
    const cityMatch = q.match(/what happened in ([a-z ]+?)(?: today)?\??$/) || q.match(/([a-z]+) today/);
    const cityName = cityMatch ? cityMatch[1].trim() : '';
    if (cityName) {
      const rows = await cityActivityToday(cityName);
      if (!rows.length) return { answer: `No significant events recorded in ${cityName} in the last 24 hours.`, evidence: [] };
      const projectsInvolved = new Set(rows.map((r) => r.project_code)).size;
      return {
        answer: `${rows.length} significant event(s) recorded in ${cityName} in the last 24 hours across ${projectsInvolved} project(s). Most recent: ${rows[0].fault_type} (${rows[0].severity}) on ${rows[0].project_code}.`,
        evidence: rows,
      };
    }
  }

  if (/related to one root cause|same root cause|correlated/.test(q)) {
    const rows = await correlatedAlarmGroups();
    if (!rows.length) return { answer: 'No currently correlated alarm groups — each open alarm is being tracked as an independent event.', evidence: [] };
    return {
      answer: `Yes — ${rows.length} group(s) of alarms have been correlated to a shared root cause, e.g. "${rows[0].root_cause}" (${rows[0].alarm_count} alarms).`,
      evidence: rows,
    };
  }

  // Generic fallback: a national snapshot, always grounded in the same KPI views the dashboard uses.
  const { rows: kpi } = await pool.query('SELECT * FROM v_project_kpis');
  const { rows: relayKpi } = await pool.query('SELECT * FROM v_relay_kpis');
  return {
    answer: `National snapshot: ${kpi[0].total_projects} projects (${kpi[0].running_projects} running, ${kpi[0].critical_projects} critical), ${relayKpi[0].total_relays} relays (${relayKpi[0].offline_relays} offline). Ask about fault rates, repeated trips, at-risk projects, or a specific city for more detail.`,
    evidence: [kpi[0], relayKpi[0]],
  };
}

/**
 * Root-cause analysis for a single fault (spec §11). If one already exists (e.g. from seed data or a
 * prior call) it's returned as-is; otherwise it's generated deterministically from the fault + its
 * timeline and persisted. Never touches anything outside ai_analyses.
 */
export async function generateOrFetchRootCauseAnalysis(faultId: string) {
  const { rows: existing } = await pool.query('SELECT * FROM ai_analyses WHERE fault_id = $1 ORDER BY created_at DESC LIMIT 1', [faultId]);
  if (existing[0]) return existing[0];

  const { rows: faultRows } = await pool.query(
    `SELECT f.*, r.relay_code, r.manufacturer, r.model, r.id AS relay_uuid, pnl.name AS panel_name,
            p.code AS project_code, p.id AS project_uuid,
            c.name_en AS city_name_en, pr.name_en AS province_name_en
     FROM faults f
     LEFT JOIN relays r ON r.id = f.relay_id
     LEFT JOIN panels pnl ON pnl.id = f.panel_id
     JOIN projects p ON p.id = f.project_id
     JOIN cities c ON c.id = f.city_id
     JOIN provinces pr ON pr.id = p.province_id
     WHERE f.id = $1`,
    [faultId]
  );
  const fault = faultRows[0];
  if (!fault) return null;

  // Pull the timeline including each entry's timestamp trust, so the engine can say honestly when
  // an ordering cannot be relied upon.
  const { rows: timeline } = await pool.query(
    `SELECT fte.description, fte.event_id, fte."time",
            COALESCE(e.time_sync_quality::text, 'UNKNOWN') AS time_sync_quality
     FROM fault_timeline_entries fte
     LEFT JOIN events e ON e.id = fte.event_id
     WHERE fte.fault_id = $1 ORDER BY fte.sequence_no`,
    [faultId]
  );
  const relatedEventIds = timeline.map((t) => t.event_id).filter(Boolean);

  const input: FaultAnalysisInput = {
    faultCode: fault.fault_code,
    faultType: fault.fault_type,
    protectionFunction: fault.protection_function ?? null,
    severity: fault.severity,
    tripStatus: fault.trip_status ?? null,
    relayCode: fault.relay_code ?? null,
    manufacturer: fault.manufacturer ?? null,
    model: fault.model ?? null,
    panelName: fault.panel_name ?? null,
    projectCode: fault.project_code ?? null,
    cityName: fault.city_name_en ?? null,
    provinceName: fault.province_name_en ?? null,
    currentA: fault.current_a != null ? Number(fault.current_a) : null,
    voltageKv: fault.voltage_kv != null ? Number(fault.voltage_kv) : null,
    timeline: timeline.map((t) => ({
      description: t.description,
      time: new Date(t.time).toISOString(),
      timeSyncQuality: t.time_sync_quality,
    })),
    relayId: fault.relay_uuid ?? null,
    projectId: fault.project_uuid ?? null,
  };

  // Try the retrieval-augmented LLM path. It returns a deterministic result (with a recorded
  // fallbackReason) rather than throwing whenever the model is unavailable or its answer fails
  // validation, so this call always yields something usable.
  let result: EngineResult;
  const llm = await analyseFaultWithLlm(input);
  if (llm) {
    result = llm;
  } else {
    result = {
      ...deterministicShape(input),
      retrievedChunkIds: [],
      engine: 'simorgh-rules-v1',
    };
  }

  const { rows: inserted } = await pool.query(
    `INSERT INTO ai_analyses (
       fault_id, event_id, summary, probable_cause, confidence_score, evidence, related_event_ids,
       recommended_action, required_engineer_role, priority, engine, retrieved_chunk_ids,
       prompt_tokens, completion_tokens, fallback_reason)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
    [
      faultId,
      fault.event_id,
      result.summary,
      result.probableCause,
      result.confidence,
      JSON.stringify(result.evidence),
      JSON.stringify(relatedEventIds),
      result.recommendedAction,
      result.requiredEngineerRole,
      fault.severity === 'CRITICAL' ? 'CRITICAL' : 'HIGH',
      result.engine,
      JSON.stringify(result.retrievedChunkIds),
      result.promptTokens ?? null,
      result.completionTokens ?? null,
      result.fallbackReason ?? null,
    ]
  );
  return inserted[0];
}

/**
 * Retrieval-backed variant of the chat assistant. When a knowledge corpus and a model are
 * configured, questions that the intent router does not recognise are answered from retrieved
 * context instead of the generic national snapshot — still with citations, per spec §28.
 */
export async function answerChatQuestionWithRetrieval(question: string): Promise<ChatAnswer> {
  const base = await answerChatQuestion(question);

  // The generic fallback answer is the one worth improving; specific intents already answer well.
  const isGenericFallback = base.answer.startsWith('National snapshot:');
  if (!isGenericFallback) return base;

  const chunks = await retrieve(question, { limit: 5 }).catch(() => []);
  if (!chunks.length) return base;

  return {
    answer:
      `${base.answer}\n\nRelated recorded knowledge: ` +
      chunks.map((c) => `${c.title} (${c.citation})`).join('; '),
    evidence: [...base.evidence, ...chunks.map((c) => ({ title: c.title, citation: c.citation, excerpt: c.content.slice(0, 300) }))],
  };
}
