'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Activity, Download, GitBranch, Play, Plus, RefreshCw, Save, ShieldCheck, Sparkles, Trash2, Workflow } from 'lucide-react';
import { V2Shell } from '@/components/v2/shell';
import { useV2Nav } from '@/components/v2/nav';
import { KPICard, StatusPill } from '@/components/v2/primitives';
import {
  createAutomationTemplate,
  createAutomationWorkflow,
  draftAutomationTemplate,
  exportAutomationWorkflowToN8n,
  getAutomationStatus,
  installAutomationTemplate,
  runAutomationWorkflow,
  setAutomationWorkflowStatus,
  updateAutomationWorkflow,
  type AutomationDefinition,
  type AutomationStep,
  type AutomationStatus,
} from '@/lib/api';

function engineKind(state: AutomationStatus['engine']['state']) {
  return state === 'online' ? 'success' : 'error';
}

const STEP_TYPES: AutomationStep['type'][] = [
  'webhook.intake',
  'policy.check',
  'approval.enqueue',
  'vault.read',
  'vault.write',
  'issue.create',
  'issue.update',
  'dispatch',
  'scanner.finding',
];

function emptyDefinition(): AutomationDefinition {
  return {
    trigger: 'manual',
    steps: [
      {
        id: 'write-note',
        name: 'Write vault note',
        type: 'vault.write',
        params: {
          key: 'automations/visual-editor',
          body: '# Visual Editor Automation\n\nCreated in AWOS.',
          mode: 'append',
        },
      },
    ],
  };
}

function slugify(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'step';
}

function defaultParams(type: AutomationStep['type']): Record<string, unknown> {
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
  if (type === 'dispatch') {
    return { taskKind: 'workflow.dispatch', targetAgentId: '', input: { source: 'visual-editor' } };
  }
  if (type === 'policy.check') {
    return { actionKind: 'workflow.step', actorId: 'native-automation', actorLabel: 'Native Automation' };
  }
  if (type === 'vault.read') return { key: 'automations/visual-editor' };
  if (type === 'scanner.finding') return { severity: 'medium', ruleId: 'native-automation', title: 'Automation scanner finding' };
  if (type === 'webhook.intake') return {};
  return {
    key: 'automations/visual-editor',
    body: '# Visual Editor Automation\n\nCreated in AWOS.',
    mode: 'append',
  };
}

export default function AutomationsV2() {
  const navigate = useV2Nav();
  const editorRef = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState<AutomationStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [workflowName, setWorkflowName] = useState('Operator follow-up workflow');
  const [templateName, setTemplateName] = useState('Operator follow-up template');
  const [selectedSource, setSelectedSource] = useState<string>('');
  const [draftDefinition, setDraftDefinition] = useState<AutomationDefinition>(emptyDefinition);
  const [selectedStepId, setSelectedStepId] = useState<string>('write-note');
  const [paramsText, setParamsText] = useState(JSON.stringify(defaultParams('vault.write'), null, 2));
  const [canvasName, setCanvasName] = useState('Visual workflow');
  const [aiPrompt, setAiPrompt] = useState('When a dispatch fails, create a repair issue and capture evidence in the vault.');
  const [notice, setNotice] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(true);

  async function load() {
    setLoading(true);
    try {
      const next = await getAutomationStatus();
      setStatus(next);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load automations');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  const activeWorkflows = useMemo(
    () => (status?.workflows ?? []).filter((workflow) => workflow.active).length,
    [status],
  );

  const engineState = status?.engine.state ?? 'offline';
  const selectedWorkflow = useMemo(
    () => status?.workflows.find((workflow) => `workflow:${workflow.id}` === selectedSource) ?? null,
    [selectedSource, status],
  );
  const selectedTemplate = useMemo(
    () => status?.templates.find((template) => `template:${template.id}` === selectedSource) ?? null,
    [selectedSource, status],
  );
  const selectedStep = useMemo(
    () => draftDefinition.steps.find((step) => step.id === selectedStepId) ?? draftDefinition.steps[0] ?? null,
    [draftDefinition.steps, selectedStepId],
  );

  useEffect(() => {
    if (!status) return;
    if (!selectedSource && !editorOpen) {
      const firstWorkflow = status.workflows[0];
      const firstTemplate = status.templates[0];
      setSelectedSource(firstWorkflow ? `workflow:${firstWorkflow.id}` : firstTemplate ? `template:${firstTemplate.id}` : '');
    }
  }, [editorOpen, selectedSource, status]);

  useEffect(() => {
    const source = selectedWorkflow ?? selectedTemplate;
    if (!source?.definition) return;
    setDraftDefinition(source.definition);
    setCanvasName(source.name);
    const firstStep = source.definition.steps[0];
    if (firstStep) {
      setSelectedStepId(firstStep.id);
      setParamsText(JSON.stringify(firstStep.params, null, 2));
    }
  }, [selectedWorkflow, selectedTemplate]);

  useEffect(() => {
    if (!selectedStep) return;
    setParamsText(JSON.stringify(selectedStep.params, null, 2));
  }, [selectedStep]);

  async function installTemplate(templateId: string) {
    try {
      await installAutomationTemplate(templateId);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to install template');
    }
  }

  async function runWorkflow(workflowId: string) {
    try {
      await runAutomationWorkflow(workflowId, {
        source: 'admin-ui',
        requestedAt: new Date().toISOString(),
      });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to run workflow');
    }
  }

  async function toggleWorkflow(workflowId: string, active: boolean) {
    try {
      await setAutomationWorkflowStatus(workflowId, active ? 'paused' : 'active');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update workflow');
    }
  }

  function updateSelectedStep(patch: Partial<AutomationStep>) {
    if (!selectedStep) return;
    setDraftDefinition((current) => ({
      ...current,
      steps: current.steps.map((step) => (step.id === selectedStep.id ? { ...step, ...patch } : step)),
    }));
  }

  function addStep(type: AutomationStep['type']) {
    const index = draftDefinition.steps.length + 1;
    const step: AutomationStep = {
      id: slugify(`${type}-${index}`),
      name: type.split('.').map((part) => part[0]?.toUpperCase() + part.slice(1)).join(' '),
      type,
      params: defaultParams(type),
    };
    setDraftDefinition((current) => ({ ...current, steps: [...current.steps, step] }));
    setSelectedStepId(step.id);
    setParamsText(JSON.stringify(step.params, null, 2));
  }

  function removeSelectedStep() {
    if (!selectedStep || draftDefinition.steps.length < 2) return;
    const nextSteps = draftDefinition.steps.filter((step) => step.id !== selectedStep.id);
    setDraftDefinition((current) => ({ ...current, steps: nextSteps }));
    setSelectedStepId(nextSteps[0]?.id ?? '');
  }

  function applyParamsText() {
    try {
      const parsed = JSON.parse(paramsText) as Record<string, unknown>;
      updateSelectedStep({ params: parsed });
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Invalid JSON params');
    }
  }

  async function saveCanvasWorkflow() {
    try {
      if (selectedWorkflow) {
        await updateAutomationWorkflow(selectedWorkflow.id, {
          name: canvasName,
          definition: draftDefinition,
          description: selectedWorkflow.description ?? 'Updated from AWOS visual workflow editor.',
        });
        setNotice('Workflow updated from visual editor.');
      } else {
        await createAutomationWorkflow({
          name: canvasName,
          trigger: draftDefinition.trigger,
          description: 'Created from AWOS visual workflow editor.',
          status: 'paused',
          definition: draftDefinition,
        });
        setNotice('Managed workflow created from visual editor.');
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save workflow');
    }
  }

  async function saveCanvasTemplate() {
    try {
      await createAutomationTemplate({
        name: canvasName,
        trigger: draftDefinition.trigger,
        description: 'Created from AWOS visual workflow editor.',
        definition: draftDefinition,
      });
      setNotice('Reusable workflow template created from visual editor.');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save template');
    }
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

  function buildN8nJsonFromCanvas() {
    const nodes = draftDefinition.steps.map((step, index) => ({
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
      connections[current.name] = {
        main: [[{ node: next.name, type: 'main', index: 0 }]],
      };
    }
    return {
      name: `AWOS Native - ${canvasName}`,
      active: false,
      nodes,
      connections,
      settings: {
        awosNativeDraft: true,
        executionOrder: 'v1',
      },
      tags: ['awos-native', 'agentworks'],
    };
  }

  async function exportSelectedWorkflow() {
    try {
      const exportJson = selectedWorkflow
        ? await exportAutomationWorkflowToN8n(selectedWorkflow.id)
        : buildN8nJsonFromCanvas();
      downloadJson(exportJson, `${slugify(selectedWorkflow?.name ?? canvasName)}.n8n.json`);
      setNotice('n8n-compatible JSON exported locally. No n8n key is required.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to export n8n JSON');
    }
  }

  function openVisualEditor() {
    if (!selectedSource) {
      const firstWorkflow = status?.workflows[0];
      const firstTemplate = status?.templates[0];
      if (firstWorkflow) setSelectedSource(`workflow:${firstWorkflow.id}`);
      else if (firstTemplate) setSelectedSource(`template:${firstTemplate.id}`);
    }
    setEditorOpen(true);
    setNotice('Visual editor is open.');
    window.requestAnimationFrame(() => {
      editorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  function startNewLocalWorkflow() {
    const definition = emptyDefinition();
    const firstStep = definition.steps[0];
    setSelectedSource('');
    setCanvasName('New local workflow');
    setDraftDefinition(definition);
    setSelectedStepId(firstStep?.id ?? '');
    setParamsText(JSON.stringify(firstStep?.params ?? {}, null, 2));
    setEditorOpen(true);
    setNotice('New local workflow opened in the visual editor.');
    window.requestAnimationFrame(() => {
      editorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  async function draftWithAi() {
    try {
      const result = await draftAutomationTemplate({
        prompt: aiPrompt,
      }) as { template?: { id: string; name: string; definition: AutomationDefinition }; model?: string | null; provider?: string | null; fallbackUsed?: boolean };
      if (result.template?.definition) {
        setSelectedSource(`template:${result.template.id}`);
        setCanvasName(result.template.name);
        setDraftDefinition(result.template.definition);
      }
      setNotice(`AI draft created${result.model ? ` with ${result.provider ?? 'provider'}:${result.model}` : ''}${result.fallbackUsed ? ' (fallback used)' : ''}.`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to draft automation');
    }
  }

  const starterDefinition: AutomationDefinition = {
    trigger: 'manual' as const,
    steps: [
      {
        id: 'write-note',
        name: 'Write workflow note',
        type: 'vault.write' as const,
        params: {
          key: 'automations/operator-created',
          body: '# Operator Created Automation\n\nCreated inside AWOS Automations.',
          mode: 'append',
        },
      },
    ],
  };

  async function createManagedWorkflow() {
    try {
      await createAutomationWorkflow({
        name: workflowName,
        trigger: 'manual',
        description: 'Created inside AWOS Automations.',
        status: 'paused',
        definition: starterDefinition,
      });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create workflow');
    }
  }

  async function createManagedTemplate() {
    try {
      await createAutomationTemplate({
        name: templateName,
        trigger: 'manual',
        description: 'Created inside AWOS Automations.',
        definition: starterDefinition,
      });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create template');
    }
  }

  return (
    <V2Shell active="automations" onNav={navigate}>
      <div style={{ padding: '24px 28px', display: 'flex', flexDirection: 'column', gap: 18, overflowY: 'auto' }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 18 }}>
          <div>
            <div className="eyebrow">OPERATE · AUTOMATIONS</div>
            <div className="serif" style={{ fontSize: 30, letterSpacing: '-0.018em', marginTop: 4 }}>
              Local workflow operations
            </div>
            <div style={{ color: 'var(--ink-3)', fontSize: 13, maxWidth: '68ch', marginTop: 6 }}>
              Fully local native workflow builder for this AgentWorks instance. n8n compatibility is import/export only.
            </div>
          </div>
          <button className="btn btn-sm" onClick={load} disabled={loading}>
            <RefreshCw size={12} strokeWidth={1.6} />
            {loading ? 'Refreshing' : 'Refresh'}
          </button>
        </div>

        {error && <div style={{ fontSize: 12, color: 'var(--err)' }}>{error}</div>}
        {notice && <div style={{ fontSize: 12, color: 'var(--accent)' }}>{notice}</div>}
        {(status?.warnings?.length ?? 0) > 0 && (
          <div className="card" style={{ padding: 12, borderColor: 'var(--warn)' }}>
            <div className="eyebrow" style={{ marginBottom: 8, color: 'var(--warn)' }}>RUNTIME WARNINGS</div>
            <div style={{ display: 'grid', gap: 4 }}>
              {status!.warnings!.map((warning) => (
                <div key={warning} className="mono" style={{ fontSize: 11, color: 'var(--warn)' }}>{warning}</div>
              ))}
            </div>
          </div>
        )}

        <div
          className="card"
          style={{
            padding: 16,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 16,
            borderColor: 'var(--accent)',
          }}
        >
          <div>
            <div className="eyebrow" style={{ color: 'var(--accent)', marginBottom: 6 }}>LOCAL AUTOMATION BUILDER</div>
            <div style={{ fontWeight: 700 }}>Create, edit, run, and export workflows inside AWOS Local.</div>
            <div className="mono" style={{ fontSize: 11, color: 'var(--ink-4)', marginTop: 5 }}>
              No n8n key required. Export is a local JSON download for compatibility.
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            <a
              className="btn btn-sm"
              href="/automations/editor"
              style={{ background: 'var(--accent)', color: '#061014', borderColor: 'var(--accent)', fontWeight: 800 }}
            >
              <GitBranch size={13} strokeWidth={1.8} />
              Open Visual Editor
            </a>
            <a className="btn btn-sm" href="/automations/editor?new=1">
              <Plus size={13} strokeWidth={1.7} />
              New Local Workflow
            </a>
            <button className="btn btn-sm" onClick={exportSelectedWorkflow} disabled={loading}>
              <Download size={13} strokeWidth={1.7} />
              Export n8n JSON
            </button>
          </div>
        </div>

        {editorOpen && (
        <div ref={editorRef} className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--rule)', display: 'flex', alignItems: 'center', gap: 10 }}>
            <GitBranch size={15} strokeWidth={1.7} />
            <div>
              <div className="eyebrow" style={{ margin: 0 }}>LOCAL VISUAL WORKFLOW BUILDER</div>
              <div className="mono" style={{ fontSize: 10, color: 'var(--ink-4)', marginTop: 3 }}>
                Native AWOS execution · optional n8n-compatible JSON export
              </div>
            </div>
            <select
              value={selectedSource}
              onChange={(event) => setSelectedSource(event.target.value)}
              className="input"
              style={{ marginLeft: 'auto', width: 320, background: 'var(--bg-2)', border: '1px solid var(--rule)', color: 'var(--ink)', padding: '7px 9px' }}
            >
              <option value="">Draft · New local workflow</option>
              {(status?.workflows ?? []).map((workflow) => (
                <option key={`workflow:${workflow.id}`} value={`workflow:${workflow.id}`}>Workflow · {workflow.name}</option>
              ))}
              {(status?.templates ?? []).map((template) => (
                <option key={`template:${template.id}`} value={`template:${template.id}`}>Template · {template.name}</option>
              ))}
            </select>
            <button className="btn btn-sm" disabled={!selectedWorkflow || loading} onClick={exportSelectedWorkflow}>
              <Download size={12} strokeWidth={1.6} />
              Export n8n JSON
            </button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '210px minmax(420px,1fr) 320px', minHeight: 430 }}>
            <div style={{ borderRight: '1px solid var(--rule)', padding: 14, display: 'grid', gap: 10, alignContent: 'start' }}>
              <div className="eyebrow">NODE PALETTE</div>
              {STEP_TYPES.map((type) => (
                <button
                  key={type}
                  className="btn btn-sm"
                  onClick={() => addStep(type)}
                  style={{ justifyContent: 'flex-start', width: '100%' }}
                >
                  <Plus size={12} strokeWidth={1.6} />
                  <span className="mono" style={{ fontSize: 11 }}>{type}</span>
                </button>
              ))}
              <div style={{ borderTop: '1px solid var(--rule)', paddingTop: 12, display: 'grid', gap: 8 }}>
                <div className="eyebrow">AI DRAFT</div>
                <textarea
                  value={aiPrompt}
                  onChange={(event) => setAiPrompt(event.target.value)}
                  rows={5}
                  style={{ resize: 'vertical', background: 'var(--bg-2)', color: 'var(--ink)', border: '1px solid var(--rule)', padding: 8, fontSize: 12 }}
                />
                <button className="btn btn-sm" disabled={loading || !aiPrompt.trim()} onClick={draftWithAi}>
                  <Sparkles size={12} strokeWidth={1.6} />
                  Draft Template
                </button>
              </div>
            </div>

            <div style={{ padding: 18, position: 'relative', overflowX: 'auto', background: 'rgba(255,255,255,0.015)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
                <input
                  value={canvasName}
                  onChange={(event) => setCanvasName(event.target.value)}
                  className="input"
                  style={{ minWidth: 280, background: 'var(--bg-2)', border: '1px solid var(--rule)', color: 'var(--ink)', padding: '8px 10px', fontWeight: 600 }}
                />
                <select
                  value={draftDefinition.trigger}
                  onChange={(event) => setDraftDefinition((current) => ({ ...current, trigger: event.target.value as AutomationDefinition['trigger'] }))}
                  className="input"
                  style={{ background: 'var(--bg-2)', border: '1px solid var(--rule)', color: 'var(--ink)', padding: '8px 10px' }}
                >
                  <option value="manual">manual</option>
                  <option value="webhook">webhook</option>
                  <option value="event">event</option>
                </select>
                <button className="btn btn-sm" onClick={saveCanvasWorkflow} disabled={loading || !canvasName.trim()}>
                  <Save size={12} strokeWidth={1.6} />
                  Save Workflow
                </button>
                <button className="btn btn-sm" onClick={saveCanvasTemplate} disabled={loading || !canvasName.trim()}>
                  Save Template
                </button>
              </div>
              <div style={{ position: 'relative', minWidth: Math.max(760, draftDefinition.steps.length * 230), height: 300 }}>
                <svg
                  width="100%"
                  height="300"
                  style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}
                >
                  {draftDefinition.steps.slice(0, -1).map((step, index) => {
                    const x1 = 120 + index * 230;
                    const x2 = 120 + (index + 1) * 230;
                    return (
                      <path
                        key={`${step.id}-edge`}
                        d={`M ${x1} 145 C ${x1 + 70} 145, ${x2 - 70} 145, ${x2} 145`}
                        fill="none"
                        stroke="var(--accent)"
                        strokeWidth="1.6"
                        strokeDasharray="5 5"
                      />
                    );
                  })}
                </svg>
                {draftDefinition.steps.map((step, index) => (
                  <button
                    key={step.id}
                    onClick={() => setSelectedStepId(step.id)}
                    style={{
                      position: 'absolute',
                      left: index * 230,
                      top: 82,
                      width: 190,
                      minHeight: 126,
                      textAlign: 'left',
                      background: selectedStepId === step.id ? 'rgba(77, 208, 225, 0.12)' : 'var(--bg-2)',
                      border: `1px solid ${selectedStepId === step.id ? 'var(--accent)' : 'var(--rule)'}`,
                      color: 'var(--ink)',
                      padding: 12,
                      cursor: 'pointer',
                    }}
                  >
                    <div className="eyebrow" style={{ marginBottom: 8 }}>{index === 0 ? 'TRIGGER' : `STEP ${index + 1}`}</div>
                    <div style={{ fontWeight: 700, lineHeight: 1.25 }}>{step.name}</div>
                    <div className="mono" style={{ fontSize: 11, color: 'var(--ink-3)', marginTop: 8 }}>{step.type}</div>
                    <div className="mono" style={{ fontSize: 10, color: 'var(--ink-4)', marginTop: 8 }}>{step.id}</div>
                  </button>
                ))}
              </div>
            </div>

            <div style={{ borderLeft: '1px solid var(--rule)', padding: 14, display: 'grid', gap: 10, alignContent: 'start' }}>
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
                    rows={12}
                    className="mono"
                    style={{ resize: 'vertical', background: 'var(--bg-2)', color: 'var(--ink)', border: '1px solid var(--rule)', padding: 8, fontSize: 11 }}
                  />
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button className="btn btn-sm" onClick={applyParamsText}>Apply JSON</button>
                    <button className="btn btn-sm" onClick={removeSelectedStep} disabled={draftDefinition.steps.length < 2}>
                      <Trash2 size={12} strokeWidth={1.6} />
                      Remove
                    </button>
                  </div>
                </>
              ) : (
                <div className="mono" style={{ fontSize: 12, color: 'var(--ink-4)' }}>Select a node.</div>
              )}
            </div>
          </div>
        </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 12 }}>
          <KPICard
            label="ENGINE"
            value={engineState.toUpperCase()}
            hint={status?.engine.checkedAt ? new Date(status.engine.checkedAt).toLocaleTimeString() : 'pending'}
            accent={engineState === 'online'}
          />
          <KPICard
            label="WORKFLOWS"
            value={status ? String(status.workflows.length) : '—'}
            hint={`${activeWorkflows} active`}
          />
          <KPICard
            label="TEMPLATES"
            value={status ? String(status.templates.length) : '—'}
            hint="ready to install"
          />
          <KPICard
            label="RUNS"
            value={status ? String(status.recentRuns.length) : '—'}
            hint="recent executions"
          />
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(280px, 0.8fr) minmax(0, 1.2fr)', gap: 12 }}>
          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--rule)', display: 'flex', alignItems: 'center', gap: 8 }}>
              <Activity size={14} strokeWidth={1.7} />
              <div className="eyebrow" style={{ margin: 0 }}>ENGINE STATUS</div>
              <div style={{ marginLeft: 'auto' }}>
                <StatusPill kind={engineKind(engineState)}>{engineState}</StatusPill>
              </div>
            </div>
            <div style={{ padding: 16, display: 'grid', gap: 12 }}>
              <div>
                <div className="eyebrow" style={{ marginBottom: 6 }}>MODE</div>
                <div className="mono" style={{ fontSize: 12 }}>{status?.runtime.mode ?? 'docker'}</div>
              </div>
              <div>
                <div className="eyebrow" style={{ marginBottom: 6 }}>N8N COMPATIBILITY</div>
                <div className="mono" style={{ fontSize: 12 }}>
                  local JSON import/export · external sync optional
                </div>
              </div>
              <div>
                <div className="eyebrow" style={{ marginBottom: 6 }}>SCOPE</div>
                <div className="mono" style={{ fontSize: 12 }}>{status?.runtime.localOnly ? 'local only' : 'pending'}</div>
              </div>
              <div>
                <div className="eyebrow" style={{ marginBottom: 6 }}>STATE</div>
                <div className="mono" style={{ fontSize: 11, color: 'var(--ink-3)', wordBreak: 'break-all' }}>
                  {status?.runtime.dataDir ?? '—'}
                </div>
              </div>
              {status?.engine.error && (
                <div style={{ borderTop: '1px solid var(--rule)', paddingTop: 12 }}>
                  <div className="eyebrow" style={{ marginBottom: 6, color: 'var(--err)' }}>LAST ERROR</div>
                  <div className="mono" style={{ fontSize: 11, color: 'var(--err)' }}>{status.engine.error}</div>
                </div>
              )}
            </div>
          </div>

          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--rule)', display: 'flex', alignItems: 'center', gap: 8 }}>
              <Workflow size={14} strokeWidth={1.7} />
              <div className="eyebrow" style={{ margin: 0 }}>WORKFLOW TEMPLATES · {status?.templates.length ?? 0}</div>
            </div>
            <table className="tbl">
              <thead>
                <tr>
                  <th>Name</th>
                  <th style={{ width: 120 }}>Trigger</th>
                  <th style={{ width: 110 }}>Status</th>
                  <th style={{ width: 96 }} />
                </tr>
              </thead>
              <tbody>
                {(status?.templates ?? []).map((template) => (
                  <tr key={template.id}>
                    <td>
                      <div style={{ fontWeight: 600 }}>{template.name}</div>
                      <div style={{ fontSize: 12, color: 'var(--ink-3)', marginTop: 3 }}>{template.description}</div>
                    </td>
                    <td className="mono" style={{ fontSize: 11 }}>{template.trigger}</td>
                    <td><StatusPill kind="info">{template.status}</StatusPill></td>
                    <td>
                      <button
                        className="btn btn-sm"
                        disabled={template.status === 'installed' || loading}
                        onClick={() => installTemplate(template.id)}
                      >
                        Install
                      </button>
                    </td>
                  </tr>
                ))}
                {!status && (
                  <tr>
                    <td colSpan={4} style={{ padding: 32, textAlign: 'center', color: 'var(--ink-4)', fontStyle: 'italic' }}>
                      Loading...
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--rule)', display: 'flex', alignItems: 'center', gap: 8 }}>
            <ShieldCheck size={14} strokeWidth={1.7} />
            <div className="eyebrow" style={{ margin: 0 }}>MANAGED WORKFLOWS · {status?.workflows.length ?? 0}</div>
          </div>
          <table className="tbl">
            <thead>
              <tr>
                <th>Name</th>
                <th style={{ width: 120 }}>State</th>
                <th style={{ width: 180 }}>Updated</th>
                  <th style={{ width: 170 }} />
              </tr>
            </thead>
            <tbody>
              {(status?.workflows ?? []).map((workflow) => (
                <tr key={workflow.id}>
                  <td style={{ fontWeight: 600 }}>{workflow.name}</td>
                  <td><StatusPill kind={workflow.active ? 'success' : 'muted'}>{workflow.active ? 'active' : 'paused'}</StatusPill></td>
                  <td className="mono" style={{ fontSize: 11 }}>{workflow.updatedAt ?? '—'}</td>
                  <td>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button className="btn btn-sm" disabled={loading} onClick={() => toggleWorkflow(workflow.id, workflow.active)}>
                        {workflow.active ? 'Pause' : 'Enable'}
                      </button>
                      <button className="btn btn-sm" disabled={!workflow.active || loading} onClick={() => runWorkflow(workflow.id)}>
                        <Play size={12} strokeWidth={1.6} />Run
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {status && status.workflows.length === 0 && (
                <tr>
                  <td colSpan={4} style={{ padding: 32, textAlign: 'center', color: 'var(--ink-4)', fontStyle: 'italic' }}>
                    No managed workflows yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(280px, 0.8fr)', gap: 12 }}>
          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--rule)', display: 'flex', alignItems: 'center', gap: 8 }}>
              <Activity size={14} strokeWidth={1.7} />
              <div className="eyebrow" style={{ margin: 0 }}>RECENT RUNS · {status?.recentRuns.length ?? 0}</div>
            </div>
            <table className="tbl">
              <thead>
                <tr>
                  <th>Workflow</th>
                  <th style={{ width: 120 }}>Status</th>
                  <th style={{ width: 180 }}>Started</th>
                  <th style={{ width: 90 }}>Steps</th>
                </tr>
              </thead>
              <tbody>
                {(status?.recentRuns ?? []).map((run) => (
                  <tr key={run.id}>
                    <td>
                      <div style={{ fontWeight: 600 }}>{run.workflowName}</div>
                      {run.error && <div className="mono" style={{ fontSize: 10, color: 'var(--err)', marginTop: 3 }}>{run.error}</div>}
                    </td>
                    <td><StatusPill kind={run.status === 'succeeded' ? 'success' : run.status === 'failed' ? 'error' : 'info'}>{run.status}</StatusPill></td>
                    <td className="mono" style={{ fontSize: 11 }}>{run.startedAt}</td>
                    <td className="mono" style={{ fontSize: 11 }}>{run.steps?.length ?? 0}</td>
                  </tr>
                ))}
                {status && status.recentRuns.length === 0 && (
                  <tr>
                    <td colSpan={4} style={{ padding: 24, textAlign: 'center', color: 'var(--ink-4)', fontStyle: 'italic' }}>
                      No native automation runs yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="card" style={{ padding: 16, display: 'grid', gap: 12 }}>
            <div className="eyebrow">AI ASSISTED AUTOMATIONS</div>
            {(status?.suggestions ?? []).map((suggestion) => (
              <div key={suggestion.id} style={{ borderTop: '1px solid var(--rule)', paddingTop: 10 }}>
                <div style={{ fontWeight: 600 }}>{suggestion.title}</div>
                <div style={{ fontSize: 12, color: 'var(--ink-3)', marginTop: 4 }}>{suggestion.description}</div>
                <div style={{ marginTop: 8 }}><StatusPill kind="muted">{suggestion.status}</StatusPill></div>
              </div>
            ))}
          </div>
        </div>

        <div className="card" style={{ padding: 16, display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: 14 }}>
          <div style={{ display: 'grid', gap: 10 }}>
            <div className="eyebrow">CREATE MANAGED WORKFLOW</div>
            <input
              className="input"
              value={workflowName}
              onChange={(event) => setWorkflowName(event.target.value)}
              style={{ background: 'var(--bg-2)', border: '1px solid var(--rule)', color: 'var(--ink)', padding: '8px 10px' }}
            />
            <button className="btn btn-sm" disabled={loading || !workflowName.trim()} onClick={createManagedWorkflow}>
              Create Workflow
            </button>
          </div>
          <div style={{ display: 'grid', gap: 10 }}>
            <div className="eyebrow">CREATE WORKFLOW TEMPLATE</div>
            <input
              className="input"
              value={templateName}
              onChange={(event) => setTemplateName(event.target.value)}
              style={{ background: 'var(--bg-2)', border: '1px solid var(--rule)', color: 'var(--ink)', padding: '8px 10px' }}
            />
            <button className="btn btn-sm" disabled={loading || !templateName.trim()} onClick={createManagedTemplate}>
              Create Template
            </button>
          </div>
        </div>
      </div>
    </V2Shell>
  );
}
