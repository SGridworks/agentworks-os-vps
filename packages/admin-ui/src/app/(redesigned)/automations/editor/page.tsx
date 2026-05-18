'use client';

import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Download, Maximize2, Play, Plus, RefreshCw, Save, Sparkles, Trash2, Workflow, ZoomIn, ZoomOut } from 'lucide-react';
import { V2Shell } from '@/components/v2/shell';
import { useV2Nav } from '@/components/v2/nav';
import { StatusPill } from '@/components/v2/primitives';
import {
  createAutomationTemplate,
  createAutomationWorkflow,
  draftAutomationTemplate,
  exportAutomationWorkflowToN8n,
  getAutomationStatus,
  runAutomationWorkflow,
  setAutomationWorkflowStatus,
  updateAutomationWorkflow,
  type AutomationDefinition,
  type AutomationStep,
  type AutomationStatus,
} from '@/lib/api';

const STEP_GROUPS: Array<{ label: string; types: AutomationStep['type'][] }> = [
  {
    label: 'TRIGGERS',
    types: ['webhook.intake', 'schedule.cron', 'schedule.interval', 'issue.created', 'issue.updated', 'approval.decided', 'agent.completed', 'dispatch.failed', 'vault.changed'],
  },
  {
    label: 'AWOS ACTIONS',
    types: ['policy.check', 'approval.enqueue', 'vault.read', 'vault.write', 'issue.create', 'issue.update', 'dispatch', 'scanner.finding', 'webhook.response'],
  },
  {
    label: 'LOGIC',
    types: ['condition.if', 'branch.switch', 'loop.each', 'merge.join', 'delay.wait', 'error.catch'],
  },
  {
    label: 'DATA',
    types: ['data.set', 'data.transform', 'data.filter', 'data.dedupe', 'data.extract', 'json.parse'],
  },
  {
    label: 'INTEGRATIONS',
    types: ['http.request', 'adapter.call', 'email.send', 'message.send', 'rss.read', 'file.read', 'file.write'],
  },
  {
    label: 'AI',
    types: ['ai.classify', 'ai.summarize', 'ai.extract', 'ai.route', 'ai.generate', 'ai.review'],
  },
  {
    label: 'AWOS MAGIC',
    types: ['operator.brief', 'friction.detect', 'evidence.pack', 'agent.panel', 'workflow.self_heal'],
  },
];

const STEP_TYPES = STEP_GROUPS.flatMap((group) => group.types);

const NODES_PER_ROW = 4;
const NODE_WIDTH = 210;
const NODE_HEIGHT = 150;
const NODE_X_GAP = 250;
const NODE_Y_GAP = 220;
const NODE_TOP = 120;

function slugify(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'step';
}

function defaultParams(type: AutomationStep['type']): Record<string, unknown> {
  if (type === 'schedule.cron') return { cron: '0 8 * * 1-5', timezone: 'local' };
  if (type === 'schedule.interval') return { every: 15, unit: 'minutes' };
  if (type.endsWith('.created') || type.endsWith('.updated') || type.endsWith('.decided') || type.endsWith('.completed') || type.endsWith('.failed') || type.endsWith('.changed')) {
    return { filter: {}, source: 'awos-local' };
  }
  if (type === 'webhook.response') return { status: 200, body: { ok: true } };
  if (type === 'issue.create') {
    return {
      projectId: '904ed1c9-76bb-4bfd-96ac-68cda6fb6e89',
      title: 'Automation-created issue',
      description: 'Created from AWOS visual workflow editor.',
      priority: 'medium',
    };
  }
  if (type === 'approval.enqueue') {
    return {
      proposedActionKind: 'workflow.review',
      proposedActionSummary: 'Review native automation action',
      decisionReason: 'Queued from visual workflow editor.',
    };
  }
  if (type === 'dispatch') return { taskKind: 'workflow.dispatch', targetAgentId: '', input: { source: 'visual-editor' } };
  if (type === 'policy.check') return { actionKind: 'workflow.step', actorId: 'native-automation', actorLabel: 'Native Automation' };
  if (type === 'vault.read') return { key: 'automations/visual-editor' };
  if (type === 'scanner.finding') return { severity: 'medium', ruleId: 'native-automation', title: 'Automation scanner finding' };
  if (type === 'webhook.intake') return {};
  if (type === 'condition.if') return { condition: { field: 'status', operator: 'equals', value: 'open' } };
  if (type === 'branch.switch') return { cases: [{ when: 'high', goTo: 'urgent-path' }], defaultBranch: 'standard-path' };
  if (type === 'loop.each') return { itemsPath: '$.items' };
  if (type === 'merge.join') return { strategy: 'append' };
  if (type === 'delay.wait') return { seconds: 60 };
  if (type === 'error.catch') return { createRepairIssue: true };
  if (type === 'data.set') return { values: { status: 'review' } };
  if (type === 'data.transform') return { mapping: { title: '$.title', priority: '$.priority' } };
  if (type === 'data.filter') return { criteria: { field: 'priority', operator: 'in', value: ['high', 'critical'] } };
  if (type === 'data.dedupe') return { key: 'id' };
  if (type === 'data.extract') return { fields: ['title', 'description', 'priority'] };
  if (type === 'json.parse') return { text: '{\"ok\":true}' };
  if (type === 'http.request') return { method: 'GET', url: 'https://api.example.com/resource', headers: {} };
  if (type === 'adapter.call') {
    return {
      adapter: 'configured-adapter',
      operation: 'chat.completions',
      model: '',
      payload: {
        messages: [
          {
            role: 'user',
            content: 'Use the configured adapter to process this workflow context and return concise JSON.',
          },
        ],
        temperature: 0.2,
        responseFormat: 'json_object',
      },
    };
  }
  if (type === 'email.send') return { to: '', subject: 'AWOS automation notice', body: 'Generated by AWOS Local.' };
  if (type === 'message.send') return { channel: 'operations', text: 'AWOS automation notice.' };
  if (type === 'rss.read') return { url: 'https://example.com/feed.xml' };
  if (type === 'file.read') return { path: '/path/to/file.json' };
  if (type === 'file.write') return { path: '/path/to/output.json', body: {} };
  if (type.startsWith('ai.')) return { instruction: `Use the configured model to ${type.split('.')[1]} this workflow context.`, schema: {} };
  if (type === 'operator.brief') return { template: 'Summarize the workflow result for the operator.' };
  if (type === 'friction.detect') return { watch: ['failed_runs', 'stale_dispatch', 'blocked_issues'] };
  if (type === 'evidence.pack') return { include: ['run', 'issue', 'vault', 'agent'] };
  if (type === 'agent.panel') return { roles: ['BackendEngineer', 'QAEngineer'], prompt: 'Review this workflow result.' };
  if (type === 'workflow.self_heal') {
    return {
      monitor: {
        workflowId: '{{workflow.id}}',
        window: '24h',
        signals: ['failed_runs', 'repeated_step_error', 'operator_friction', 'stale_dispatch', 'policy_rejection'],
      },
      diagnosis: {
        useConfiguredModel: true,
        prompt: 'Find the smallest reversible workflow repair that would reduce failures or operator friction.',
        includeRunHistory: true,
        includeStepOutputs: true,
        includeIssueComments: true,
      },
      repair: {
        createRepairIssue: true,
        draftFixWorkflow: true,
        maxChangedSteps: 2,
        allowedActions: ['add_guard', 'change_params', 'insert_approval', 'add_evidence', 'reroute_agent'],
        blockedActions: ['delete_workflow', 'skip_policy', 'send_external_without_approval'],
      },
      approval: {
        required: true,
        approverRole: 'CEO',
        reason: 'Workflow self-heal changes require operator review before activation.',
      },
      evidence: {
        writeVaultKey: 'automations/self-heal/{{workflow.id}}',
        include: ['hypothesis', 'failurePattern', 'proposedPatch', 'testPlan', 'rollbackPlan'],
      },
      successMetric: {
        name: 'failure_rate',
        target: 'decrease',
        compareWindow: 'next_10_runs',
      },
      rollback: {
        keepOriginalDefinition: true,
        revertIfMetricWorsens: true,
      },
    };
  }
  return {
    key: 'automations/visual-editor',
    body: '# Visual Editor Automation\n\nCreated in AWOS.',
    mode: 'append',
  };
}

function emptyDefinition(): AutomationDefinition {
  return {
    trigger: 'manual',
    steps: [
      {
        id: 'write-note',
        name: 'Write vault note',
        type: 'vault.write',
        params: defaultParams('vault.write'),
      },
    ],
  };
}

function buildN8nJson(name: string, definition: AutomationDefinition) {
  const nodes = definition.steps.map((step, index) => ({
    parameters: {
      operation: step.type,
      params: step.params,
    },
    id: step.id,
    name: step.name,
    type: 'CUSTOM.agentworks.automation',
    typeVersion: 1,
    position: [240 + index * 260, 300],
  }));
  const connections: Record<string, unknown> = {};
  for (let index = 0; index < nodes.length - 1; index += 1) {
    const current = nodes[index];
    const next = nodes[index + 1];
    connections[current.name] = { main: [[{ node: next.name, type: 'main', index: 0 }]] };
  }
  return {
    name: `AWOS Native - ${name}`,
    active: false,
    nodes,
    connections,
    settings: { awosNativeDraft: true, executionOrder: 'v1' },
    tags: ['awos-native', 'agentworks'],
  };
}

function downloadJson(payload: Record<string, unknown>, filename: string) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

type WorkflowItem = AutomationStatus['workflows'][number];

export default function AutomationsEditorPage() {
  const navigate = useV2Nav();
  const [startNew, setStartNew] = useState(false);
  const [status, setStatus] = useState<AutomationStatus | null>(null);
  const [selectedSource, setSelectedSource] = useState('');
  const [workflowId, setWorkflowId] = useState<string | null>(null);
  const [canvasName, setCanvasName] = useState(startNew ? 'New local workflow' : 'Visual workflow');
  const [definition, setDefinition] = useState<AutomationDefinition>(emptyDefinition);
  const [selectedStepId, setSelectedStepId] = useState('write-note');
  const [paramsText, setParamsText] = useState(JSON.stringify(defaultParams('vault.write'), null, 2));
  const [aiPrompt, setAiPrompt] = useState('Create a workflow that turns recurring friction into a repair issue and vault evidence note.');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [aiDrafting, setAiDrafting] = useState(false);
  const [aiDraftStatus, setAiDraftStatus] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load(forceStartNew = startNew) {
    setLoading(true);
    try {
      const next = await getAutomationStatus();
      setStatus(next);
      setError(null);
      if (!forceStartNew && !selectedSource) {
        const firstWorkflow = next.workflows[0];
        const firstTemplate = next.templates[0];
        if (firstWorkflow) setSelectedSource(`workflow:${firstWorkflow.id}`);
        else if (firstTemplate) setSelectedSource(`template:${firstTemplate.id}`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load automations');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const nextStartNew = new URLSearchParams(window.location.search).get('new') === '1';
    setStartNew(nextStartNew);
    if (nextStartNew) {
      setSelectedSource('');
      setWorkflowId(null);
      setCanvasName('New local workflow');
      setDefinition(emptyDefinition());
      setSelectedStepId('write-note');
    }
    load(nextStartNew);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectedWorkflow = useMemo(
    () => status?.workflows.find((workflow) => `workflow:${workflow.id}` === selectedSource) ?? null,
    [selectedSource, status],
  );
  const selectedTemplate = useMemo(
    () => status?.templates.find((template) => `template:${template.id}` === selectedSource) ?? null,
    [selectedSource, status],
  );
  const selectedStep = useMemo(
    () => definition.steps.find((step) => step.id === selectedStepId) ?? definition.steps[0] ?? null,
    [definition.steps, selectedStepId],
  );
  const canvasRows = Math.max(1, Math.ceil(definition.steps.length / NODES_PER_ROW));
  const canvasColumns = Math.min(NODES_PER_ROW, Math.max(definition.steps.length, 1));
  const canvasWidth = Math.max(880, canvasColumns * NODE_X_GAP + 40);
  const canvasHeight = Math.max(520, NODE_TOP + canvasRows * NODE_Y_GAP + 120);
  const nodePositions = useMemo(
    () =>
      definition.steps.map((step, index) => ({
        step,
        index,
        x: (index % NODES_PER_ROW) * NODE_X_GAP,
        y: NODE_TOP + Math.floor(index / NODES_PER_ROW) * NODE_Y_GAP,
      })),
    [definition.steps],
  );

  useEffect(() => {
    if (startNew && !selectedSource) return;
    const source = selectedWorkflow ?? selectedTemplate;
    if (!source?.definition) return;
    setWorkflowId(selectedWorkflow?.id ?? null);
    setCanvasName(source.name);
    setDefinition(source.definition);
    const firstStep = source.definition.steps[0];
    if (firstStep) {
      setSelectedStepId(firstStep.id);
      setParamsText(JSON.stringify(firstStep.params, null, 2));
    }
  }, [selectedSource, selectedTemplate, selectedWorkflow, startNew]);

  useEffect(() => {
    if (!selectedStep) return;
    setParamsText(JSON.stringify(selectedStep.params, null, 2));
  }, [selectedStep]);

  function updateSelectedStep(patch: Partial<AutomationStep>) {
    if (!selectedStep) return;
    setDefinition((current) => ({
      ...current,
      steps: current.steps.map((step) => (step.id === selectedStep.id ? { ...step, ...patch } : step)),
    }));
  }

  function addStep(type: AutomationStep['type']) {
    const index = definition.steps.length + 1;
    const step: AutomationStep = {
      id: slugify(`${type}-${index}`),
      name: type.split('.').map((part) => part[0]?.toUpperCase() + part.slice(1)).join(' '),
      type,
      params: defaultParams(type),
    };
    setDefinition((current) => ({ ...current, steps: [...current.steps, step] }));
    setSelectedStepId(step.id);
  }

  function removeSelectedStep() {
    if (!selectedStep || definition.steps.length < 2) return;
    const nextSteps = definition.steps.filter((step) => step.id !== selectedStep.id);
    setDefinition((current) => ({ ...current, steps: nextSteps }));
    setSelectedStepId(nextSteps[0]?.id ?? '');
  }

  function applyParamsText() {
    try {
      updateSelectedStep({ params: JSON.parse(paramsText) as Record<string, unknown> });
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Invalid JSON params');
    }
  }

  async function saveWorkflow() {
    setSaving(true);
    try {
      const body = {
        name: canvasName,
        trigger: definition.trigger,
        description: 'Created from AWOS local visual workflow editor.',
        status: 'paused' as const,
        definition,
      };
      if (workflowId) {
        await updateAutomationWorkflow(workflowId, { name: canvasName, definition, description: body.description });
        setNotice('Local workflow updated.');
      } else {
        const created = await createAutomationWorkflow(body) as WorkflowItem;
        setWorkflowId(created.id);
        setSelectedSource(`workflow:${created.id}`);
        setNotice('Local workflow created.');
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save workflow');
    } finally {
      setSaving(false);
    }
  }

  async function saveTemplate() {
    setSaving(true);
    try {
      await createAutomationTemplate({
        name: canvasName,
        trigger: definition.trigger,
        description: 'Created from AWOS local visual workflow editor.',
        definition,
      });
      setNotice('Reusable workflow template created.');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save template');
    } finally {
      setSaving(false);
    }
  }

  async function runWorkflowNow() {
    if (!workflowId) {
      await saveWorkflow();
      return;
    }
    try {
      await runAutomationWorkflow(workflowId, { source: 'visual-editor', requestedAt: new Date().toISOString() });
      setNotice('Workflow run started.');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to run workflow');
    }
  }

  async function toggleActive() {
    if (!workflowId || !selectedWorkflow) return;
    try {
      await setAutomationWorkflowStatus(workflowId, selectedWorkflow.active ? 'paused' : 'active');
      setNotice(selectedWorkflow.active ? 'Workflow paused.' : 'Workflow enabled.');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update workflow');
    }
  }

  async function exportJson() {
    try {
      const payload = workflowId ? await exportAutomationWorkflowToN8n(workflowId) : buildN8nJson(canvasName, definition);
      downloadJson(payload, `${slugify(canvasName)}.n8n.json`);
      setNotice('n8n-compatible JSON downloaded locally.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to export JSON');
    }
  }

  async function draftWithAi() {
    setAiDrafting(true);
    setAiDraftStatus('Drafting workflow with configured AI model...');
    setNotice('Drafting workflow with AI...');
    setError(null);
    try {
      const result = await draftAutomationTemplate({ prompt: aiPrompt }) as {
        template?: { id: string; name: string; definition: AutomationDefinition };
        provider?: string | null;
        model?: string | null;
        fallbackUsed?: boolean;
      };
      if (result.template?.definition) {
        setSelectedSource(`template:${result.template.id}`);
        setWorkflowId(null);
        setCanvasName(result.template.name);
        setDefinition(result.template.definition);
        setSelectedStepId(result.template.definition.steps[0]?.id ?? '');
        setParamsText(JSON.stringify(result.template.definition.steps[0]?.params ?? {}, null, 2));
      }
      const message = `AI draft loaded${result.model ? ` from ${result.provider ?? 'provider'}:${result.model}` : ''}${result.fallbackUsed ? ' (fallback)' : ''}.`;
      setAiDraftStatus(message);
      setNotice(message);
      await load();
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Failed to draft workflow';
      setAiDraftStatus(message);
      setError(message);
    } finally {
      setAiDrafting(false);
    }
  }

  function fitCanvas() {
    setZoom(Math.max(0.55, Math.min(1, 520 / canvasHeight)));
  }

  return (
    <V2Shell active="automations" onNav={navigate}>
      <div style={{ height: '100%', display: 'grid', gridTemplateRows: 'auto minmax(0,1fr)', background: 'var(--bg)' }}>
        <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--rule)', display: 'flex', alignItems: 'center', gap: 12 }}>
          <a className="btn btn-sm" href="/automations">
            <ArrowLeft size={13} strokeWidth={1.7} />
            Automations
          </a>
          <div>
            <div className="eyebrow">LOCAL VISUAL WORKFLOW EDITOR</div>
            <div className="serif" style={{ fontSize: 24, marginTop: 2 }}>AWOS native workflow canvas</div>
          </div>
          <select
            value={selectedSource}
            onChange={(event) => setSelectedSource(event.target.value)}
            className="input"
            style={{ marginLeft: 'auto', width: 320, background: 'var(--bg-2)', border: '1px solid var(--rule)', color: 'var(--ink)', padding: '8px 10px' }}
          >
            <option value="">Draft · New local workflow</option>
            {(status?.workflows ?? []).map((workflow) => (
              <option key={`workflow:${workflow.id}`} value={`workflow:${workflow.id}`}>Workflow · {workflow.name}</option>
            ))}
            {(status?.templates ?? []).map((template) => (
              <option key={`template:${template.id}`} value={`template:${template.id}`}>Template · {template.name}</option>
            ))}
          </select>
          <button className="btn btn-sm" onClick={() => load()} disabled={loading}>
            <RefreshCw size={13} strokeWidth={1.7} />
            Refresh
          </button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '240px minmax(520px,1fr) 360px', minHeight: 0 }}>
          <aside style={{ borderRight: '1px solid var(--rule)', padding: 16, display: 'grid', gap: 12, alignContent: 'start', overflowY: 'auto' }}>
            <button className="btn btn-sm" onClick={saveWorkflow} disabled={saving || !canvasName.trim()}>
              <Save size={13} strokeWidth={1.7} />
              Save Local Workflow
            </button>
            <button className="btn btn-sm" onClick={saveTemplate} disabled={saving || !canvasName.trim()}>Save Template</button>
            <button className="btn btn-sm" onClick={toggleActive} disabled={!workflowId}>
              <Workflow size={13} strokeWidth={1.7} />
              {selectedWorkflow?.active ? 'Pause Workflow' : 'Enable Workflow'}
            </button>
            <button className="btn btn-sm" onClick={runWorkflowNow}>
              <Play size={13} strokeWidth={1.7} />
              Run Local Workflow
            </button>
            <button className="btn btn-sm" onClick={exportJson}>
              <Download size={13} strokeWidth={1.7} />
              Export n8n JSON
            </button>

            <div style={{ borderTop: '1px solid var(--rule)', paddingTop: 12, display: 'grid', gap: 8 }}>
              <div className="eyebrow">NODE PALETTE</div>
              {STEP_GROUPS.map((group) => (
                <div key={group.label} style={{ display: 'grid', gap: 6 }}>
                  <div className="mono" style={{ fontSize: 10, color: 'var(--ink-4)', marginTop: 4 }}>{group.label}</div>
                  {group.types.map((type) => (
                    <button key={type} className="btn btn-sm" onClick={() => addStep(type)} style={{ justifyContent: 'flex-start' }}>
                      <Plus size={12} strokeWidth={1.6} />
                      <span className="mono" style={{ fontSize: 11 }}>{type}</span>
                    </button>
                  ))}
                </div>
              ))}
            </div>

            <div style={{ borderTop: '1px solid var(--rule)', paddingTop: 12, display: 'grid', gap: 8 }}>
              <div className="eyebrow">AI DRAFT</div>
              <textarea
                value={aiPrompt}
                onChange={(event) => setAiPrompt(event.target.value)}
                rows={5}
                style={{ resize: 'vertical', background: 'var(--bg-2)', color: 'var(--ink)', border: '1px solid var(--rule)', padding: 8, fontSize: 12 }}
              />
              <button className="btn btn-sm" onClick={draftWithAi} disabled={aiDrafting || !aiPrompt.trim()}>
                <Sparkles size={13} strokeWidth={1.7} />
                {aiDrafting ? 'Drafting...' : 'Draft With AI'}
              </button>
              {aiDraftStatus && (
                <div className="mono" style={{ fontSize: 11, color: aiDrafting ? 'var(--accent)' : 'var(--ink-3)', lineHeight: 1.45 }}>
                  {aiDraftStatus}
                </div>
              )}
            </div>
          </aside>

          <main style={{ minWidth: 0, overflow: 'auto', padding: 22, background: 'rgba(255,255,255,0.012)' }}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 18, flexWrap: 'wrap' }}>
              <input
                value={canvasName}
                onChange={(event) => setCanvasName(event.target.value)}
                className="input"
                style={{ minWidth: 340, background: 'var(--bg-2)', border: '1px solid var(--rule)', color: 'var(--ink)', padding: '9px 11px', fontWeight: 700 }}
              />
              <select
                value={definition.trigger}
                onChange={(event) => setDefinition((current) => ({ ...current, trigger: event.target.value as AutomationDefinition['trigger'] }))}
                className="input"
                style={{ background: 'var(--bg-2)', border: '1px solid var(--rule)', color: 'var(--ink)', padding: '9px 11px' }}
              >
                <option value="manual">manual</option>
                <option value="webhook">webhook</option>
                <option value="event">event</option>
              </select>
              <StatusPill kind={workflowId ? selectedWorkflow?.active ? 'success' : 'muted' : 'info'}>
                {workflowId ? selectedWorkflow?.active ? 'active' : 'paused' : 'draft'}
              </StatusPill>
              <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
                <button
                  className="btn btn-sm"
                  onClick={() => setZoom((current) => Math.max(0.55, Number((current - 0.1).toFixed(2))))}
                  aria-label="Zoom out"
                >
                  <ZoomOut size={13} strokeWidth={1.7} />
                </button>
                <div className="mono" style={{ minWidth: 42, textAlign: 'center', fontSize: 11, color: 'var(--ink-3)' }}>
                  {Math.round(zoom * 100)}%
                </div>
                <button
                  className="btn btn-sm"
                  onClick={() => setZoom((current) => Math.min(1.25, Number((current + 0.1).toFixed(2))))}
                  aria-label="Zoom in"
                >
                  <ZoomIn size={13} strokeWidth={1.7} />
                </button>
                <button className="btn btn-sm" onClick={fitCanvas}>
                  <Maximize2 size={13} strokeWidth={1.7} />
                  Fit
                </button>
              </div>
            </div>

            {error && <div style={{ marginBottom: 12, fontSize: 12, color: 'var(--err)' }}>{error}</div>}
            {notice && <div style={{ marginBottom: 12, fontSize: 12, color: 'var(--accent)' }}>{notice}</div>}

            <div data-testid="workflow-canvas" style={{ width: canvasWidth * zoom, height: canvasHeight * zoom, position: 'relative' }}>
              <div
                style={{
                  position: 'relative',
                  width: canvasWidth,
                  height: canvasHeight,
                  transform: `scale(${zoom})`,
                  transformOrigin: 'top left',
                }}
              >
                <svg width={canvasWidth} height={canvasHeight} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
                  {nodePositions.slice(0, -1).map((position, index) => {
                    const next = nodePositions[index + 1];
                    const x1 = position.x + NODE_WIDTH;
                    const y1 = position.y + NODE_HEIGHT / 2;
                    const x2 = next.x;
                    const y2 = next.y + NODE_HEIGHT / 2;
                    const sameRow = Math.floor(position.index / NODES_PER_ROW) === Math.floor(next.index / NODES_PER_ROW);
                    const d = sameRow
                      ? `M ${x1} ${y1} C ${x1 + 80} ${y1}, ${x2 - 80} ${y2}, ${x2} ${y2}`
                      : `M ${x1} ${y1} C ${x1 + 70} ${y1}, ${canvasWidth - 70} ${y1}, ${canvasWidth - 70} ${y1 + 80} L ${canvasWidth - 70} ${y2 - 80} C ${canvasWidth - 70} ${y2}, ${x2 - 80} ${y2}, ${x2} ${y2}`;
                    return (
                      <path
                        key={`${position.step.id}-edge`}
                        d={d}
                        fill="none"
                        stroke="var(--accent)"
                        strokeWidth="1.8"
                        strokeDasharray="6 6"
                      />
                    );
                  })}
                </svg>
                {nodePositions.map(({ step, index, x, y }) => (
                  <button
                    data-testid="workflow-canvas-node"
                    key={step.id}
                    onClick={() => setSelectedStepId(step.id)}
                    style={{
                      position: 'absolute',
                      left: x,
                      top: y,
                      width: NODE_WIDTH,
                      minHeight: NODE_HEIGHT,
                      textAlign: 'left',
                      background: selectedStepId === step.id ? 'rgba(77, 208, 225, 0.14)' : 'var(--bg-2)',
                      border: `1px solid ${selectedStepId === step.id ? 'var(--accent)' : 'var(--rule)'}`,
                      color: 'var(--ink)',
                      padding: 14,
                      cursor: 'pointer',
                      boxShadow: selectedStepId === step.id ? '0 0 0 1px rgba(77,208,225,0.25)' : 'none',
                    }}
                  >
                    <div className="eyebrow" style={{ marginBottom: 10 }}>{index === 0 ? 'TRIGGER' : `STEP ${index + 1}`}</div>
                    <div style={{ fontWeight: 800, lineHeight: 1.25 }}>{step.name}</div>
                    <div className="mono" style={{ fontSize: 11, color: 'var(--ink-3)', marginTop: 10 }}>{step.type}</div>
                    <div className="mono" style={{ fontSize: 10, color: 'var(--ink-4)', marginTop: 10 }}>{step.id}</div>
                  </button>
                ))}
              </div>
            </div>
          </main>

          <aside style={{ borderLeft: '1px solid var(--rule)', padding: 16, display: 'grid', gap: 10, alignContent: 'start', overflowY: 'auto' }}>
            <div className="eyebrow">NODE INSPECTOR</div>
            {selectedStep ? (
              <>
                <input
                  value={selectedStep.name}
                  onChange={(event) => updateSelectedStep({ name: event.target.value })}
                  className="input"
                  style={{ background: 'var(--bg-2)', border: '1px solid var(--rule)', color: 'var(--ink)', padding: '8px 10px' }}
                />
                <select
                  value={selectedStep.type}
                  onChange={(event) => {
                    const type = event.target.value as AutomationStep['type'];
                    updateSelectedStep({ type, params: defaultParams(type) });
                    setParamsText(JSON.stringify(defaultParams(type), null, 2));
                  }}
                  className="input"
                  style={{ background: 'var(--bg-2)', border: '1px solid var(--rule)', color: 'var(--ink)', padding: '8px 10px' }}
                >
                  {STEP_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
                </select>
                <input
                  value={selectedStep.id}
                  onChange={(event) => {
                    const nextId = slugify(event.target.value);
                    updateSelectedStep({ id: nextId });
                    setSelectedStepId(nextId);
                  }}
                  className="input mono"
                  style={{ background: 'var(--bg-2)', border: '1px solid var(--rule)', color: 'var(--ink)', padding: '8px 10px', fontSize: 11 }}
                />
                <textarea
                  value={paramsText}
                  onChange={(event) => setParamsText(event.target.value)}
                  rows={16}
                  className="mono"
                  style={{ resize: 'vertical', background: 'var(--bg-2)', color: 'var(--ink)', border: '1px solid var(--rule)', padding: 8, fontSize: 11 }}
                />
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="btn btn-sm" onClick={applyParamsText}>Apply JSON</button>
                  <button className="btn btn-sm" onClick={removeSelectedStep} disabled={definition.steps.length < 2}>
                    <Trash2 size={12} strokeWidth={1.6} />
                    Remove
                  </button>
                </div>
              </>
            ) : (
              <div className="mono" style={{ fontSize: 12, color: 'var(--ink-4)' }}>Select a node.</div>
            )}
          </aside>
        </div>
      </div>
    </V2Shell>
  );
}
