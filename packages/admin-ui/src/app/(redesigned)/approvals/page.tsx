'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  listPendingApprovals,
  reviewDecision,
  type PolicyDecision,
} from '@/lib/api';
import { V2Shell } from '@/components/v2/shell';
import { StatusPill, relTime } from '@/components/v2/primitives';
import { useV2Nav } from '@/components/v2/nav';
import { ArrowLeft, AlertTriangle, Check, X } from 'lucide-react';
import clsx from 'clsx';

const POLL_MS = 15_000;
const WS_URL = 'ws://127.0.0.1:7710/ws/approvals';

type Tab = 'pending' | 'reviewed' | 'all';

export default function ApprovalsV2() {
  const navigate = useV2Nav();
  const [items, setItems] = useState<PolicyDecision[]>([]);
  const [tab, setTab] = useState<Tab>('pending');
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  const load = useCallback(async () => {
    try {
      const next = await listPendingApprovals();
      setItems(next ?? []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load approvals');
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // WebSocket live updates + polling fallback
  useEffect(() => {
    let ws: WebSocket | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;

    function connect() {
      try {
        ws = new WebSocket(WS_URL);
        wsRef.current = ws;
        ws.onmessage = (e) => {
          try {
            const m = JSON.parse(e.data as string);
            if (m.kind === 'new_approval' || m.event === 'approval_created') load();
          } catch { /* ignore */ }
        };
        ws.onclose = () => { setTimeout(connect, 5000); };
        ws.onerror = () => { ws?.close(); };
      } catch { /* ignore */ }
    }
    connect();
    pollTimer = setInterval(load, POLL_MS);
    return () => {
      ws?.close();
      if (pollTimer) clearInterval(pollTimer);
    };
  }, [load]);

  const counts = useMemo(() => ({
    pending:  items.filter((i) => !i.review?.reviewedAt).length,
    reviewed: items.filter((i) => !!i.review?.reviewedAt).length,
    all:      items.length,
  }), [items]);

  const filtered = useMemo(() => {
    const tabFiltered = items.filter((d) =>
      tab === 'pending'  ? !d.review?.reviewedAt
      : tab === 'reviewed' ? !!d.review?.reviewedAt
      : true
    );
    if (!search.trim()) return tabFiltered;
    const q = search.toLowerCase();
    return tabFiltered.filter(
      (d) =>
        d.actorLabel.toLowerCase().includes(q) ||
        d.proposedActionKind.toLowerCase().includes(q) ||
        d.proposedActionSummary.toLowerCase().includes(q)
    );
  }, [items, tab, search]);

  // Auto-select first when list changes and current selection drops out
  useEffect(() => {
    if (filtered.length === 0) { setSelectedId(null); return; }
    if (!selectedId || !filtered.some((d) => d.id === selectedId)) {
      setSelectedId(filtered[0].id);
    }
  }, [filtered, selectedId]);

  const selected = items.find((d) => d.id === selectedId) ?? null;

  async function review(decision: 'approve' | 'reject' | 'return_to_author') {
    if (!selected) return;
    if (decision === 'return_to_author' && !notes.trim()) {
      setError('Notes are required when returning to author.');
      return;
    }
    setSubmitting(true);
    try {
      await reviewDecision(selected.id, { decision, note: notes.trim() || undefined });
      setNotes('');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Review failed');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <V2Shell
      active="approvals"
      onNav={navigate}
      triageCount={counts.pending}
    >
      <div style={{ display: 'grid', gridTemplateColumns: '400px 1fr', flex: 1, minHeight: 0, overflow: 'hidden' }}>
        {/* Master list */}
        <div style={{ borderRight: '1px solid var(--rule)', display: 'flex', flexDirection: 'column', overflow: 'hidden', background: 'var(--bg-card)' }}>
          <div style={{ padding: '14px 16px 0', flexShrink: 0 }}>
            <div className="eyebrow">APPROVALS</div>
            <h2 className="serif" style={{ fontSize: 20, margin: '4px 0 0', letterSpacing: '-0.01em' }}>Reviewer queue</h2>
            <div style={{ display: 'flex', gap: 0, marginTop: 14 }}>
              {(['pending', 'reviewed', 'all'] as Tab[]).map((t) => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  style={{
                    padding: '8px 14px',
                    background: 'transparent',
                    border: 'none',
                    borderBottom: tab === t ? '2px solid var(--accent)' : '2px solid transparent',
                    color: tab === t ? 'var(--ink)' : 'var(--ink-3)',
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: 11,
                    letterSpacing: '.1em',
                    textTransform: 'uppercase',
                    fontWeight: tab === t ? 600 : 400,
                    cursor: 'pointer',
                  }}
                >
                  {t} <span style={{ color: 'var(--ink-4)', marginLeft: 6 }}>{counts[t]}</span>
                </button>
              ))}
            </div>
          </div>

          <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--rule)' }}>
            <input
              className="form-input"
              placeholder="Search by actor, action kind…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>

          <ul style={{ listStyle: 'none', margin: 0, padding: 0, overflowY: 'auto', flex: 1 }}>
            {filtered.map((d) => (
              <ApprovalRow
                key={d.id}
                d={d}
                active={selectedId === d.id}
                onClick={() => { setSelectedId(d.id); setNotes(''); setError(null); }}
              />
            ))}
            {filtered.length === 0 && (
              <li style={{ padding: 24, color: 'var(--ink-3)', fontSize: 13, textAlign: 'center' }}>
                {tab === 'pending' ? 'Queue is clear.' : 'Nothing matches.'}
              </li>
            )}
          </ul>
        </div>

        {/* Detail */}
        <div style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <div style={{ flex: 1, overflowY: 'auto' }}>
            {selected ? (
              <ApprovalDetail d={selected} notes={notes} setNotes={setNotes} error={error} />
            ) : (
              <div style={{ padding: 32, color: 'var(--ink-3)' }}>Select an item to review.</div>
            )}
          </div>

          {selected && !selected.review?.reviewedAt && (
            <div
              style={{
                borderTop: '1px solid var(--rule)',
                background: 'var(--bg-card)',
                padding: '12px 24px',
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                flexShrink: 0,
              }}
            >
              <span className="mono" style={{ fontSize: 11, color: 'var(--ink-3)', letterSpacing: '.06em' }}>
                <kbd style={kbd}>J</kbd>/<kbd style={kbd}>K</kbd> next/prev · <kbd style={kbd}>A</kbd> approve · <kbd style={kbd}>R</kbd> reject · <kbd style={kbd}>T</kbd> return
              </span>
              <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
                <button
                  className="btn btn-secondary"
                  disabled={submitting}
                  onClick={() => review('return_to_author')}
                >
                  <ArrowLeft size={13} strokeWidth={1.6} />Return to author
                </button>
                <button
                  className="btn btn-danger"
                  disabled={submitting}
                  onClick={() => review('reject')}
                >
                  <X size={13} strokeWidth={1.6} />Reject
                </button>
                <button
                  className="btn btn-primary"
                  disabled={submitting}
                  onClick={() => review('approve')}
                >
                  <Check size={13} strokeWidth={1.6} />Approve
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </V2Shell>
  );
}

const kbd: React.CSSProperties = {
  background: 'var(--bg-2)',
  border: '1px solid var(--rule-2)',
  borderRadius: 2,
  padding: '1px 5px',
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: 10,
  color: 'var(--ink-2)',
};

function ApprovalRow({ d, active, onClick }: { d: PolicyDecision; active: boolean; onClick: () => void }) {
  const reviewed = !!d.review?.reviewedAt;
  const dec = d.review?.reviewDecision ?? null;
  // Severity isn't on the API surface yet — derive a faint indicator from action kind for now
  const sevColor = reviewed ? 'transparent' : 'var(--warn)';

  return (
    <li
      onClick={onClick}
      style={{
        padding: '14px 16px',
        borderBottom: '1px solid var(--rule)',
        cursor: 'pointer',
        background: active ? 'var(--bg-2)' : 'transparent',
        borderLeft: active ? '2px solid var(--accent)' : `2px solid ${sevColor}`,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <span className="mono" style={{ fontSize: 10, color: 'var(--ink-3)', letterSpacing: '.06em', flex: 1 }}>
          {d.proposedActionKind}
        </span>
        <span className="mono tabular" style={{ fontSize: 10, color: 'var(--ink-3)' }}>
          {relTime(d.proposedAt)}
        </span>
      </div>
      <div style={{ fontSize: 13, color: 'var(--ink)', lineHeight: 1.45, marginBottom: 8 }}>
        {d.proposedActionSummary}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span className="mono" style={{ fontSize: 11, color: 'var(--ink-2)' }}>{d.actorLabel}</span>
        {!reviewed && <StatusPill kind="warn">route_to_review</StatusPill>}
        {reviewed && dec === 'approve' && <StatusPill kind="success">approved</StatusPill>}
        {reviewed && dec === 'reject' && <StatusPill kind="error">rejected</StatusPill>}
        {reviewed && dec === 'return_to_author' && <StatusPill kind="muted">returned</StatusPill>}
      </div>
    </li>
  );
}

function ApprovalDetail({
  d, notes, setNotes, error,
}: {
  d: PolicyDecision;
  notes: string;
  setNotes: (v: string) => void;
  error: string | null;
}) {
  return (
    <div>
      <div style={{ padding: '24px 28px 18px', borderBottom: '1px solid var(--rule)' }}>
        <div className="eyebrow accent">ACTION · {d.proposedActionKind}</div>
        <h2
          className="serif"
          style={{ fontSize: 24, margin: '8px 0 12px', letterSpacing: '-0.018em', lineHeight: 1.25 }}
        >
          {d.proposedActionSummary}
        </h2>
        <div
          style={{
            display: 'flex',
            gap: 12,
            flexWrap: 'wrap',
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 11,
            color: 'var(--ink-3)',
            letterSpacing: '.04em',
          }}
        >
          <span>ACTOR · <b style={{ color: 'var(--ink-2)' }}>{d.actorLabel}</b></span>
          <span>PROPOSED · <b style={{ color: 'var(--ink-2)' }}>{relTime(d.proposedAt)}</b></span>
          <span>TENANT · <b style={{ color: 'var(--ink-2)' }}>{d.tenantId.slice(0, 8)}…</b></span>
          {d.shadowMode && <span style={{ color: 'var(--warn)' }}>SHADOW</span>}
        </div>
      </div>

      <Section title="Why it routed to review">
        <div
          style={{
            padding: '14px 16px',
            background: 'var(--warn-soft)',
            border: '1px solid var(--warn)',
            borderRadius: 2,
            display: 'flex',
            gap: 12,
            alignItems: 'flex-start',
          }}
        >
          <AlertTriangle size={16} strokeWidth={1.6} style={{ color: 'var(--warn)', flexShrink: 0 }} />
          <div>
            <div style={{ fontWeight: 500, fontSize: 13, color: 'var(--ink)' }}>Routed by rule pack chain</div>
            <div style={{ fontSize: 13, color: 'var(--ink-2)', marginTop: 4, lineHeight: 1.55 }}>
              {d.decisionReason || '—'}
            </div>
          </div>
        </div>
      </Section>

      <Section title="Rule packs that fired">
        <div style={{ fontSize: 13, color: 'var(--ink-3)' }}>
          Per-rule hit detail not exposed via <span className="mono">/api/approval-queue</span> yet —
          add when the substrate ships <span className="mono">decisions.hits</span>.
        </div>
      </Section>

      {d.review?.reviewedAt ? (
        <Section title="Review">
          <div className="card" style={{ padding: '12px 14px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginBottom: 6 }}>
              <span className="mono" style={{ fontSize: 11, color: 'var(--ink-2)' }}>
                {d.review.reviewedByLabel ?? d.review.reviewedBy ?? 'reviewer'}
              </span>
              <span className="mono tabular" style={{ fontSize: 11, color: 'var(--ink-3)' }}>
                {relTime(d.review.reviewedAt)}
              </span>
            </div>
            <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
              {d.review.reviewDecision === 'approve' && <StatusPill kind="success">approved</StatusPill>}
              {d.review.reviewDecision === 'reject' && <StatusPill kind="error">rejected</StatusPill>}
              {d.review.reviewDecision === 'return_to_author' && <StatusPill kind="muted">returned</StatusPill>}
            </div>
            {d.review.reviewNote && (
              <div style={{ fontSize: 13, color: 'var(--ink-2)', lineHeight: 1.55 }}>{d.review.reviewNote}</div>
            )}
          </div>
        </Section>
      ) : (
        <Section title="Reviewer notes">
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Required when returning to author. Optional otherwise."
            rows={3}
            style={{
              width: '100%',
              padding: '10px 12px',
              fontSize: 13,
              fontFamily: 'inherit',
              color: 'var(--ink)',
              background: 'var(--bg-card)',
              border: '1px solid var(--rule-2)',
              borderRadius: 2,
              resize: 'vertical',
            }}
          />
          {error && (
            <div style={{ marginTop: 8, fontSize: 12, color: 'var(--err)' }}>{error}</div>
          )}
        </Section>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section style={{ padding: '20px 28px', borderBottom: '1px solid var(--rule)' }}>
      <div className="eyebrow" style={{ marginBottom: 12 }}>{title}</div>
      {children}
    </section>
  );
}
