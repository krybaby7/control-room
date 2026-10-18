import type { Capture, Project, Task, Workspace } from './types.ts';
import { parseWorkspaceExport, WORKSPACE_LIMITS } from './workspace-validation.ts';

export const BASELINE_ID = '2026-10-17' as const;
export type BaselineId = typeof BASELINE_ID;
export type EvidenceBasis = 'observed' | 'documented' | 'owner-decision';
export interface BaselineSource {
  id: string; label: string; basis: EvidenceBasis; date: string; revision?: string;
  repository: string; path: string; url?: string; summary: string;
}
export interface BaselineAction {
  key: string; title: string; existingWork: string; acceptance: string;
  milestoneTitle: string | null; horizon: 'now' | 'next'; sourceIds: string[];
}
export interface ProjectBaselineData {
  id: BaselineId; key: 'tamenni' | 'trade-graph'; repositories: string[];
  checkedAt: string; status: string; accomplishments: string[]; blockers: string[];
  provenance: string; sources: BaselineSource[]; actions: BaselineAction[];
}
export interface BaselineProposal extends BaselineAction { id: string; milestoneId: string | null; milestoneNote: string; exists: boolean; }
export interface BaselineApplicationState {
  status: 'available' | 'applied' | 'incomplete' | 'conflict' | 'unsupported';
  markerId: string | null; existingCount: number; missingCount: number; message: string;
}

const MAP_SHA = 'd980806e7e93ff1bc93a64c998c3a6d4dc190685';
const TRADE_SHA = '9fa7efb0c514cd424dba62062bd6b3dfffb073d2';
const TEST_SHA = '0595d98762f06e12533ecb85e3ee4100fee457f3';
const mapLink = (path: string) => `https://github.com/krybaby7/tameni-map-lab/blob/${MAP_SHA}/${path}`;
const tradeLink = (path: string) => `https://github.com/krybaby7/trade-graph/blob/${TRADE_SHA}/${path}`;

/** Reviewed, bundled evidence. Commands select this package; clients cannot supply tasks or claims. */
export const PROJECT_BASELINES: readonly ProjectBaselineData[] = [
  {
    id: BASELINE_ID, key: 'tamenni', repositories: ['krybaby7/tmni', 'krybaby7/tameni-map-lab'],
    checkedAt: '2026-10-17T16:20:30Z',
    status: 'Unlaunched app with substantial foreground reliability work. Current Android acceptance, map promotion, scaling and unit economics remain open.',
    provenance: 'App: local main 0c5972f (22 Aug), 419 changed/untracked entries; remote main is the same old commit. Current local candidate is not identified by that SHA. Map lab: local 62ded29 (27 Sep) is stale; remote main d980806 (16 Oct) is the baseline.',
    accomplishments: [
      'Documented 24 Sep software candidate: 1,473 logic + 442 component tests, 45/45 EN/AR checks and 24 JVM tests passed; debug APK packaging verified. Its on-device result is unverified.',
      'Observed map registry: 13 verified, 95 planned and 2 needs-fix areas, out of 110. The 13-area lab-data-v5 release exists; this is lab coverage.',
      'Recorded owner decision: six landmark refinements accepted on 11 Oct and integrated in the lab. All remain not exported.',
    ],
    blockers: [
      'Retest first-share capture, Stop cleanup, relaunch and battery on the current APK. Earlier hardware failures were followed by software fixes, not a recorded physical retest.',
      'Background capability gates and the 14-scenario physical acceptance matrix remain open. Push, store checkout/signing and iOS scope are unresolved.',
      'Alexandria matched-height evidence is missing; Borg and the rest of Wave 2 remain held. LAB-06 app drift/promotion is still draft.',
      'No measured scale or current household unit-margin evidence. Archived cost forecasts and planner limits do not establish readiness.',
    ],
    sources: [
      { id: 'app', label: 'Current app scope', basis: 'observed', date: '2026-10-17', repository: 'TAMENNI app', path: 'docs/PRODUCT_MAP.md',
        summary: 'Local document: V2 PWA/Capacitor Android and Firebase. Unlaunched; no iOS project or store checkout; guardian push and signed store pipeline unproven. Local source is newer than published main.' },
      { id: 'software', label: 'Accepted software candidate', basis: 'documented', date: '2026-09-24', repository: 'TAMENNI app', path: 'outputs/performance-remediation/P14/2026-09-24-verification-05-03/REPORT.md',
        summary: 'Named P14 V05-03 candidate: 1473 logic, 442 component, 45/45 locale and 24 JVM passes; debug APK 96aef8c… verified. Hardware unverified. Warm-nav pitch race and intermittent MapLibre framebuffer errors retained. Current tree has 419 entries versus report’s 415; no tests rerun here.' },
      { id: 'hardware', label: 'Earlier Android hardware result', basis: 'documented', date: '2026-09-23', repository: 'TAMENNI app', path: 'outputs/performance-remediation/P14/2026-09-23-hardware-02/REPORT.md',
        summary: 'Earlier APK: bounded PMTiles and live-view backoff passed, own-sharing failed (D-04 false Sharing/no capture, D-05 leaked watch after Stop). Later software corrections are documented; this is not a failure verdict on the later candidate. Calibrated battery unverified.' },
      { id: 'background', label: 'Background capability gates', basis: 'observed', date: '2026-10-17', repository: 'TAMENNI app', path: 'docs/qa/android-location-acceptance.md',
        summary: 'Local nativeBackgroundLocation.js checks seven gates. Physical acceptance document says not measured; all 14 rows pending. Adapter and unit tests do not prove a running background engine.' },
      { id: 'coverage', label: 'Area registry and published lab archive', basis: 'observed', date: '2026-10-17', revision: MAP_SHA, repository: 'tameni-map-lab', path: 'apps/map-lab/areas/areas.json', url: mapLink('apps/map-lab/areas/areas.json'),
        summary: 'Registry independently counted: 110 areas = 13 verified + 95 planned + 2 needs-fix. GitHub lab-data-v5 release (6 Oct) has a 29,890,049-byte PMTiles archive plus manifest. Earlier acceptance includes documented exceptions; app/national acceptance is not established.' },
      { id: 'map-status', label: 'Alexandria pathfinder status', basis: 'documented', date: '2026-10-16', revision: MAP_SHA, repository: 'tameni-map-lab', path: 'docs/map-program/STATUS.md', url: mapLink('docs/map-program/STATUS.md'),
        summary: 'DATA-07H reports 1277 passing tests at e8cb5e9 and accepted source-validity diagnostics, not area acceptance. DATA-07M attempt 1 received no bundle; single-file retry 2 ready, not dispatched. Missing matched samples, unsupported 98.5 m anomaly and 61 coastal centres outside raw footprints block Alexandria. Borg/other Wave-2 areas held; saved-cloud samples unavailable here.' },
      { id: 'landmarks', label: 'Landmark acceptance and promotion', basis: 'owner-decision', date: '2026-10-11', revision: MAP_SHA, repository: 'tameni-map-lab', path: 'docs/map-program/STATUS.md', url: mapLink('docs/map-program/STATUS.md'),
        summary: '16 Oct status records owner’s 11 Oct acceptance of six refinements (PRs 95/96); all not exported. LAB-06 snapshot/drift is draft. Hosting, clearance and app promotion remain separate decisions. PRs 103/104/124 open when checked; opening/merging code is not product acceptance.' },
      { id: 'scale', label: 'Scale and cost limitations', basis: 'observed', date: '2026-10-17', repository: 'TAMENNI app', path: 'docs/LOCATION_STRESS_TESTING.md',
        summary: 'Local guide says limits are planner defaults, not Firebase quotas/invoices; device/carrier and 2× expected peak validation needed. cost analysis/FINDINGS.md is archived: approved 3 Aug, pricebooks 29 Jul, missing calibration. 99/149 EGP tiers do not demonstrate margins.' },
    ],
    actions: [
      { key: 'android', title: 'Revalidate the accepted Android candidate on hardware', existingWork: 'P14 / HW-03; D-04–D-05 and PD-1–PD-2', milestoneTitle: 'Android reliability accepted', horizon: 'now', sourceIds: ['software', 'hardware', 'background'],
        acceptance: 'Record source/build identity; retest first-share capture, pause/resume, Stop watcher teardown, consent, offline/relaunch and map gestures/soak on representative devices. Record matched battery results and unknowns. Keep background gates closed until separately satisfied.' },
      { key: 'height', title: 'Complete DATA-07M and decide Alexandria coverage', existingWork: 'DATA-07M retry 2 → DATA-07 → DATA-03c', milestoneTitle: 'Map launch coverage accepted', horizon: 'now', sourceIds: ['map-status', 'coverage'],
        acceptance: 'Recover exact saved sample identities using the verified single-file handoff; reproduce matched heights within existing authority. Resolve anomaly/coastal-footprint evidence, then record city QA/A1 acceptance. Keep Borg and remaining Wave 2 held until their acceptance.' },
      { key: 'promotion', title: 'Write the LAB-06 drift and app-promotion manifest', existingWork: 'LAB-06 draft; D-004 promotion decision', milestoneTitle: 'Map lab integrated into the app', horizon: 'next', sourceIds: ['coverage', 'landmarks'],
        acceptance: 'Compare pinned app candidate, lab commit and 13-area archive. List proposed code/data/models, attribution, footprint/performance impact and rollback. Distinguish lab acceptance, human visual approval, export/clearance and actual app verification; record owner promotion decisions.' },
      { key: 'scale', title: 'Calibrate Firebase load and household unit economics', existingWork: 'Location stress lab / O02–O04 / rollout calibration', milestoneTitle: 'Scaling readiness demonstrated', horizon: 'next', sourceIds: ['scale', 'background'],
        acceptance: 'Measure household viewer/read/write/egress workloads and region topology. Prepare a bounded authorized staging ramp to 2× expected peak. Calculate current Firebase/map-delivery/store/operating costs and Free/Family/Plus margin sensitivities; identify measured limits and unpriced rows. This task supplies scaling and economics evidence without changing either milestone.' },
      { key: 'release', title: 'Close the launch capability ledger against evidence', existingWork: 'PRODUCT_MAP launch gaps / P14', milestoneTitle: null, horizon: 'next', sourceIds: ['app', 'background'],
        acceptance: 'Assign owners and acceptance evidence to guardian push, store billing/release signing and the iOS scope decision. Preserve unsupported capability labels. Keep this broader release-scope task unlinked until the owner chooses an appropriate milestone.' },
    ],
  },
  {
    id: BASELINE_ID, key: 'trade-graph', repositories: ['krybaby7/trade-graph'],
    checkedAt: '2026-10-17T16:20:30Z',
    status: 'The new day-trader engine has current source and CI evidence. Its dated report says not installed; current runtime is unverified. Coherent operation and profitability after costs are unproven.',
    provenance: 'Active integration: claude/day-trader-engine-20261012 at 9fa7efb (17 Oct 15:28 UTC). Tested candidate: 0595d98. Remote main 7770d17 is September planning; open PR #1 and local caae082 are older implementation checkpoints. Current runtime was not inspected.',
    accomplishments: [
      'Observed GitHub test job succeeded on 0595d98 on 17 Oct. Its dated report records 7,600 passed / 18 skipped and 464/464 offline acceptance; raw counts were not rerun here.',
      'Documented source includes cautious fills/exits, practice range, scanner, money limits, day plans, event wakes, scorecard, HQ views and collector. New wave tests use synthetic providers and markets.',
      'Current planning records 46 tasks: 37 done, 4 in progress, 2 blocked, 3 todo. Implementation completion does not close runtime or economic acceptance.',
    ],
    blockers: [
      'The 17 Oct report says waves 1–6 are not installed; current host state was not inspected. W7/T45 is documented as running, not verified complete. L3 image, collector and Trader wake acceptance remains open.',
      'Installed Perplexity Research/Leader wiring is missing. Quote-feed requests sit outside the shared limiter; HQ fixed timers and protected-path questions need follow-up.',
      'Dated 66-hour run: 17 no_action decisions and zero orders. A 30-day replay lost after fees on BTC and ETH. No demonstrated profitability.',
      'Actual all-in subscription/shared costs and current process/books were not inspected. T18/T43 future evaluation and separate venue/live-authority gates remain open.',
    ],
    sources: [
      { id: 'ci', label: 'Exact candidate CI status', basis: 'observed', date: '2026-10-17', revision: TEST_SHA, repository: 'trade-graph', path: 'GitHub Actions run 39039860661', url: 'https://github.com/krybaby7/trade-graph/actions/runs/39039860661',
        summary: 'API independently returned success for candidate 0595d98762f06e12533ecb85e3ee4100fee457f3; test job completed 15:27:14 UTC. Counts (7600 pass, 18 skip, 464 mapped offline tests and 40 cases) are documented in the status report, not independently counted from logs.' },
      { id: 'source', label: 'Active integration and implementation scope', basis: 'documented', date: '2026-10-17', revision: TRADE_SHA, repository: 'trade-graph', path: 'IMPLEMENTATION-STATUS.md', url: tradeLink('IMPLEMENTATION-STATUS.md'),
        summary: 'Waves 1–6 merged, nothing installed/deployed; new provider/market behavior synthetic and switches off. Planning JSON observed 46 tasks: 37 done, 4 in progress, 2 blocked, 3 todo. Older main/PR/local source is not the active baseline. Current HEAD follows tested 0595d98 with report/status updates; CI result is scoped to that candidate.' },
      { id: 'economics', label: 'Earlier operating and replay results', basis: 'documented', date: '2026-10-12', revision: TRADE_SHA, repository: 'trade-graph', path: 'docs/DAY-TRADER-ENGINE.md', url: tradeLink('docs/DAY-TRADER-ENGINE.md'),
        summary: 'Dated design record: Oct 7–10 run (~66 hours), 17 no_action decisions, zero orders; missing candle/close inputs, stale EUR blocking USD buys, persistent failure pause and expired research inputs. Thirty-day hourly replay lost after fees on BTC/ETH. These historical results motivate redesign, not a current process or future-return claim.' },
      { id: 'gaps', label: 'Installed-service acceptance gaps', basis: 'documented', date: '2026-10-17', revision: TRADE_SHA, repository: 'trade-graph', path: 'IMPLEMENTATION-STATUS.md', url: tradeLink('IMPLEMENTATION-STATUS.md'),
        summary: 'Perplexity Research/Leader protected-service wiring unbuilt. Real image/collector/TraderWakeReply/owner pins need L3 checks. Quote feed outside shared limiter; old HQ fixed timers stale with engine; collector protected-path decision open. Passing scripted tests is not provider/exchange success.' },
      { id: 'next', label: 'Existing work, approval and economic gates', basis: 'documented', date: '2026-10-17', revision: TRADE_SHA, repository: 'trade-graph', path: 'planning/handoffs/NIGHT-2026-10-16.md', url: tradeLink('planning/handoffs/NIGHT-2026-10-16.md'),
        summary: 'Night report says W7/T45 running, not verified complete. L3 checklist explicitly unrun, requires owner approval. T43 scored paper test todo. Scorecard compares after-fee cash/BTC; unknown AI/shared costs stay unknown. No demonstrated profitability or inferred live/spend permission.' },
      { id: 'install', label: 'L3 owner installation checklist', basis: 'documented', date: '2026-10-17', revision: TRADE_SHA, repository: 'trade-graph', path: 'docs/L3-INSTALL-CHECKLIST.md', url: tradeLink('docs/L3-INSTALL-CHECKLIST.md'),
        summary: 'Preparation record only: preserve books/receipts, protected image and financial transition, owner limits, candle store/collector and real subscription wake checks. No checklist step was run. Every installation action requires owner approval; baseline proposals authorize none.' },
      { id: 'scorecard', label: 'Scored paper evaluation contract', basis: 'documented', date: '2026-10-17', revision: TRADE_SHA, repository: 'trade-graph', path: 'docs/SCORECARD.md', url: tradeLink('docs/SCORECARD.md'),
        summary: 'T42 supplies T43 reporting after fees versus cash and BTC, with drawdown and separate actual/estimated/unknown AI costs. Paper money never pays the AI. A good score alone neither proves durable profitability nor grants real trading permission.' },
    ],
    actions: [
      { key: 'checkpoint', title: 'Reconcile W7/T45 and the active integration checkpoint', existingWork: 'W7/T45; day-trader integration', milestoneTitle: 'Coherent end-to-end operation', horizon: 'now', sourceIds: ['source', 'ci', 'next'],
        acceptance: 'Observe fresh worker/PR/CI status and pin only completed source evidence. Reconcile the current 46-task plan against legacy local/main records without resetting anything. Record unverified work separately; do not duplicate an active implementation task.' },
      { key: 'wiring', title: 'Finish protected Perplexity service wiring', existingWork: 'L3 step 12 prerequisites / W6 follow-up', milestoneTitle: 'Coherent end-to-end operation', horizon: 'now', sourceIds: ['gaps', 'install'],
        acceptance: 'Compose Research/Leader handlers inside the protected boundary; pin endpoints, reservations/receipts and owner switch. Verify fail-closed behavior with paid calls disabled. Prepare concrete activation material for owner review; no external paid call or service start is authorized by this proposal.' },
      { key: 'install', title: 'Prepare L3 installation acceptance', existingWork: 'L3 checklist / T17 / T21', milestoneTitle: 'Coherent end-to-end operation', horizon: 'next', sourceIds: ['install', 'gaps'],
        acceptance: 'Prepare a pinned candidate/image/config checklist covering preservation of books/receipts, financial continuity, candle store, owner limits, duplicate collectors, quote rate and real TraderWakeReply evidence. Identify outstanding checks and request the owner’s explicit installation decision. This task is preparation only; it grants no installation, runtime, paid-call or trading approval.' },
      { key: 'operation', title: 'Obtain an end-to-end day-trader operating record', existingWork: 'T17; new engine acceptance', milestoneTitle: 'Coherent end-to-end operation', horizon: 'next', sourceIds: ['economics', 'gaps', 'install'],
        acceptance: 'After separately authorized installation/operation, record fresh candles, scan, Research/Trader inputs, honest no_action versus failure, permitted paper entry/protection/reconciliation, pause/restart and HQ truth. Recheck stale-FX/history refusal regressions; label unexercised fill paths. No service operation is authorized by adding this task.' },
      { key: 'evaluation', title: 'Preregister T43 with T18 after-cost controls', existingWork: 'T43 / T18 / T42 scorecard', milestoneTitle: 'Profitability demonstrated', horizon: 'next', sourceIds: ['economics', 'scorecard', 'next'],
        acceptance: 'Declare a future window, sources, fee/fill profiles and control rules before an authorized run. Retain attempted variants; compare cash/BTC and existing T18 controls, drawdown and sensitivity. Count AI/hosting/shared costs once and preserve unknown ranges. Report supported, unsupported or insufficient evidence without assuming profitability.' },
    ],
  },
];

function repositoryIdentity(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== 'github.com' || parsed.port || parsed.username || parsed.password || parsed.search || parsed.hash) return null;
    const path = parsed.pathname.replace(/\/+$/, '').replace(/\.git$/i, '').toLowerCase();
    return /^\/[^/]+\/[^/]+$/.test(path) ? path.slice(1) : null;
  } catch { return null; }
}

export function getProjectBaseline(project: Project): ProjectBaselineData | null {
  const identities = project.repositories.map(repo => repositoryIdentity(repo.url));
  const matching = PROJECT_BASELINES.filter(baseline => identities.some(identity => identity !== null && baseline.repositories.includes(identity)));
  return matching.length === 1 ? matching[0] : null;
}

// Include a bounded project prefix and two independent hashes; every occupied ID is checked before mutation.
function scope(projectId: string): string {
  let a = 2166136261, b = 5381;
  for (const code of projectId) { a = Math.imul(a ^ code.codePointAt(0)!, 16777619); b = Math.imul(b, 33) ^ code.codePointAt(0)!; }
  return `${projectId.slice(0, 48)}:${(a >>> 0).toString(16).padStart(8, '0')}${(b >>> 0).toString(16).padStart(8, '0')}`;
}
export function baselineRecordId(projectId: string, action: string): string {
  return `baseline:${BASELINE_ID}:${scope(projectId)}:${action}`;
}

export function previewProjectBaseline(workspace: Workspace, projectId: string): BaselineProposal[] {
  const project = workspace.projects.find(candidate => candidate.id === projectId);
  const baseline = project && getProjectBaseline(project);
  if (!baseline) return [];
  return baseline.actions.map(action => {
    const matches = action.milestoneTitle ? workspace.milestones.filter(m => m.projectId === projectId && m.title === action.milestoneTitle) : [];
    const milestoneId = matches.length === 1 ? matches[0].id : null;
    const milestoneNote = milestoneId ? action.milestoneTitle! : action.milestoneTitle
      ? `Unlinked: original milestone “${action.milestoneTitle}” is missing, renamed or ambiguous.`
      : 'Unlinked: broader release scope; choose a milestone when appropriate.';
    const id = baselineRecordId(projectId, action.key);
    return { ...action, id, milestoneId, milestoneNote, exists: workspace.tasks.some(task => task.id === id && task.projectId === projectId) };
  });
}

export function baselineApplicationState(workspace: Workspace, projectId: string): BaselineApplicationState {
  const project = workspace.projects.find(candidate => candidate.id === projectId);
  if (!project || !getProjectBaseline(project)) return { status: 'unsupported', markerId: null, existingCount: 0, missingCount: 0, message: 'Baseline requires exactly one supported project identity from a verified repository URL.' };
  const proposals = previewProjectBaseline(workspace, projectId);
  const markerId = baselineRecordId(projectId, 'context');
  const expected = new Map([...proposals.map(p => [p.id, 'task'] as const), [markerId, 'capture'] as const]);
  for (const [kind, records] of [['project', workspace.projects], ['milestone', workspace.milestones], ['task', workspace.tasks], ['capture', workspace.captures], ['activity', workspace.activity]] as const) {
    for (const entry of records) {
      const expectedKind = expected.get(entry.id);
      if (expectedKind && (kind !== expectedKind || !('projectId' in entry) || entry.projectId !== projectId)) {
        return { status: 'conflict', markerId, existingCount: 0, missingCount: proposals.length, message: 'Baseline record ID collision with another project or record type. Nothing can be added.' };
      }
    }
  }
  const marker = workspace.captures.some(capture => capture.id === markerId && capture.projectId === projectId);
  const existingCount = proposals.filter(p => p.exists).length;
  const missingCount = proposals.length - existingCount;
  if (marker && missingCount) return { status: 'incomplete', markerId, existingCount, missingCount, message: 'Saved baseline context exists but proposal records are missing. Review the restored/exported data; existing decisions will not be silently reinserted.' };
  if (marker) return { status: 'applied', markerId, existingCount, missingCount, message: 'Dated context and all five proposal records are saved. Later edits and archives are preserved.' };
  return { status: 'available', markerId, existingCount, missingCount, message: existingCount ? `${existingCount} existing proposal record(s) will be preserved; only missing records and dated context will be added.` : 'Adds five proposed tasks and one filed context. Existing plans, progress and commitments stay intact.' };
}

function sourceText(source: BaselineSource): string {
  const basis = source.basis === 'observed' ? 'Observed source' : source.basis === 'documented' ? 'Documented result' : 'Recorded owner decision';
  return `[${basis}; ${source.date}${source.revision ? `; ${source.revision.slice(0, 7)}` : '; local document'}] ${source.label}\n${source.repository} / ${source.path}\n${source.summary}${source.url ? `\n${source.url}` : ''}`;
}

function contextText(baseline: ProjectBaselineData): string {
  return [
    `Baseline ${BASELINE_ID}; checked ${baseline.checkedAt}. Dated research, not live monitoring. Both projects have equal priority.`,
    baseline.status, baseline.provenance,
    'Evidence classifications: Observed = read directly on the check date. Documented = a dated report, not independently rerun. Recorded owner decisions are evidence, not new permission.',
    'Accomplishments:\n' + baseline.accomplishments.map(item => '- ' + item).join('\n'),
    'Blockers and unknowns:\n' + baseline.blockers.map(item => '- ' + item).join('\n'),
    'Saved source evidence:\n' + baseline.sources.map(sourceText).join('\n\n'),
    'Proposed follow-up work:\n' + baseline.actions.map(action => `- ${action.title} (${action.existingWork})`).join('\n'),
    'No runtime verification, installation, trading, paid call or deployment was performed by this baseline. No demonstrated profitability or release acceptance is inferred.',
  ].join('\n\n');
}

/** All checks precede any returned change. Deterministic records make retries independent of mutation receipts. */
export function applyProjectBaseline(workspace: Workspace, projectId: string, baselineId: string, at: string): Workspace {
  if (baselineId !== BASELINE_ID) throw new Error('Select the supported baseline dated 2026-10-17.');
  const project = workspace.projects.find(candidate => candidate.id === projectId);
  if (!project) throw new Error('Select an existing project.');
  const state = baselineApplicationState(workspace, projectId);
  if (state.status === 'unsupported') throw new Error('A baseline requires a verified repository URL for one supported project; multiple identities are ambiguous.');
  if (state.status === 'conflict' || state.status === 'incomplete') throw new Error(state.message);
  if (state.status === 'applied') return structuredClone(workspace);
  const baseline = getProjectBaseline(project)!;
  const proposals = previewProjectBaseline(workspace, projectId).filter(proposal => !proposal.exists);
  if (workspace.tasks.length + proposals.length > WORKSPACE_LIMITS.tasks) throw new Error('Baseline exceeds the workspace task limit; nothing was added.');
  if (workspace.captures.length + 1 > WORKSPACE_LIMITS.captures) throw new Error('Baseline exceeds the workspace capture limit; nothing was added.');
  const body = contextText(baseline);
  if (body.length > 10000) throw new Error('Bundled baseline context exceeds the capture limit.');
  const tasks: Task[] = proposals.map(proposal => {
    const sources = baseline.sources.filter(source => proposal.sourceIds.includes(source.id));
    return {
      id: proposal.id, estimateMinutes:null, projectId, milestoneId: proposal.milestoneId, title: proposal.title,
      notes: `Proposed from baseline ${BASELINE_ID}. Existing work: ${proposal.existingWork}.\n\nAcceptance: ${proposal.acceptance}\n\nMilestone: ${proposal.milestoneNote}\n\nSource evidence (dated; not a new verification):\n${sources.map(sourceText).join('\n\n')}`,
      status: 'proposed', horizon: proposal.horizon, priority: 'normal', dueDate: null,
      weekly: false, weeklyWeek: null, dependsOn: [], blocker: '', sourceUrl: sources.find(source => source.url)?.url ?? null,
      evidence: '', createdAt: at, updatedAt: at, completedAt: null, archivedFromStatus: null,
    };
  });
  const capture: Capture = {
    id: state.markerId!, projectId, title: `Baseline context · ${BASELINE_ID}`, body, kind: 'decision',
    sourceUrl: baseline.sources.find(source => source.url)?.url ?? null, status: 'filed', createdAt: at, convertedTaskId: null,
  };
  const next = structuredClone(workspace);
  next.tasks.push(...tasks);
  next.captures.push(capture);
  // The same strict contract as persistence/export also catches byte capacity and global ID/reference issues.
  parseWorkspaceExport(next);
  return next;
}

