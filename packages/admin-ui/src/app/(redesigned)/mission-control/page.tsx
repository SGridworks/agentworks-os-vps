'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  listTenants,
  listCompanies,
  listCompanyAgents,
  listCompanyIssues,
  wakeAgent,
  type Tenant,
  type ExecutionCompany,
  type ExecutionAgent,
  type ExecutionIssue,
} from '@/lib/api';
import { V2Shell, FilterBar } from '@/components/v2/shell';
import { StatusDot, StatusPill } from '@/components/v2/primitives';
import { useV2Nav } from '@/components/v2/nav';
import { Plus, Zap } from 'lucide-react';

const POLL_MS = 5000;

interface CompanyTile {
  company: ExecutionCompany;
  agents: ExecutionAgent[];
  issues: ExecutionIssue[];
  error?: string;
}

type StatusFilter = 'all' | 'active' | 'blocked' | 'paused';
type HasFilter = 'any' | 'active-agents' | 'blocked-issues' | 'errors';

export default function MissionControlV2() {
  const router = useRouter();
  const navigate = useV2Nav();
  const [tenant, setTenant] = useState<Tenant | null>(null);
  const [tiles, setTiles] = useState<CompanyTile[]>([]);
  const [topError, setTopError] = useState<string | null>(null);
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [has, setHas] = useState<HasFilter>('any');

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function tick() {
      try {
        const tenants = await listTenants();
        const t = tenants[0];
        if (!t) {
          if (!cancelled) {
            setTopError('No tenants registered. Run onboarding to create one.');
            setTenant(null);
            setTiles([]);
          }
          return;
        }
        if (!cancelled) { setTenant(t); setTopError(null); }
        const companies = await listCompanies(t.id);
        const next: CompanyTile[] = await Promise.all(
          companies.map(async (c) => {
            try {
              const [agents, issues] = await Promise.all([
                listCompanyAgents(c.id),
                listCompanyIssues(c.id),
              ]);
              return { company: c, agents, issues };
            } catch (err) {
              return { company: c, agents: [], issues: [], error: String(err) };
            }
          })
        );
        if (!cancelled) setTiles(next);
      } catch (err) {
        if (!cancelled) setTopError(String(err));
      } finally {
        if (!cancelled) timer = setTimeout(tick, POLL_MS);
      }
    }

    tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  const totals = useMemo(() => {
    const agents = tiles.flatMap((t) => t.agents);
    const issues = tiles.flatMap((t) => t.issues);
    return {
      companies: tiles.length,
      activeAgents: agents.filter((a) => a.status === 'active' || a.status === 'running').length,
      totalAgents: agents.length,
      openIssues: issues.filter((i) => i.status !== 'done' && i.status !== 'closed').length,
      blockedIssues: issues.filter((i) => i.status === 'blocked').length,
      inProgressIssues: issues.filter((i) => i.status === 'in_progress').length,
      triageIssues: issues.filter((i) => i.status === 'triage').length,
    };
  }, [tiles]);

  const filtered = tiles.filter((t) => {
    if (filter === 'blocked' && !t.issues.some((i) => i.status === 'blocked')) return false;
    if (filter === 'active'  && !t.agents.some((a) => a.status === 'active' || a.status === 'running')) return false;
    if (filter === 'paused'  && !(t.company.status === 'paused' || t.agents.every((a) => a.status !== 'active' && a.status !== 'running'))) return false;

    if (has === 'active-agents'  && !t.agents.some((a) => a.status === 'active' || a.status === 'running')) return false;
    if (has === 'blocked-issues' && !t.issues.some((i) => i.status === 'blocked')) return false;
    if (has === 'errors'         && !t.agents.some((a) => a.status === 'error')) return false;

    return true;
  });

  return (
    <V2Shell
      active="mission-control"
      onNav={navigate}
      tenant={tenant ? { mark: tenant.name.slice(0, 2).toUpperCase(), name: tenant.name } : { mark: '··', name: 'Loading…' }}
      triageCount={totals.triageIssues}
    >
      <div className="page-scroll">
        <div className="poll-bar" />

        <div className="pageheader">
          <div>
            <div className="eyebrow accent" style={{ marginBottom: 8 }}>
              § MISSION CONTROL{tenant ? ` · TENANT ${tenant.id.slice(0, 6)}` : ''}
            </div>
            <h1 className="pageheader-title">Operating today</h1>
            <p className="pageheader-sub tabular">
              {totals.companies} companies · {totals.totalAgents} agents · {totals.blockedIssues} blocked · polling every 5s
            </p>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              className="btn btn-secondary"
              onClick={() => router.push('/onboarding')}
              title="Register a new company through the onboarding flow"
            >
              <Plus size={14} strokeWidth={1.6} />Register company
            </button>
            <WakeAllIdleButton tiles={tiles} />
          </div>
        </div>

        {topError && (
          <div style={{ margin: '0 28px 16px' }}>
            <StatusPill kind="error">{topError}</StatusPill>
          </div>
        )}

        <div style={{ padding: '0 28px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <FilterBar
            filters={[
              {
                label: 'Status',
                value: filter,
                options: [
                  { value: 'all',     label: 'Any' },
                  { value: 'active',  label: 'Active' },
                  { value: 'blocked', label: 'Blocked' },
                  { value: 'paused',  label: 'Paused' },
                ],
                onChange: (v) => setFilter(v as StatusFilter),
              },
              {
                label: 'Has',
                value: has,
                options: [
                  { value: 'any',            label: 'Anything' },
                  { value: 'active-agents',  label: 'Active agents' },
                  { value: 'blocked-issues', label: 'Blocked issues' },
                  { value: 'errors',         label: 'Errored agents' },
                ],
                onChange: (v) => setHas(v as HasFilter),
              },
            ]}
            onClear={() => { setFilter('all'); setHas('any'); }}
          />
        </div>

        {/* KPI strip — single bordered row of 4 inline cells */}
        <div style={{ padding: '0 28px 18px' }}>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(4,1fr)',
              background: 'var(--bg-card)',
              border: '1px solid var(--rule)',
            }}
          >
            <KPIInline label="Companies"     value={String(totals.companies)} hint={tiles.length > 0 ? 'all polled' : '—'} />
            <KPIInline label="Agents"        value={`${totals.activeAgents} / ${totals.totalAgents}`} hint="active / total" sep />
            <KPIInline label="Open issues"   value={String(totals.openIssues)} hint={`${totals.blockedIssues} blocked · ${totals.inProgressIssues} in progress`} sep />
            <KPIInline label="Decisions/min" value="—" hint="wire when /api/admin/decisions-per-min ships" sep />
          </div>
        </div>

        {/* Company grid */}
        <div style={{ padding: '0 28px 32px', display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(320px,1fr))', gap: 14 }}>
          {filtered.map((t) => (
            <CompanyTile key={t.company.id} tile={t} onOpen={() => router.push(`/mission-control/${t.company.id}`)} />
          ))}
        </div>
      </div>
    </V2Shell>
  );
}

function WakeAllIdleButton({ tiles }: { tiles: CompanyTile[] }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  // "Idle" = active agent that hasn't reported a heartbeat in the last 5 minutes
  // (or has never reported). Paused/retired agents will be 409'd by the daemon
  // anyway (see F2), so we don't include them in the affected list.
  const idleAgents = useMemo(() => {
    const cutoff = Date.now() - 5 * 60_000;
    const all = tiles.flatMap((t) => t.agents);
    return all.filter((a) => {
      if (a.status !== 'active' && a.status !== 'running') return false;
      if (!a.lastHeartbeatAt) return true;
      return new Date(a.lastHeartbeatAt).getTime() < cutoff;
    });
  }, [tiles]);

  async function onClick() {
    if (idleAgents.length === 0) {
      setResult('No idle agents.');
      return;
    }
    const sample = idleAgents.slice(0, 5).map((a) => a.name).join(', ');
    const more = idleAgents.length > 5 ? ` and ${idleAgents.length - 5} more` : '';
    if (!window.confirm(`Wake ${idleAgents.length} idle agent(s): ${sample}${more}?`)) return;
    setBusy(true);
    setResult(null);
    let ok = 0;
    let fail = 0;
    for (const a of idleAgents) {
      try {
        await wakeAgent(a.id, { source: 'mission-control:wake-all-idle' });
        ok++;
      } catch {
        fail++;
      }
    }
    setBusy(false);
    setResult(`Woke ${ok}${fail ? ` · ${fail} failed` : ''}`);
  }

  const disabled = busy || idleAgents.length === 0;
  return (
    <button
      className="btn btn-primary"
      onClick={onClick}
      disabled={disabled}
      title={idleAgents.length === 0 ? 'No idle agents' : `${idleAgents.length} idle`}
      style={{ position: 'relative' }}
    >
      <Zap size={14} strokeWidth={1.6} />
      {busy ? 'Waking…' : `Wake all idle${idleAgents.length ? ` · ${idleAgents.length}` : ''}`}
      {result && (
        <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--ink-3)' }}>{result}</span>
      )}
    </button>
  );
}

function KPIInline({ label, value, hint, sep }: { label: string; value: string; hint?: string; sep?: boolean }) {
  return (
    <div style={{ padding: '14px 18px', borderLeft: sep ? '1px solid var(--rule)' : 'none' }}>
      <div className="eyebrow" style={{ marginBottom: 6 }}>{label}</div>
      <div className="serif tabular" style={{ fontSize: 26, lineHeight: 1.1, letterSpacing: '-0.02em' }}>{value}</div>
      {hint && (
        <div style={{ fontSize: 11, fontFamily: "'JetBrains Mono', monospace", color: 'var(--ink-3)', marginTop: 4, letterSpacing: '.04em' }}>
          {hint}
        </div>
      )}
    </div>
  );
}

function CompanyTile({ tile, onOpen }: { tile: CompanyTile; onOpen: () => void }) {
  const { company, agents, issues } = tile;
  const [hover, setHover] = useState(false);

  const active   = agents.filter((a) => a.status === 'active' || a.status === 'running').length;
  const errored  = agents.filter((a) => a.status === 'error').length;
  const blocked  = issues.filter((i) => i.status === 'blocked').length;
  const inProg   = issues.filter((i) => i.status === 'in_progress').length;
  const open     = issues.filter((i) => i.status !== 'done' && i.status !== 'closed').length;

  const tileStatus: 'success' | 'warn' | 'error' | 'muted' =
    errored ? 'error' : blocked ? 'warn' : active ? 'success' : 'muted';
  const accentBorder =
    errored ? 'var(--err)' : blocked ? 'var(--warn)' : active ? 'var(--ok)' : 'var(--rule-2)';

  // Recent activity stand-in: 3 most recently updated issues for this company
  const recent = [...issues]
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
    .slice(0, 3);

  return (
    <div
      className="card"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={onOpen}
      style={{
        cursor: 'pointer',
        padding: 0,
        transition: 'transform .15s, border-color .15s',
        borderLeft: `2px solid ${accentBorder}`,
        transform: hover ? 'translateY(-1px)' : 'none',
        borderColor: hover ? 'var(--ink-3)' : 'var(--rule)',
      }}
    >
      <div style={{ padding: '14px 16px 10px', borderBottom: '1px solid var(--rule)', display: 'flex', alignItems: 'center', gap: 10 }}>
        <StatusDot kind={tileStatus} pulse={!!active && !errored} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="serif" style={{ fontSize: 16, letterSpacing: '-0.01em', color: 'var(--ink)' }}>{company.name}</div>
          <div className="mono" style={{ fontSize: 10, color: 'var(--ink-3)', letterSpacing: '.08em', marginTop: 2 }}>co/{company.slug}</div>
        </div>
        {company.status === 'paused' && <StatusPill kind="muted">PAUSED</StatusPill>}
      </div>

      <div style={{ padding: '10px 16px 8px' }}>
        <div className="eyebrow" style={{ marginBottom: 6, fontSize: 9 }}>
          AGENTS · {active}/{agents.length}
        </div>
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {agents.map((a) => <AgentChip key={a.id} agent={a} />)}
          {agents.length === 0 && <span className="mono" style={{ fontSize: 10, color: 'var(--ink-4)' }}>—</span>}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', borderTop: '1px solid var(--rule)' }}>
        {[
          { l: 'Open',     v: open,    color: 'var(--ink)' },
          { l: 'In prog.', v: inProg,  color: 'var(--info)' },
          { l: 'Blocked',  v: blocked, color: blocked ? 'var(--err)' : 'var(--ink-3)' },
          { l: 'Errors',   v: errored, color: errored ? 'var(--err)' : 'var(--ink-3)' },
        ].map((s, i) => (
          <div key={i} style={{ padding: '10px 12px', borderLeft: i ? '1px solid var(--rule)' : 'none', textAlign: 'left' }}>
            <div className="mono tabular" style={{ fontSize: 18, fontWeight: 600, color: s.color, letterSpacing: '-0.01em' }}>{s.v}</div>
            <div className="eyebrow" style={{ fontSize: 9, marginTop: 2 }}>{s.l}</div>
          </div>
        ))}
      </div>

      {/* Hover preview — recent issue updates for this company */}
      <div
        style={{
          maxHeight: hover ? 130 : 0,
          overflow: 'hidden',
          transition: 'max-height .25s ease',
          borderTop: hover ? '1px dashed var(--rule)' : 'none',
        }}
      >
        <div style={{ padding: '10px 16px', background: 'var(--bg-2)' }}>
          <div className="eyebrow" style={{ marginBottom: 6, fontSize: 9 }}>RECENT UPDATES</div>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 5 }}>
            {recent.length === 0 && (
              <li className="mono" style={{ fontSize: 11, color: 'var(--ink-4)' }}>No issue activity yet</li>
            )}
            {recent.map((i) => (
              <li key={i.id} className="mono" style={{ fontSize: 11, color: 'var(--ink-2)', display: 'flex', gap: 8 }}>
                <span style={{ color: 'var(--ink-4)', width: 56, flex: '0 0 auto' }}>{i.identifier}</span>
                <span style={{ color: issueStatusColor(i.status), width: 60, flex: '0 0 auto' }}>{i.status}</span>
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{i.title}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

function issueStatusColor(s: string): string {
  if (s === 'done' || s === 'closed') return 'var(--ok)';
  if (s === 'blocked') return 'var(--err)';
  if (s === 'in_progress') return 'var(--info)';
  if (s === 'triage' || s === 'inbox') return 'var(--warn)';
  return 'var(--ink-3)';
}

function AgentChip({ agent }: { agent: ExecutionAgent }) {
  const k =
    agent.status === 'active' || agent.status === 'running' ? 'success'
    : agent.status === 'error' ? 'error'
    : 'muted';
  const colors: Record<string, string> = {
    success: 'var(--ok)',
    error:   'var(--err)',
    muted:   'var(--ink-4)',
    warn:    'var(--warn)',
  };
  return (
    <span
      title={`${agent.name} · ${agent.status}`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        height: 18,
        padding: '0 6px 0 5px',
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: 10,
        letterSpacing: '.02em',
        border: `1px solid ${colors[k]}`,
        color: agent.status === 'error' ? 'var(--err)' : 'var(--ink-2)',
        background: agent.status === 'error' ? 'var(--err-soft)' : 'var(--bg-2)',
        borderRadius: 2,
      }}
    >
      <span
        className="dot"
        style={{
          width: 5,
          height: 5,
          background: colors[k],
          animation: agent.status === 'running' ? 'pulse 1.6s ease-in-out infinite' : 'none',
        }}
      />
      {agent.name.split('-')[0]}
    </span>
  );
}
