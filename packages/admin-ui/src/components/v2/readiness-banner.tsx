'use client';

/**
 * Readiness banner — surfaces two problems that otherwise rot silently:
 *
 *   1. **Daemon offline.** `/api/health` has been failing for > 30s.
 *   2. **Broken stylesheets.** A `<link rel="stylesheet">` failed to load,
 *      OR the page ended up with zero stylesheet rules (the symptom seen
 *      when two `next dev` instances race on `.next/` chunk writes — see
 *      `reference-next-dev-shared-cache.md`).
 *
 * Mounts once at the top of the (redesigned) layout. The shell already
 * surfaces daemon state in the topbar; this component is a louder backstop
 * for the exact "I'm looking at a broken :3000 and don't know it" failure.
 */

import { useEffect, useState } from 'react';
import { AlertTriangle, X } from 'lucide-react';
import { getHealth } from '@/lib/api';

type Signal =
  | { kind: 'daemon_offline'; sinceMs: number; detail: string }
  | { kind: 'stylesheet_error'; href: string }
  | { kind: 'no_styles' };

export function ReadinessBanner() {
  const [signals, setSignals] = useState<Signal[]>([]);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  // 1. Daemon offline detector — independent from the shell's status indicator
  // so it keeps working on any page (including ones rendered before the shell
  // mounts).
  useEffect(() => {
    let lastOk = Date.now();
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function tick() {
      try {
        await getHealth();
        lastOk = Date.now();
        if (!cancelled) {
          setSignals((prev) => prev.filter((s) => s.kind !== 'daemon_offline'));
        }
      } catch (err) {
        const offlineMs = Date.now() - lastOk;
        if (offlineMs > 30_000 && !cancelled) {
          const detail = err instanceof Error ? err.message : String(err);
          setSignals((prev) => {
            const others = prev.filter((s) => s.kind !== 'daemon_offline');
            return [...others, { kind: 'daemon_offline', sinceMs: offlineMs, detail }];
          });
        }
      } finally {
        if (!cancelled) timer = setTimeout(tick, 5000);
      }
    }
    tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  // 2a. Stylesheet load errors — bubble up from <link> onerror.
  useEffect(() => {
    function onError(e: Event) {
      const tgt = e.target as Element | null;
      if (!tgt || !(tgt instanceof HTMLLinkElement)) return;
      if (tgt.rel !== 'stylesheet') return;
      setSignals((prev) => {
        if (prev.some((s) => s.kind === 'stylesheet_error' && s.href === tgt.href)) return prev;
        return [...prev, { kind: 'stylesheet_error', href: tgt.href }];
      });
    }
    document.addEventListener('error', onError, true);
    return () => document.removeEventListener('error', onError, true);
  }, []);

  // 2b. "Zero rules" detector — if all loaded stylesheets are empty after
  // first paint, the next-dev cache race is the most likely culprit.
  useEffect(() => {
    const t = setTimeout(() => {
      try {
        const sheets = Array.from(document.styleSheets);
        if (sheets.length === 0) {
          setSignals((prev) =>
            prev.some((s) => s.kind === 'no_styles') ? prev : [...prev, { kind: 'no_styles' }],
          );
          return;
        }
        const totalRules = sheets.reduce((sum, sheet) => {
          try {
            return sum + (sheet.cssRules?.length ?? 0);
          } catch {
            // Cross-origin or detached stylesheet — treat as opaque, not empty.
            return sum + 1;
          }
        }, 0);
        if (totalRules === 0) {
          setSignals((prev) =>
            prev.some((s) => s.kind === 'no_styles') ? prev : [...prev, { kind: 'no_styles' }],
          );
        }
      } catch {
        // Defensive — never let the detector itself crash the app.
      }
    }, 1500);
    return () => clearTimeout(t);
  }, []);

  const visible = signals.filter((s) => !dismissed.has(signalKey(s)));
  if (visible.length === 0) return null;

  return (
    <div
      role="alert"
      style={{
        position: 'sticky',
        top: 0,
        zIndex: 90,
        background: 'var(--err, #b00020)',
        color: '#fff',
        borderBottom: '1px solid rgba(0,0,0,0.3)',
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: 12,
      }}
    >
      {visible.map((s) => {
        const key = signalKey(s);
        return (
          <div
            key={key}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '8px 16px',
              borderTop: '1px solid rgba(255,255,255,0.15)',
            }}
          >
            <AlertTriangle size={14} strokeWidth={1.8} />
            <span style={{ flex: 1 }}>{describe(s)}</span>
            <button
              onClick={() => setDismissed((prev) => new Set(prev).add(key))}
              aria-label="Dismiss"
              style={{
                background: 'transparent',
                border: '1px solid rgba(255,255,255,0.4)',
                color: '#fff',
                padding: '2px 6px',
                cursor: 'pointer',
                borderRadius: 2,
                fontSize: 10,
                letterSpacing: '.06em',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
              }}
            >
              <X size={11} strokeWidth={1.8} /> DISMISS
            </button>
          </div>
        );
      })}
    </div>
  );
}

function signalKey(s: Signal): string {
  if (s.kind === 'stylesheet_error') return `stylesheet_error:${s.href}`;
  return s.kind;
}

function describe(s: Signal): string {
  switch (s.kind) {
    case 'daemon_offline':
      return `Daemon /api/health is offline (${Math.round(s.sinceMs / 1000)}s). Check that agentos-d is running on :7710.`;
    case 'stylesheet_error':
      return `Stylesheet failed to load: ${s.href}. Likely a stale next dev cache — restart admin-ui.`;
    case 'no_styles':
      return 'Page has no CSS rules loaded. The admin-ui dev server is probably stale (two next dev instances racing on .next/). Restart it.';
  }
}
