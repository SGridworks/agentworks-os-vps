'use client';

import type React from 'react';
import { useEffect, useState } from 'react';
import {
  listTenants,
  listCompanies,
  listCompanyProjects,
  listCompanyAgents,
  createIssue,
  type Tenant,
  type ExecutionCompany,
  type ExecutionProject,
  type ExecutionAgent,
} from '@/lib/api';
import { X } from 'lucide-react';

export function NewIssueModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const [tenant, setTenant] = useState<Tenant | null>(null);
  const [companies, setCompanies] = useState<ExecutionCompany[]>([]);
  const [projects, setProjects] = useState<ExecutionProject[]>([]);
  const [agents, setAgents] = useState<ExecutionAgent[]>([]);
  const [companyId, setCompanyId] = useState<string>('');
  const [projectId, setProjectId] = useState<string>('');
  const [title, setTitle] = useState<string>('');
  const [description, setDescription] = useState<string>('');
  const [priority, setPriority] = useState<'critical' | 'high' | 'medium' | 'low'>('medium');
  const [assigneeAgentId, setAssigneeAgentId] = useState<string>('');
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
      setAgents([]);
      setAssigneeAgentId('');
      return;
    }
    let cancelled = false;
    Promise.all([listCompanyProjects(companyId), listCompanyAgents(companyId)])
      .then(([ps, as]) => {
        if (cancelled) return;
        setProjects(ps);
        setAgents(as);
        setProjectId(ps[0]?.id ?? '');
        setAssigneeAgentId('');
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
        description: description.trim() || undefined,
        priority,
        assigneeAgentId: assigneeAgentId || null,
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
            <div style={{ fontSize: 12, color: 'var(--ink-3)' }}>Loading tenants...</div>
          )}
          {tenant && (
            <>
              <Field label="Company">
                <select
                  value={companyId}
                  onChange={(e) => setCompanyId(e.target.value)}
                  style={selectStyle}
                >
                  {companies.length === 0 && <option value="">- no companies -</option>}
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
                  {projects.length === 0 && <option value="">- no projects, create one first -</option>}
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
              <Field label="Description">
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Context, acceptance criteria, or production test notes"
                  style={{ ...inputStyle, minHeight: 88, resize: 'vertical', paddingTop: 8 }}
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
              <Field label="Assignee">
                <select
                  value={assigneeAgentId}
                  onChange={(e) => setAssigneeAgentId(e.target.value)}
                  style={selectStyle}
                >
                  <option value="">unassigned</option>
                  {agents.map((agent) => (
                    <option key={agent.id} value={agent.id}>
                      {agent.name} - {agent.role}
                    </option>
                  ))}
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
            {busy ? 'Creating...' : 'Create issue'}
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
