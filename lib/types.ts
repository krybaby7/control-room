export type WorkType = import('./history/contracts.ts').WorkType;
export interface ProjectArea {id:string;projectId:string;name:string;aliases:string[];order:number;archivedAt:string|null;}
export interface TaskClassification {areaId:string|null;workType:WorkType;}
export type ProjectId = string;
export type TaskStatus = 'proposed' | 'todo' | 'doing' | 'review' | 'done' | 'archived';
export type Horizon = 'now' | 'next' | 'later';
export type Priority = 'high' | 'normal' | 'low';
export type MilestoneStatus = 'planned' | 'active' | 'achieved';
export type CaptureKind = 'idea' | 'task' | 'decision';
export interface Project { id: string; name: string; description: string; goal: string; color: 'orange' | 'teal'; priority: 'equal'; archivedAt: string | null; repositories: { name: string; url: string }[]; }
export interface MilestoneInput { projectId: string; title: string; description: string; acceptance: string; status: MilestoneStatus; targetDate: string | null; evidence: string; }
export interface Milestone extends MilestoneInput { id: string; updatedAt: string; archivedAt: string | null; sortKey: number; }
export interface TaskInput { areaId?:string|null; workType?:WorkType; estimateMinutes: number | null; projectId: string; milestoneId: string | null; title: string; notes: string; status: TaskStatus; horizon: Horizon; priority: Priority; dueDate: string | null; weekly: boolean; dependsOn: string[]; blocker: string; sourceUrl: string | null; evidence: string; }
export interface Task extends TaskInput { id: string; createdAt: string; updatedAt: string; completedAt: string | null; weeklyWeek?: string | null; archivedFromStatus?: Exclude<TaskStatus, 'archived'> | null; }
export interface CaptureInput { title: string; body: string; projectId: string | null; kind: CaptureKind; sourceUrl: string | null; }
export interface Capture extends CaptureInput { id: string; status: 'inbox' | 'filed' | 'archived'; createdAt: string; convertedTaskId: string | null; }
export interface Activity { id: string; text: string; at: string; projectId: string | null; }
export interface Workspace { schemaVersion: 1 | 2 | 3 | 4 | 5; areas?:ProjectArea[]; projects: Project[]; milestones: Milestone[]; tasks: Task[]; captures: Capture[]; activity: Activity[]; }
export interface WorkspaceEnvelope { workspace: Workspace; revision: number; updatedAt: string; previousBackupAvailable?: boolean; baselineRemovedIds?:string[]; }
export type Command =
  | import('./history/commands.ts').HistorySourceCommand
  | import('./history/contracts.ts').RoadmapCommand
  | import('zod').infer<typeof import('./runtime/commands.ts').enrollmentCommandSchema>
  | import('zod').infer<typeof import('./runtime/commands.ts').revokeDeviceCommandSchema>
  | import('zod').infer<typeof import('./runtime/commands.ts').configureAdapterCommandSchema>
  | import('zod').infer<typeof import('./runtime/commands.ts').selectRuntimeEvidenceCommandSchema>
  | import('zod').infer<typeof import('./sources/commands.ts').sourceCommandSchema>
  | {type:'attachment.reserve';value:{filename:string;mimeType:string;expectedBytes:number}}
  | {type:'attachment.finalize';id:string}
  | {type:'attachment.retire';id:string;reason:'owner-delete'|'expired-reservation'}
  | {type:'history.undo';eventId:string;sourceMutationId:string;previewHash:string;targetRevision:number}
  | import('./evidence-contract.ts').EvidenceCommand
  | import('zod').infer<typeof import('./decision-handlers.ts').decisionCommandSchema>
  | import('zod').infer<typeof import('./acceptance-handlers.ts').acceptanceCommandSchema>
  | import('./planning-contract.ts').PlanningWorkflowCommand
  | import('./weekly-planning.ts').WeeklyCommand
  | {type:'recurrence.create';rule:Omit<import('./recurrence.ts').RecurrenceRule,'id'>}
  | {type:'recurrence.update';id:string;expectedRuleRevision:number;rule:Omit<import('./recurrence.ts').RecurrenceRule,'id'>}
  | {type:'recurrence.materialize';id:string;from:string;through:string}
  | {type:'recurrence.occurrence.remove';ruleId:string;occurrenceDate:string;taskId:string;expectedOccurrenceRevision:number;targetRevision:number;previewHash:string}
  | import('./areas.ts').AreaCommand
  | { type: 'workspace.backup' }
  | {type:'workspace.backup.remove';id:string;sha256:string;targetRevision:number}
  | { type:'entity.delete';entityType:'task'|'capture'|'project'|'milestone';id:string;previewHash:string;targetRevision:number }
  | { type: 'workspace.import.commit'; importId:string;hash:string;targetRevision:number;mode:'replace'|'merge';selection?:{areas?:string[];projects:string[];milestones:string[];tasks:string[];captures:string[];activity:string[]} }
  | { type: 'baseline.apply'; projectId: string; baselineId: '2026-10-17' }
  | { type: 'workspace.restore'; workspace: Workspace }
  | { type: 'task.restore'; id: string }
  | { type: 'task.create'; task: TaskInput }
  | { type: 'task.update'; id: string; patch: Partial<TaskInput> }
  | { type: 'milestone.create'; milestone: MilestoneInput }
  | { type: 'milestone.update'; id: string; patch: Partial<MilestoneInput> }
  | { type: 'project.update'; id: string; patch: Partial<Pick<Project, 'description' | 'goal'>> }
  | { type: 'capture.create'; capture: CaptureInput }
  | { type: 'capture.update'; id: string; patch: Partial<CaptureInput & { status: Capture['status'] }> }
  | { type: 'capture.convert'; id: string; milestoneId: string | null; horizon: Horizon; projectId?: string; areaId?:string|null;workType?:WorkType };
export interface Recommendation { taskId: string; reason: string; }
