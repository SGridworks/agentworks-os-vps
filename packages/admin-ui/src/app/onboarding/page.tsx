'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Building2,
  ShieldCheck,
  Rocket,
  ChevronRight,
  ChevronLeft,
  X,
  CheckCircle,
  AlertTriangle,
  Loader2,
  Plug,
} from 'lucide-react';
import {
  initializeOnboarding,
  detectEditors,
  writeEditorConfigs,
  type DetectedEditor,
  type WriteConfigResult,
} from '@/lib/api';

const STEPS = [
  { id: 'welcome', label: 'Welcome', icon: Building2 },
  { id: 'tenant', label: 'Tenant', icon: Building2 },
  { id: 'rules', label: 'Rule Pack', icon: ShieldCheck },
  { id: 'pair', label: 'Pair editor', icon: Plug },
  { id: 'launch', label: 'Launch', icon: Rocket },
];

const STORAGE_KEY = 'aw_onboarding_state';

interface OnboardingState {
  step: number;
  tenantName: string;
  tenantDescription: string;
  selectedPack: string; // 'blank' | 'minimal' | 'standard'
  selectedEditors: string[]; // editor IDs selected for pairing
  completed: boolean;
}

const DEFAULT_STATE: OnboardingState = {
  step: 0,
  tenantName: '',
  tenantDescription: '',
  selectedPack: 'minimal',
  selectedEditors: [],
  completed: false,
};

export default function OnboardingPage() {
  const router = useRouter();
  const [state, setState] = useState<OnboardingState>(DEFAULT_STATE);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load persisted state
  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved) as OnboardingState;
        if (!parsed.completed) {
          setState(parsed);
        }
      }
    } catch {
      // ignore corrupt storage
    }
  }, []);

  // Persist state on every change
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      // ignore quota errors
    }
  }, [state]);

  function updateState(partial: Partial<OnboardingState>) {
    setState((prev) => ({ ...prev, ...partial }));
  }

  function next() {
    if (state.step < STEPS.length - 1) {
      updateState({ step: state.step + 1 });
    }
  }

  function back() {
    if (state.step > 0) {
      updateState({ step: state.step - 1 });
    }
  }

  async function handleLaunch() {
    setLoading(true);
    setError(null);
    try {
      // Step 1: Initialize tenant + assign selected rule pack + seed vault
      const initResult = await initializeOnboarding({
        tenantName: state.tenantName.trim(),
        ...(state.tenantDescription.trim()
          ? { tenantDescription: state.tenantDescription.trim() }
          : {}),
        selectedPack: state.selectedPack as 'minimal' | 'standard' | 'blank',
      });

      // Step 2: Write MCP config to selected editors (after tenant exists)
      if (state.selectedEditors.length > 0) {
        const writeResult = await writeEditorConfigs(
          state.tenantName.trim(), // reviewerId — use tenant name as admin identifier
          state.selectedEditors,
        );
        // Surface write failures as warnings but don't block launch
        const failures = writeResult.results.filter((r: WriteConfigResult) => !r.written);
        if (failures.length > 0) {
          setError(
            `Editor pairing partially failed: ${failures.map((f: WriteConfigResult) => `${f.id} (${f.message})`).join('; ')}. Tenant created — you can retry from Settings.`,
          );
          setLoading(false);
          return;
        }
      }

      updateState({ completed: true });
      // Mark onboarding done
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ ...state, completed: true }),
      );
      // Small delay so user sees the success screen
      await new Promise((r) => setTimeout(r, 1500));
      router.push('/mission-control');
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : 'Failed to initialize tenant. Is the substrate running?'
      );
    } finally {
      setLoading(false);
    }
  }

  function handleCancel() {
    if (
      window.confirm(
        'Cancel onboarding? Your progress is saved and you can return later.'
      )
    ) {
      router.push('/');
    }
  }

  const step = state.step;
  const totalSteps = STEPS.length;

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <div className="w-6 h-6 rounded bg-brand-primary flex items-center justify-center">
              <span className="text-xs font-bold text-brand-primary-foreground">
                AW
              </span>
            </div>
            <span className="text-xs font-medium text-muted-foreground">
              AgentWorks OS
            </span>
          </div>
          <h1 className="text-xl font-semibold text-foreground">
            {STEPS[step].label}
          </h1>
        </div>
        <button
          onClick={handleCancel}
          className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors px-2 py-1.5 rounded hover:bg-accent"
          aria-label="Cancel onboarding"
        >
          <X className="w-3.5 h-3.5" />
          Cancel
        </button>
      </div>

      {/* Progress */}
      <div className="space-y-2">
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>
            Step {step + 1} of {totalSteps}
          </span>
          <span>{STEPS[step].label}</span>
        </div>
        <div className="flex gap-1.5">
          {STEPS.map((s, i) => (
            <div
              key={s.id}
              className={`h-1 flex-1 rounded-full transition-colors ${
                i < step
                  ? 'bg-success'
                  : i === step
                  ? 'bg-brand-primary'
                  : 'bg-border'
              }`}
            />
          ))}
        </div>
      </div>

      {/* Step content */}
      <div className="bg-card rounded-lg border border-border p-6">
        {step === 0 && <WelcomeStep />}
        {step === 1 && (
          <TenantStep
            name={state.tenantName}
            description={state.tenantDescription}
            onUpdate={updateState}
          />
        )}
        {step === 2 && (
          <RulesStep
            selected={state.selectedPack}
            onUpdate={updateState}
          />
        )}
        {step === 3 && (
          <PairStep
            selectedEditors={state.selectedEditors}
            onUpdate={updateState}
          />
        )}
        {step === 4 && (
          <LaunchStep
            state={state}
            error={error}
            loading={loading}
            onLaunch={handleLaunch}
          />
        )}
      </div>

      {/* Navigation */}
      <div className="flex items-center justify-between">
        <button
          onClick={back}
          disabled={step === 0 || loading}
          className="btn btn-secondary btn-sm"
        >
          <ChevronLeft className="w-3.5 h-3.5" />
          Back
        </button>

        {step < STEPS.length - 1 ? (
          <button
            onClick={next}
            className="btn btn-primary btn-sm"
            disabled={
              (step === 1 && !state.tenantName.trim()) ||
              (step === 2 && !state.selectedPack)
            }
          >
            Next
            <ChevronRight className="w-3.5 h-3.5" />
          </button>
        ) : (
          <button
            onClick={handleLaunch}
            disabled={
              loading ||
              !state.tenantName.trim() ||
              !state.selectedPack
            }
            className="btn btn-primary btn-sm"
          >
            {loading ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                Launching...
              </>
            ) : (
              <>
                <Rocket className="w-3.5 h-3.5" />
                Launch
              </>
            )}
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Step components ─────────────────────────────────────────────────────────

function WelcomeStep() {
  return (
    <div className="space-y-5 text-center py-4">
      <div className="flex justify-center">
        <div className="w-14 h-14 rounded-xl bg-brand-primary/10 flex items-center justify-center">
          <ShieldCheck className="w-7 h-7 text-brand-primary" />
        </div>
      </div>
      <div className="space-y-2">
        <h2 className="text-lg font-semibold text-foreground">
          Welcome to AgentWorks OS
        </h2>
        <p className="text-sm text-muted-foreground max-w-sm mx-auto leading-relaxed">
          AgentWorks OS governs every agent action with policy rule packs — giving
          you auditability, enforcement, and compliance evidence out of the box.
        </p>
      </div>
      <div className="space-y-3 text-left bg-muted/40 rounded-lg p-4">
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          What you will set up
        </p>
        <ul className="space-y-2.5">
          {[
            {
              icon: Building2,
              label: 'Tenant',
              desc: 'An isolated namespace for your agents and policies.',
            },
            {
              icon: ShieldCheck,
              label: 'Rule pack',
              desc: 'A starting policy template to govern agent actions.',
            },
            {
              icon: Rocket,
              label: 'First review',
              desc: 'Agents route certain actions to you for approval.',
            },
          ].map(({ icon: Icon, label, desc }) => (
            <li key={label} className="flex items-start gap-3">
              <div className="w-6 h-6 rounded bg-accent flex items-center justify-center shrink-0 mt-0.5">
                <Icon className="w-3.5 h-3.5 text-muted-foreground" />
              </div>
              <div>
                <span className="text-sm font-medium text-foreground">
                  {label}
                </span>
                <span className="text-sm text-muted-foreground"> — {desc}</span>
              </div>
            </li>
          ))}
        </ul>
      </div>
      <p className="text-xs text-muted-foreground">
        Takes about 5 minutes. Your configuration is saved locally.
      </p>
    </div>
  );
}

function TenantStep({
  name,
  description,
  onUpdate,
}: {
  name: string;
  description: string;
  onUpdate: (partial: Partial<OnboardingState>) => void;
}) {
  return (
    <div className="space-y-5">
      <div className="space-y-1">
        <h2 className="text-base font-semibold text-foreground">
          Name your tenant
        </h2>
        <p className="text-sm text-muted-foreground">
          A tenant isolates agents, policies, and audit logs. You can create
          more tenants later.
        </p>
      </div>

      <div className="space-y-4">
        <div className="space-y-1.5">
          <label
            htmlFor="tenant-name"
            className="text-sm font-medium text-foreground"
          >
            Tenant name <span className="text-destructive">*</span>
          </label>
          <input
            id="tenant-name"
            type="text"
            value={name}
            onChange={(e) => onUpdate({ tenantName: e.target.value })}
            placeholder="e.g. Example Tenant"
            className="form-input"
            autoFocus
            maxLength={64}
          />
          <p className="text-xs text-muted-foreground">
            64 characters max. This is shown to agents and in audit logs.
          </p>
        </div>

        <div className="space-y-1.5">
          <label
            htmlFor="tenant-desc"
            className="text-sm font-medium text-foreground"
          >
            Description{' '}
            <span className="text-xs text-muted-foreground font-normal">
              (optional)
            </span>
          </label>
          <input
            id="tenant-desc"
            type="text"
            value={description}
            onChange={(e) =>
              onUpdate({ tenantDescription: e.target.value })
            }
            placeholder="Internal team or product line this tenant represents"
            className="form-input"
            maxLength={128}
          />
        </div>
      </div>

      <div className="flex items-start gap-2.5 rounded-lg bg-muted/40 p-3.5">
        <AlertTriangle className="w-4 h-4 text-muted-foreground shrink-0 mt-0.5" />
        <p className="text-xs text-muted-foreground leading-relaxed">
          Tenant names cannot be changed after creation. Choose something
          stable that reflects your organization or team.
        </p>
      </div>
    </div>
  );
}

function RulesStep({
  selected,
  onUpdate,
}: {
  selected: string;
  onUpdate: (partial: Partial<OnboardingState>) => void;
}) {
  const packs = [
    {
      id: 'minimal',
      label: 'Minimal starter',
      desc: 'Allow all actions. Route outbound communications (email, SMS, calls) to human review.',
      badge: 'Recommended',
    },
    {
      id: 'standard',
      label: 'Standard guardrails',
      desc: 'Pre-configured rules for data handling, external communications, and file operations. Attorney-reviewed.',
      badge: 'Attorney-reviewed',
    },
    {
      id: 'blank',
      label: 'Start from scratch',
      desc: 'No rules. All actions are allowed until you add policy. Requires manual rule authoring.',
      badge: null,
    },
  ];

  return (
    <div className="space-y-5">
      <div className="space-y-1">
        <h2 className="text-base font-semibold text-foreground">
          Choose a rule pack
        </h2>
        <p className="text-sm text-muted-foreground">
          You can change this later. Rules can be toggled to shadow mode to
          observe before enforcing.
        </p>
      </div>

      <div className="space-y-3">
        {packs.map((pack) => (
          <button
            key={pack.id}
            onClick={() => onUpdate({ selectedPack: pack.id })}
            className={`w-full text-left rounded-lg border p-4 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary ${
              selected === pack.id
                ? 'border-brand-primary bg-brand-primary/5'
                : 'border-border hover:border-accent'
            }`}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-foreground">
                    {pack.label}
                  </span>
                  {pack.badge && (
                    <span
                      className={`text-xs px-1.5 py-0.5 rounded font-medium ${
                        pack.id === 'standard'
                          ? 'bg-success/10 text-success'
                          : 'bg-info/10 text-info'
                      }`}
                    >
                      {pack.badge}
                    </span>
                  )}
                </div>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  {pack.desc}
                </p>
              </div>
              <div
                className={`w-4 h-4 rounded-full border-2 shrink-0 mt-0.5 transition-colors ${
                  selected === pack.id
                    ? 'border-brand-primary bg-brand-primary'
                    : 'border-muted-foreground'
                }`}
              >
                {selected === pack.id && (
                  <div className="w-full h-full rounded-full bg-brand-primary-foreground scale-[0.4]" />
                )}
              </div>
            </div>
          </button>
        ))}
      </div>

      <div className="flex items-start gap-2.5 rounded-lg bg-muted/40 p-3.5">
        <AlertTriangle className="w-4 h-4 text-muted-foreground shrink-0 mt-0.5" />
        <p className="text-xs text-muted-foreground leading-relaxed">
          All rule packs start in shadow mode. You can flip to enforcement in
          the Rule Packs section at any time.
        </p>
      </div>
    </div>
  );
}

function LaunchStep({
  state,
  error,
  loading,
  onLaunch,
}: {
  state: OnboardingState;
  error: string | null;
  loading: boolean;
  onLaunch: () => void;
}) {
  return (
    <div className="space-y-5 text-center py-4">
      <div className="flex justify-center">
        <div className="w-14 h-14 rounded-xl bg-success/10 flex items-center justify-center">
          <Rocket className="w-7 h-7 text-success" />
        </div>
      </div>

      <div className="space-y-2">
        <h2 className="text-lg font-semibold text-foreground">
          Ready to launch
        </h2>
        <p className="text-sm text-muted-foreground max-w-sm mx-auto leading-relaxed">
          Your AgentWorks OS tenant will be created with the configuration
          below.
        </p>
      </div>

      <div className="bg-muted/40 rounded-lg p-4 space-y-3 text-left">
        <ReviewRow label="Tenant" value={state.tenantName || '—'} />
        <ReviewRow
          label="Rule pack"
          value={
            state.selectedPack === 'minimal'
              ? 'Minimal starter'
              : state.selectedPack === 'standard'
              ? 'Standard guardrails'
              : 'Start from scratch'
          }
        />
        <ReviewRow label="Initial mode" value="Shadow (observing)" />
      </div>

      {error && (
        <div className="rounded-lg border border-destructive bg-destructive/5 p-4 text-left">
          <div className="flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 text-destructive shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-medium text-destructive">
                Launch failed
              </p>
              <p className="text-xs text-destructive mt-0.5">{error}</p>
            </div>
          </div>
        </div>
      )}

      <div className="flex items-start gap-2.5 rounded-lg bg-muted/40 p-3.5">
        <AlertTriangle className="w-4 h-4 text-muted-foreground shrink-0 mt-0.5" />
        <p className="text-xs text-muted-foreground leading-relaxed">
          AgentWorks OS routes certain actions to human review. Once agents are
          connected, review items will appear in the Approvals section.
        </p>
      </div>
    </div>
  );
}

function PairStep({
  selectedEditors,
  onUpdate,
}: {
  selectedEditors: string[];
  onUpdate: (partial: Partial<OnboardingState>) => void;
}) {
  const [editors, setEditors] = useState<DetectedEditor[]>([]);
  const [loading, setLoading] = useState(true);
  const [detecting, setDetecting] = useState(false);

  useEffect(() => {
    setDetecting(true);
    detectEditors()
      .then((res) => {
        setEditors(res.editors);
        // Pre-select any editors that are present
        const presentIds = res.editors
          .filter((e) => e.present)
          .map((e) => e.id);
        onUpdate({ selectedEditors: presentIds });
      })
      .catch(() => {
        // Non-fatal — editor detection is best-effort
        setEditors([]);
      })
      .finally(() => {
        setLoading(false);
        setDetecting(false);
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function toggleEditor(id: string) {
    const next = selectedEditors.includes(id)
      ? selectedEditors.filter((e) => e !== id)
      : [...selectedEditors, id];
    onUpdate({ selectedEditors: next });
  }

  const presentEditors = editors.filter((e) => e.present);

  return (
    <div className="space-y-5">
      <div className="space-y-1">
        <h2 className="text-base font-semibold text-foreground">
          Pair with your AI editor
        </h2>
        <p className="text-sm text-muted-foreground">
          Connect AgentWorks OS to your existing editor so agents are
          automatically paired at first chat. Detection is local and
          requires no credentials.
        </p>
      </div>

      {detecting || loading ? (
        <div className="flex items-center gap-3 py-6 text-sm text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin" />
          Detecting installed editors...
        </div>
      ) : presentEditors.length === 0 ? (
        <div className="flex items-start gap-3 rounded-lg border border-border bg-muted/40 p-4">
          <AlertTriangle className="w-4 h-4 text-muted-foreground shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-medium text-foreground">No editors detected</p>
            <p className="text-xs text-muted-foreground mt-1">
              No supported editors were found. You can pair manually from
              Settings after setup, or install Claude Code, Claude Desktop,
              or Cursor first.
            </p>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {editors.map((editor) => {
            const isSelected = selectedEditors.includes(editor.id);
            return (
              <button
                key={editor.id}
                onClick={() => editor.present && toggleEditor(editor.id)}
                disabled={!editor.present}
                className={`w-full text-left rounded-lg border p-4 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary ${
                  !editor.present
                    ? 'opacity-50 cursor-not-allowed border-border'
                    : isSelected
                    ? 'border-brand-primary bg-brand-primary/5'
                    : 'border-border hover:border-accent'
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-foreground">
                        {editor.label}
                      </span>
                      {editor.present ? (
                        <span className="text-xs px-1.5 py-0.5 rounded bg-success/10 text-success font-medium">
                          Detected
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground">
                          Not found
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground font-mono">
                      {editor.configPath}
                    </p>
                  </div>
                  <div
                    className={`w-4 h-4 rounded-full border-2 shrink-0 mt-0.5 transition-colors ${
                      !editor.present
                        ? 'border-muted-foreground/30'
                        : isSelected
                        ? 'border-brand-primary bg-brand-primary'
                        : 'border-muted-foreground'
                    }`}
                  >
                    {isSelected && editor.present && (
                      <div className="w-full h-full rounded-full bg-brand-primary-foreground scale-[0.4]" />
                    )}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      )}

      {selectedEditors.length > 0 && (
        <div className="flex items-start gap-2.5 rounded-lg bg-success/5 border border-success/20 p-3.5">
          <CheckCircle className="w-4 h-4 text-success shrink-0 mt-0.5" />
          <p className="text-xs text-foreground leading-relaxed">
            <strong>Pairing {selectedEditors.length} editor{selectedEditors.length > 1 ? 's' : ''}.</strong>{' '}
            On launch, the <code className="text-xs bg-muted px-1 rounded">agentworks</code> MCP
            entry will be written to each editor&apos;s config (existing entries
            are preserved — this is idempotent).
          </p>
        </div>
      )}

      <div className="flex items-start gap-2.5 rounded-lg bg-muted/40 p-3.5">
        <AlertTriangle className="w-4 h-4 text-muted-foreground shrink-0 mt-0.5" />
        <p className="text-xs text-muted-foreground leading-relaxed">
          Editor pairing writes to local config files only. AgentWorks OS
          never sends your editor config to external servers.
        </p>
      </div>
    </div>
  );
}

function ReviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-sm font-medium text-foreground text-right">
        {value}
      </span>
    </div>
  );
}
