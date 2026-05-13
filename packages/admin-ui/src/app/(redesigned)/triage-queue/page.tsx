'use client';

import type React from 'react';
import { useEffect, useMemo, useState } from 'react';
import { V2Shell } from '@/components/v2/shell';
import { useV2Nav } from '@/components/v2/nav';
import { relTime } from '@/components/v2/primitives';
import {
  getTriageQueue,
  assignTriageIssue,
  listTenants,
  listCompanies,
  listCompanyProjects,
  createIssue,
  type TriageIssue,
  type TriageAgent,
  type Tenant,
  type ExecutionCompany,
  type ExecutionProject,
} from '@/lib/api';
import { Plus, X } from 'lucide-react';

const PRIORITY_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

function prioColor(p: string): string {
  if (p === 'critical') return 'var(--err)';
  if (p === 'high')     return 'var(--warn)';
  if (p === 'medium')   return 'var(--accent)';
  return 'var(--ink-3)';
}

export default function TriageQueueV2() {
  const navigate = useV2Nav();
  const [issues, setIssues] = useState<TriageIssue[]>([]);
  const [agents, setAgents] = useState<TriageAgent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pickedAgent, setPickedAgent] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  async function load() {
    try {
      const data = await getTriageQueue();
      setIssues(data.issues);
      setAgents(data.agents);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load triage queue');
    }
  }
  useEffect(() => { load(); }, []);

  const sorted = useMemo(() =>
    [...issues].sort((a, b) =>
      (PRIORITY_ORDER[a.priority] ?? 99) - (PRIORITY_ORDER[b.priority] ?? 99)
    ), [issues]);

  async function assign(id: string) {
    const ag = pickedAgent[id];
    if (!ag) return;
    setBusy(id);
    try { await assignTriageIssue(id, ag); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Assign failed'); }
    finally  { setBusy(null); }
  }

  return (
    <V2Shell active="triage-queue" onNav={navigate} triageCount={issues.length}>
      <div style={{ padding: '24px 28px', display: 'flex', flexDirection: 'column', gap: 18, overflowY: 'auto' }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 18 }}>
          <div>
            <div className="eyebrow">GOVERN · TRIAGE QUEUE</div>
            <div className="serif" style={{ fontSize: 30, letterSpacing: '-0.018em', marginTop: 4 }}>
              Where work enters the substrate
            </div>
            <div style={{ color: 'var(--ink-3)', fontSize: 13, maxWidth: '62ch', marginTop: 6 }}>
              Inbound issues from agents, customers, and integrations sit here until a human or rule routes them. Triage adds context; routing assigns an agent.
            </div>
          </div>
          <button
            className="btn btn-primary"
            onClick={() => setShowCreate(true)}
          >
            <Plus size={13} strokeWidth={1.6} />New issue
          </button>
        </div>

        {error && <div style={{ fontSize: 12, color: 'var(--err)' }}>{error}</div>}

        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--rule)', display: 'flex', alignItems: 'center' }}>
            <div className="eyebrow" style={{ margin: 0 }}>UNASSIGNED · {issues.length}</div>
          </div>
          <table className="tbl">
            <thead>
              <tr>
                <th style={{ width: 110 }}>ID</th>
                <th>Title</th>
                <th style={{ width: 100 }}>Priority</th>
                <th>Triage reason</th>
                <th style={{ width: 110 }}>Created</th>
                <th style={{ width: 220 }}>Assignee</th>
                <th style={{ width: 100 }} />
              </tr>
            </thead>
            <tbody>
              {sorted.map((it) => {
                const c = prioColor(it.priority);
                const suggested = it.suggestedRoles.length > 0
                  ? agents.filter((a) => it.suggestedRoles.includes(a.title))
                  : agents;
                return (
                  <tr key={it.id}>
                    <td className="mono" style={{ fontWeight: 600, color: 'var(--ink-2)' }}>{it.identifier}</td>
                    <td style={{ fontWeight: 500 }}>{it.title}</td>
                    <td>
                      <span className="mono" style={{ fontSize: 10, padding: '2px 7px', border: `1px solid ${c}`, color: c, borderRadius: 2, textTransform: 'uppercase', letterSpacing: '.06em' }}>
                        {it.priority}
                      </span>
                    </td>
                    <td style={{ fontSize: 12, color: 'var(--ink-3)' }}>
                      {it.triageReason || (it.matchedRole ? `matched ${it.matchedRole}` : '—')}
                    </td>
                    <td className="mono tabular" style={{ color: 'var(--ink-3)' }}>{relTime(it.createdAt)}</td>
                    <td>
                      <select
                        className="form-select"
                        style={{ height: 26, fontSize: 12 }}
                        value={pickedAgent[it.id] ?? ''}
                        onChange={(e) => setPickedAgent((s) => ({ ...s, [it.id]: e.target.value }))}
                      >
                        <option value="">— pick agent —</option>
                        {suggested.map((a) => (
                          <option key={a.id} value={a.id}>{a.name} · {a.title}</option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <button
                        className="btn btn-sm btn-primary"
                        disabled={!pickedAgent[it.id] || busy === it.id}
                        onClick={() => assign(it.id)}
                      >
                        {busy === it.id ? '…' : 'Assign'}
                      </button>
                    </td>
                  </tr>
                );
              })}
              {sorted.length === 0 && (
                <tr>
                  <td colSpan={7} style={{ padding: 32, textAlign: 'center', color: 'var(--ink-4)', fontStyle: 'italic' }}>
                    No unassigned issues. Created issues land here when they have no assignee — assign one to move them off the queue.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
      {showCreate && (
        <NewIssueModal
          onClose={() => setShowCreate(false)}
          onCreated={() => {
            setShowCreate(false);
            void load();
          }}
        />
      )}
    </V2Shell>
  );
}

function NewIssueModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const [tenant, setTenant] = useState<Tenant | null>(null);
  const [companies, setCompanies] = useState<ExecutionCompany[]>([]);
  const [projects, setProjects] = useState<ExecutionProject[]>([]);
  const [companyId, setCompanyId] = useState<string>('');
  const [projectId, setProjectId] = useState<string>('');
  const [title, setTitle] = useState<string>('');
  const [priority, setPriority] = useState<'critical' | 'high' | 'medium' | 'low'>('medium');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listTenants()
      .then((ts) => {
        if (cancelled) return;
        const t = ts[0] ?? null;
        setTenant(t);
        if (t) {
          listCompanies(t.id).then((cs) => {
            if (cancelled) return;
            setCompanies(cs);
            if (cs[0]) setCompanyId(cs[0].id);
          });
        }
      })
      .catch((e) => setErr(String(e)));
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!companyId) {
      setProjects([]);
      setProjectId('');
      return;
    }
    let cancelled = false;
    listCompanyProjects(companyId)
      .then((ps) => {
        if (cancelled) return;
        setProjects(ps);
        setProjectId(ps[0]?.id ?? '');
      })
      .catch((e) => setErr(String(e)));
    return () => {
      cancelled = true;
    };
  }, [companyId]);

  async function submit() {
    if (!tenant || !companyId || !projectId || !title.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      await createIssue(companyId, {
        tenantId: tenant.id,
        projectId,
        title: title.trim(),
        priority,
      });
      onCreated();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Create failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.45)',
        display: 'grid',
        placeItems: 'center',
        zIndex: 100,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="card"
        style={{ width: 480, maxWidth: '92vw', padding: 0 }}
      >
        <div
          style={{
            padding: '14px 18px',
            borderBottom: '1px solid var(--rule)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <div className="eyebrow" style={{ margin: 0 }}>NEW ISSUE</div>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <X size={14} strokeWidth={1.6} />
          </button>
        </div>
        <div style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 14 }}>
          {err && (
            <div style={{ fontSize: 12, color: 'var(--err)' }}>{err}</div>
          )}
          {!tenant && (
            <div style={{ fontSize: 12, color: 'var(--ink-3)' }}>Loading tenants…</div>
          )}
          {tenant && (
            <>
              <Field label="Company">
                <select
                  value={companyId}
                  onChange={(e) => setCompanyId(e.target.value)}
                  style={selectStyle}
                >
                  {companies.length === 0 && <option value="">— no companies —</option>}
                  {companies.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </Field>
              <Field label="Project">
                <select
                  value={projectId}
                  onChange={(e) => setProjectId(e.target.value)}
                  style={selectStyle}
                  disabled={!projects.length}
                >
                  {projects.length === 0 && <option value="">— no projects, create one first —</option>}
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
              </Field>
              <Field label="Title">
                <input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Short, action-oriented title"
                  style={inputStyle}
                />
              </Field>
              <Field label="Priority">
                <select
                  value={priority}
                  onChange={(e) => setPriority(e.target.value as typeof priority)}
                  style={selectStyle}
                >
                  <option value="low">low</option>
                  <option value="medium">medium</option>
                  <option value="high">high</option>
                  <option value="critical">critical</option>
                </select>
              </Field>
            </>
          )}
        </div>
        <div
          style={{
            padding: '12px 18px',
            borderTop: '1px solid var(--rule)',
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 8,
          }}
        >
          <button className="btn btn-sm" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            className="btn btn-sm btn-primary"
            onClick={submit}
            disabled={busy || !tenant || !companyId || !projectId || !title.trim()}
          >
            {busy ? 'Creating…' : 'Create issue'}
          </button>
        </div>
      </div>
    </div>
  );
}

const selectStyle: React.CSSProperties = {
  width: '100%',
  fontSize: 12,
  padding: '6px 8px',
  background: 'var(--bg-2)',
  color: 'var(--ink)',
  border: '1px solid var(--rule)',
  borderRadius: 2,
  fontFamily: "'JetBrains Mono', monospace",
};

const inputStyle: React.CSSProperties = {
  ...selectStyle,
  fontFamily: 'inherit',
};

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span className="eyebrow" style={{ margin: 0 }}>{label}</span>
      {children}
    </label>
  );
}
