'use client';

import { useRouter } from 'next/navigation';
import { useCallback } from 'react';

export type NavKey =
  | 'mission-control'
  | 'memory-vault'
  | 'vault-health'
  | 'insights'
  | 'approvals'
  | 'automations'
  | 'issues'
  | 'review-queue'
  | 'triage-queue'
  | 'agents'
  | 'rule-packs'
  | 'scanner'
  | 'process-health'
  | 'activity'
  | 'evidence'
  | 'autopilot'
  | 'map'
  | 'settings'
  | 'trust'
  | 'active-work';

export const NAV_TO_PATH: Record<NavKey, string> = {
  'mission-control': '/mission-control',
  'memory-vault':    '/memory-vault',
  'vault-health':    '/vault-health',
  'insights':        '/insights',
  'approvals':       '/approvals',
  'automations':     '/automations',
  'issues':          '/issues',
  'review-queue':    '/review-queue',
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
  'trust':           '/trust',
  'active-work':     '/active-work',
};

export function useV2Nav() {
  const router = useRouter();
  return useCallback((k: NavKey | string) => {
    router.push(k in NAV_TO_PATH ? NAV_TO_PATH[k as NavKey] : k);
  }, [router]);
}
