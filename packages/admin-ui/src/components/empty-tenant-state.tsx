'use client';

import { useState } from 'react';
import { Building2, AlertCircle } from 'lucide-react';
import { createTenant, type Tenant } from '@/lib/api';

interface Props {
  onCreated?: (tenant: Tenant) => void;
}

const INDUSTRIES: Array<Tenant['industry']> = [
  'real_estate',
  'healthcare',
  'finance',
  'other',
];

export function EmptyTenantState({ onCreated }: Props) {
  const [name, setName] = useState('');
  const [industry, setIndustry] = useState<NonNullable<Tenant['industry']>>('other');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const t = await createTenant({ name: name.trim(), industry });
      if (onCreated) onCreated(t);
      else if (typeof window !== 'undefined') window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Create failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border p-12 text-center max-w-xl mx-auto">
      <Building2 className="w-10 h-10 text-muted-foreground mb-3" />
      <h3 className="text-sm font-medium text-foreground">No tenant configured</h3>
      <p className="text-xs text-muted-foreground mt-1 max-w-md">
        AgentWorks OS scopes everything (companies, agents, vault, evidence) to a
        tenant. Create one to start using the substrate.
      </p>

      <form onSubmit={submit} className="w-full max-w-sm mt-6 space-y-3 text-left">
        <label className="block">
          <span className="text-xs text-muted-foreground">Tenant name</span>
          <input
            className="form-input mt-1 w-full"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Acme Operations"
            disabled={busy}
            autoFocus
          />
        </label>
        <label className="block">
          <span className="text-xs text-muted-foreground">Industry</span>
          <select
            className="form-select mt-1 w-full"
            value={industry ?? 'other'}
            onChange={(e) =>
              setIndustry(e.target.value as NonNullable<Tenant['industry']>)
            }
            disabled={busy}
          >
            {INDUSTRIES.map((v) => (
              <option key={v ?? 'other'} value={v ?? 'other'}>
                {v}
              </option>
            ))}
          </select>
        </label>
        {error && (
          <div className="flex items-start gap-2 text-xs text-destructive">
            <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}
        <button
          type="submit"
          className="btn btn-primary btn-sm w-full"
          disabled={busy || !name.trim()}
        >
          {busy ? 'Creating…' : 'Create tenant'}
        </button>
      </form>
    </div>
  );
}
