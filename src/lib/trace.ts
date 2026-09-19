/**
 * Decision trace — reduces the agent's SSE stream into the six-step timeline
 * (Order → Policy → Evidence → Fraud → Execute → Record) plus the recorded
 * decision, so the right-hand "Decision trace" panel can light up live.
 *
 * Works for both backend modes:
 *   - deterministic: claim{mode} → tool_called … → text_delta → decision → done
 *   - llm: same, plus `debug_msg` frames (a `user` message = a tool result came back)
 *
 * A step is `running` from its tool_called until the next tool call, a tool
 * result, prose, the decision, or the end of the stream. Steps that never ran
 * by the end are `skipped` (no video → no Evidence/Fraud; denied → no Execute).
 */

import type { RawSseEvent } from '../api';
import type { Decision, ToolCallTrace } from '../types';
import { normalizeDecision } from './decision';

export const STEP_IDS = ['order', 'policy', 'evidence', 'fraud', 'execute', 'record'] as const;
export type StepId = typeof STEP_IDS[number];
export type StepStatus = 'pending' | 'running' | 'done' | 'skipped' | 'error';

export interface TraceStep {
  id: StepId;
  status: StepStatus;
  startedAt?: number;
  endedAt?: number;
  /** Tool names that fed this step, in call order (e.g. execute_refund, escalate). */
  tools: string[];
}

export interface TraceState {
  runId: number;
  phase: 'idle' | 'running' | 'done' | 'stopped' | 'error';
  startedAt?: number;
  endedAt?: number;
  claimId?: string;
  /** Human-friendly claim number ("C-A1043-F809") when the backend announces it. */
  displayId?: string;
  customerName?: string;
  /** `deterministic` | `llm` (only the deterministic runner announces it). */
  mode?: string;
  /** "Policy engine" | "AI model · <model>" when the backend announces it. */
  modeLabel?: string;
  steps: TraceStep[];
  toolCalls: Array<{ tool: string; at: number; step: StepId | null }>;
  decision?: Decision;
  decisionStatus?: string;
  traceId?: string | null;
  agentxEmitted?: boolean;
  error?: string;
}

export type TraceAction =
  | { type: 'start'; at: number }
  | { type: 'event'; event: RawSseEvent; at: number }
  | { type: 'finish'; at: number; stopped?: boolean; error?: string }
  | { type: 'reset' };

/**
 * Map a ClaimSight MCP tool name onto a timeline step. The backend strips the
 * `mcp__claimsight__` prefix, but substring matching keeps either spelling working
 * and tolerates an LLM that names tools slightly differently.
 */
export function toolToStep(toolName: string): StepId | null {
  const name = (toolName || '').toLowerCase();
  if (!name) return null;
  if (name.includes('record') || name.includes('agentx') || name.includes('emit')) return 'record';
  if (name.includes('evidence') || name.includes('inspect') || name.includes('video') || name.includes('caption')) return 'evidence';
  if (name.includes('fraud') || name.includes('similar') || name.includes('twin') || name.includes('search')) return 'fraud';
  if (name.includes('policy')) return 'policy';
  if (name.includes('lookup') || name.includes('order')) return 'order';
  if (name.includes('refund') || name.includes('replacement') || name.includes('escalat') || name.includes('execute')) return 'execute';
  if ((STEP_IDS as readonly string[]).includes(name)) return name as StepId;
  return null;
}

export function freshSteps(): TraceStep[] {
  return STEP_IDS.map(id => ({ id, status: 'pending', tools: [] }));
}

export function createTrace(): TraceState {
  return { runId: 0, phase: 'idle', steps: freshSteps(), toolCalls: [] };
}

function settleRunning(steps: TraceStep[], at: number, status: StepStatus = 'done'): TraceStep[] {
  let changed = false;
  const next = steps.map(s => {
    if (s.status !== 'running') return s;
    changed = true;
    return { ...s, status, endedAt: at };
  });
  return changed ? next : steps;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
}

export function traceReducer(state: TraceState, action: TraceAction): TraceState {
  switch (action.type) {
    case 'reset':
      return createTrace();

    case 'start':
      return {
        runId: state.runId + 1,
        phase: 'running',
        startedAt: action.at,
        steps: freshSteps(),
        toolCalls: [],
      };

    case 'finish': {
      if (state.phase !== 'running') return state;
      const settled = settleRunning(state.steps, action.at, action.error ? 'error' : 'done');
      return {
        ...state,
        phase: action.error ? 'error' : action.stopped ? 'stopped' : 'done',
        endedAt: action.at,
        error: action.error ?? state.error,
        steps: settled.map(s => (s.status === 'pending' ? { ...s, status: 'skipped' } : s)),
      };
    }

    case 'event': {
      if (state.phase !== 'running') return state;
      const { event, at } = action;
      const data = asRecord(event.data);

      switch (event.eventType) {
        case 'claim': {
          const claimId = typeof data?.claim_id === 'string' ? data.claim_id : state.claimId;
          const mode = typeof data?.mode === 'string' ? data.mode : state.mode;
          const displayId = typeof data?.display_id === 'string' ? data.display_id : state.displayId;
          const customerName = typeof data?.customer_name === 'string' ? data.customer_name : state.customerName;
          const modeLabel = typeof data?.mode_label === 'string' ? data.mode_label : state.modeLabel;
          return { ...state, claimId, mode, displayId, customerName, modeLabel };
        }

        case 'tool_called': {
          const tool = typeof data?.tool === 'string' ? data.tool : '';
          const step = toolToStep(tool);
          const toolCalls = [...state.toolCalls, { tool, at, step }];
          if (!step) return { ...state, toolCalls };
          const running = state.steps.find(s => s.status === 'running');
          let steps = running && running.id !== step ? settleRunning(state.steps, at) : state.steps;
          steps = steps.map(s => {
            if (s.id !== step) return s;
            return {
              ...s,
              status: 'running',
              startedAt: s.status === 'running' ? s.startedAt : at,
              endedAt: undefined,
              tools: [...s.tools, tool],
            };
          });
          return { ...state, steps, toolCalls };
        }

        case 'debug_msg': {
          // LLM mode: the SDK's `user` message carries the tool result → the running step is done.
          if (data?.msgType === 'user') return { ...state, steps: settleRunning(state.steps, at) };
          return state;
        }

        case 'text_delta':
          return { ...state, steps: settleRunning(state.steps, at) };

        case 'decision': {
          const block = asRecord(data?.decision);
          const decision = block ? normalizeDecision(block) : state.decision;
          const decisionStatus = typeof data?.status === 'string' ? data.status : state.decisionStatus;
          const traceId = data && 'trace_id' in data ? (data.trace_id as string | null) : state.traceId;
          const agentxEmitted = typeof data?.agentx_emitted === 'boolean' ? data.agentx_emitted : state.agentxEmitted;
          let steps = settleRunning(state.steps, at);
          // The decision exists, so the record step happened even if we never saw its tool_called.
          steps = steps.map(s => (s.id === 'record' && s.status === 'pending' ? { ...s, status: 'done', startedAt: at, endedAt: at } : s));
          const displayId = (typeof data?.display_id === 'string' ? data.display_id : undefined) ?? decision?.display_id ?? state.displayId;
          const customerName = (typeof data?.customer_name === 'string' ? data.customer_name : undefined) ?? decision?.customer_name ?? state.customerName;
          const modeLabel = (typeof data?.mode_label === 'string' ? data.mode_label : undefined) ?? decision?.mode_label ?? state.modeLabel;
          return { ...state, decision, decisionStatus, traceId, agentxEmitted, steps, displayId, customerName, modeLabel };
        }

        case 'error': {
          const message = typeof data?.message === 'string' ? data.message : 'agent error';
          return { ...state, error: message, steps: settleRunning(state.steps, at, 'error') };
        }

        default:
          return state;
      }
    }

    default:
      return state;
  }
}

/** Wall-clock duration of a step (live while running). */
export function stepElapsedMs(step: TraceStep, now: number): number | undefined {
  if (step.startedAt === undefined) return undefined;
  return Math.max(0, (step.endedAt ?? now) - step.startedAt);
}

export function traceElapsedMs(state: TraceState, now: number): number | undefined {
  if (state.startedAt === undefined) return undefined;
  return Math.max(0, (state.endedAt ?? now) - state.startedAt);
}

/**
 * Rebuild a timeline from a stored claim record's `tool_calls` (Refund Desk
 * detail drawer): every tool that ran is `done` (or `error`), the rest `skipped`.
 * The record itself is written by `record_decision`, whose own call is not in
 * the snapshot yet, so `recorded` marks the Record step done.
 */
export function stepsFromToolCalls(toolCalls: ToolCallTrace[] | undefined | null, recorded = true): TraceStep[] {
  const steps = freshSteps();
  if (!Array.isArray(toolCalls)) {
    return steps.map(s => (s.id === 'record' && recorded ? { ...s, status: 'done', tools: ['record_decision'] } : { ...s, status: 'skipped' }));
  }
  if (recorded) {
    const record = steps.find(s => s.id === 'record')!;
    record.status = 'done';
    record.tools.push('record_decision');
  }
  for (const call of toolCalls) {
    const id = toolToStep(call?.name ?? '');
    if (!id) continue;
    const step = steps.find(s => s.id === id)!;
    const started = typeof call.started_at === 'number' ? call.started_at : undefined;
    const ended = typeof call.ended_at === 'number' ? call.ended_at : started;
    if (!step.tools.includes(call.name)) step.tools.push(call.name);
    step.startedAt = step.startedAt === undefined ? started : Math.min(step.startedAt, started ?? step.startedAt);
    step.endedAt = step.endedAt === undefined ? ended : Math.max(step.endedAt, ended ?? step.endedAt);
    step.status = call.ok === false ? 'error' : (step.status === 'error' ? 'error' : 'done');
  }
  return steps.map(s => (s.status === 'pending' ? { ...s, status: 'skipped' } : s));
}
