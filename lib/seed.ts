import type { Workspace, Milestone, Task, Horizon, Priority } from './types.ts';

/** Initial content is editable planning, with no inferred commitments or completion. */
export function createSeedWorkspace(now?: string): Workspace {
  const instant = now === undefined ? new Date() : new Date(now);
  if (!Number.isFinite(instant.getTime())) throw new Error('The current timestamp is invalid.');
  const at = instant.toISOString();
  const tamenni = crypto.randomUUID();
  const tradeGraph = crypto.randomUUID();
  const milestones: Milestone[] = [];
  const tasks: Task[] = [];

  function milestone(projectId: string, title: string, description: string, acceptance: string): string {
    const id = crypto.randomUUID();
    milestones.push({ archivedAt:null, sortKey:milestones.filter(row=>row.projectId===projectId).length, id, projectId, title, description, acceptance, status: 'planned', targetDate: null, evidence: '', updatedAt: at });
    return id;
  }

  function task(projectId: string, milestoneId: string, title: string, notes: string, sourceUrl: string, horizon: Horizon = 'now', priority: Priority = 'normal', dependsOn: string[] = []): string {
    const id = crypto.randomUUID();
    tasks.push({ areaId:null,workType:'other',estimateMinutes:null, id, projectId, milestoneId, title, notes, sourceUrl, horizon, priority, dependsOn, status: 'proposed', dueDate: null, weekly: false, weeklyWeek: null, archivedFromStatus: null, blocker: '', evidence: '', createdAt: at, updatedAt: at, completedAt: null });
    return id;
  }

  const android = milestone(tamenni, 'Android reliability accepted',
    'Agree the Android experience and evidence needed before claiming release readiness.',
    'Owner approves a device and OS matrix, critical user journeys, reliability thresholds, and recorded results on that matrix.');
  const maps = milestone(tamenni, 'Map launch coverage accepted',
    'Define which places, landmarks and map behaviors must be covered at launch.',
    'Owner approves launch geography and coverage criteria, reviews representative map results, and records known gaps and the acceptance decision.');
  const integration = milestone(tamenni, 'Map lab integrated into the app',
    'Turn accepted map lab work into an explicit, verifiable app integration.',
    'A documented map-to-app contract and an end-to-end Android demonstration pass owner-approved acceptance criteria.');
  const scaling = milestone(tamenni, 'Scaling readiness demonstrated',
    'Choose realistic demand targets and validate capacity, failure handling and operating costs.',
    'Document target load, latency and reliability thresholds; record representative tests, bottlenecks, cost estimates and an owner review.');
  const economics = milestone(tamenni, 'Viable profit structure validated',
    'Choose a pricing and cost structure supported by explicit assumptions and evidence of business viability.',
    'Owner chooses a pricing and cost structure that meets agreed viability criteria, supported by documented usage assumptions, provider and operating costs, sensitivity analysis and relevant evidence.');
  const operation = milestone(tradeGraph, 'Coherent end-to-end operation',
    'Establish that the intended trading workflow can be understood and inspected as one complete cycle.',
    'Owner approves operating criteria and reviews a complete controlled cycle from inputs and decisions through execution, reconciliation and observability.');
  const profitability = milestone(tradeGraph, 'Profitability demonstrated',
    'Refine coherent operation toward demonstrated profitability. Evaluation supports this outcome; implementation progress alone does not establish it.',
    'The agreed net-profit criterion is actually met over a defined evidence period after trading fees, slippage, funding where applicable, and operating costs. Owner reviews reproducible results, risk assumptions and limitations before recording achievement.');

  const androidCriteria = task(tamenni, android, 'Define Android device acceptance',
    'Editable suggestion: choose supported devices and Android versions, critical journeys, and acceptable crash, latency and recovery behavior. Record what evidence will count as owner acceptance.',
    'https://github.com/krybaby7/TMNI', 'now', 'high');
  task(tamenni, maps, 'Define map launch coverage',
    'Editable suggestion: choose launch geography, required landmarks and coverage quality. Name examples that must work and gaps that may remain, so map acceptance is a clear decision.',
    'https://github.com/krybaby7/tameni-map-lab');
  task(tamenni, maps, 'Review the landmark map source and PR #103',
    'Observed source in the 17 October 2026 planning snapshot: landmark map lab PR #103. This dated observation requires owner review; it does not establish the current live PR status or prove map acceptance. Open the source, inspect its current changes and checks, and record your review decision.',
    'https://github.com/krybaby7/tameni-map-lab/pull/103', 'now', 'high');
  task(tamenni, integration, 'Define the map-to-app handoff',
    'Editable suggestion: specify the accepted map inputs, outputs, data ownership and Android integration path. Agree one end-to-end demonstration and the evidence needed to accept the handoff.',
    'https://github.com/krybaby7/TMNI', 'next');
  task(tamenni, scaling, 'Define scaling targets and a validation plan',
    'Editable suggestion: choose representative users, request volume, latency and recovery expectations. Identify tests and cost observations needed before judging readiness to scale.',
    'https://github.com/krybaby7/TMNI', 'next');
  task(tamenni, economics, 'Write pricing and cost assumptions',
    'Editable suggestion: outline who pays, candidate pricing, expected usage and provider or operating costs. Keep assumptions explicit and compare scenarios before recording a business decision.',
    'https://github.com/krybaby7/TMNI', 'next');
  task(tamenni, android, 'Plan an Android reliability acceptance run',
    'Editable suggestion: after agreeing device acceptance, plan a reproducible run through critical journeys and record failures, recoveries and results. This is a proposed validation activity, not a claim that the app has passed.',
    'https://github.com/krybaby7/TMNI', 'next', 'normal', [androidCriteria]);

  const operatingCriteria = task(tradeGraph, operation, 'Define end-to-end operating criteria',
    'Editable suggestion: describe a coherent trading cycle, its required inputs, decision records, execution behavior, reconciliation and failure handling. Agree what evidence the owner must inspect before marking operation accepted.',
    'https://github.com/krybaby7/trade-graph', 'now', 'high');
  const operationReview = task(tradeGraph, operation, 'Inspect a complete trading cycle',
    'Editable suggestion: use the agreed operating criteria to inspect a controlled complete cycle. Record observed behavior, failures and owner review. A working cycle is an operating observation and does not establish profitability.',
    'https://github.com/krybaby7/trade-graph', 'next', 'normal', [operatingCriteria]);
  task(tradeGraph, profitability, 'Define profitability evaluation after fees and costs',
    'Editable suggestion: after reviewing a complete operating cycle, define a reproducible evaluation period, data, risk assumptions and reporting method. Include fees, slippage, funding where applicable and infrastructure costs; distinguish measured results from projections.',
    'https://github.com/krybaby7/trade-graph', 'later', 'normal', [operationReview]);

  return {
    schemaVersion: 5, areas: [],
    projects: [
      { id: tamenni, name: 'TAMENNI', color: 'orange', priority: 'equal', archivedAt:null,
        description: 'Android product and map experience, with explicit acceptance for reliability, launch coverage, integration, scaling and economics.',
        goal: 'Deliver an Android experience with accepted map coverage, a verified map-to-app integration, demonstrated scaling readiness and a validated viable profit structure.',
        repositories: [{ name: 'Application', url: 'https://github.com/krybaby7/TMNI' }, { name: 'Map lab', url: 'https://github.com/krybaby7/tameni-map-lab' }] },
      { id: tradeGraph, name: 'Trade Graph', color: 'teal', priority: 'equal', archivedAt:null,
        description: 'Establish coherent operation first, then refine the graph toward demonstrated profitability after trading and operating costs.',
        goal: 'Refine a coherent trading graph toward demonstrated profitability, supported by an accepted operating cycle and reproducible evidence that accounts for fees, costs and risk.',
        repositories: [{ name: 'Trade Graph', url: 'https://github.com/krybaby7/trade-graph' }] },
    ],
    milestones, tasks,
    captures: [{ id: crypto.randomUUID(), title: 'Planning first; both products have equal priority',
      body: 'Owner direction recorded on 17 October 2026: TAMENNI and Trade Graph have equal priority. This release supports project clarity, next actions, milestones, dates, tasks and capture. Agent coordination and automated source connections come later. Initial tasks and acceptance criteria are editable suggestions, with no assumed deadlines or weekly commitments.',
      projectId: null, kind: 'decision', sourceUrl: null, status: 'filed', createdAt: at, convertedTaskId: null }],
    activity: [{ id: crypto.randomUUID(), text: 'Created editable planning suggestions from owner goals and the 17 October 2026 source snapshot.', at, projectId: null }],
  };
}
