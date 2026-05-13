'use client';

import clsx from 'clsx';
import type { ReactNode } from 'react';

export type StatusKind = 'success' | 'warn' | 'error' | 'info' | 'accent' | 'muted';

export function statusKind(s: string | null | undefined): StatusKind {
  if (s === 'active' || s === 'running' || s === 'done') return 'success';
  if (s === 'paused' || s === 'idle') return 'muted';
  if (s === 'error' || s === 'blocked' || s === 'critical') return 'error';
  if (s === 'in_progress') return 'info';
  if (s === 'inbox' || s === 'triage' || s === 'high' || s === 'warn') return 'warn';
  return 'muted';
}

export function relTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = (Date.now() - new Date(iso).getTime()) / 1000;
  if (d < 60) return Math.max(1, Math.floor(d)) + 's ago';
  if (d < 3600) return Math.floor(d / 60) + 'm ago';
  if (d < 86400) return Math.floor(d / 3600) + 'h ago';
  return Math.floor(d / 86400) + 'd ago';
}

export function fmtMoney(cents: number): string {
  return '$' + (cents / 100).toFixed(0);
}

/* StatusDot — a 6px colored dot, optionally pulsing, with optional uppercase label */
export function StatusDot({
  kind = 'muted',
  pulse = false,
  size = 6,
  label,
}: {
  kind?: StatusKind;
  pulse?: boolean;
  size?: number;
  label?: string;
}) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span
        className={clsx('dot', `dot-${kind === 'accent' ? 'info' : kind}`, pulse && 'dot-pulse')}
        style={{ width: size, height: size }}
      />
      {label && (
        <span
          style={{
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 11,
            letterSpacing: '.04em',
            textTransform: 'uppercase',
            color: 'var(--ink-3)',
          }}
        >
          {label}
        </span>
      )}
    </span>
  );
}

/* StatusPill — uppercase mono pill with semantic color */
export function StatusPill({
  kind = 'muted',
  ghost = false,
  children,
}: {
  kind?: StatusKind;
  ghost?: boolean;
  children: ReactNode;
}) {
  return <span className={clsx('pill', `pill-${kind}`, ghost && 'pill-ghost')}>{children}</span>;
}

/* Sparkline — single-stroke trend line */
export function Sparkline({
  values,
  color = 'var(--accent)',
  w = 80,
  h = 22,
}: {
  values: number[];
  color?: string;
  w?: number;
  h?: number;
}) {
  if (values.length < 2) return <svg width={w} height={h} />;
  const max = Math.max(...values);
  const min = Math.min(...values);
  const range = max - min || 1;
  const pts = values
    .map((v, i) => `${(i / (values.length - 1)) * w},${h - ((v - min) / range) * h}`)
    .join(' ');
  return (
    <svg width={w} height={h} style={{ display: 'block' }}>
      <polyline fill="none" stroke={color} strokeWidth="1.4" points={pts} />
    </svg>
  );
}

/* KPICard — eyebrow label + serif tabular value + optional sparkline */
export function KPICard({
  label,
  value,
  hint,
  accent = false,
  spark,
  trend,
}: {
  label: string;
  value: string | number;
  hint?: string;
  accent?: boolean;
  spark?: number[];
  trend?: 'up' | 'down';
}) {
  return (
    <div
      className="card"
      style={{
        padding: '18px 20px',
        position: 'relative',
        borderTop: accent ? '2px solid var(--accent)' : '1px solid var(--rule)',
      }}
    >
      <div className="eyebrow" style={{ marginBottom: 8 }}>
        {label}
      </div>
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-end',
          justifyContent: 'space-between',
          gap: 12,
        }}
      >
        <div>
          <div
            className="serif tabular"
            style={{ fontSize: 32, lineHeight: 1, letterSpacing: '-0.02em' }}
          >
            {value}
          </div>
          {hint && (
            <div
              style={{
                fontSize: 11,
                fontFamily: "'JetBrains Mono', monospace",
                color: 'var(--ink-3)',
                marginTop: 8,
                letterSpacing: '.04em',
              }}
            >
              {hint}
            </div>
          )}
        </div>
        {spark && (
          <div style={{ paddingBottom: 4 }}>
            <Sparkline values={spark} w={84} h={26} color={trend === 'down' ? 'var(--err)' : 'var(--accent)'} />
          </div>
        )}
      </div>
    </div>
  );
}
