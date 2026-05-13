'use client';

import { useRouter } from 'next/navigation';
import { useCallback } from 'react';

export type NavKey =
  | 'mission-control'
  | 'memory-vault'
  | 'vault-health'
  | 'insights'
  | 'approvals'
  | 'triage-queue'
  | 'agents'
  | 'rule-packs'
  | 'scanner'
  | 'process-health'
  | 'activity'
  | 'evidence'
  | 'autopilot'
  | 'map'
  | 'settings';

export const NAV_TO_PATH: Record<NavKey, string> = {
  'mission-control': '/mission-control',
  'memory-vault':    '/memory-vault',
  'vault-health':    '/vault-health',
  'insights':        '/insights',
  'approvals':       '/approvals',
  'triage-queue':    '/triage-queue',
  'agents':          '/agents',
  'rule-packs':      '/rule-packs',
  'scanner':         '/scanner',
  'process-health':  '/process-health',
  'activity':        '/activity',
  'evidence':        '/evidence',
  'autopilot':       '/autopilot',
  'map':             '/map',
  'settings':        '/settings',
};

export function useV2Nav() {
  const router = useRouter();
  return useCallback((k: NavKey) => router.push(NAV_TO_PATH[k]), [router]);
}
