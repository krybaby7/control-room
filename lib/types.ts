export type ProjectId = string;
export type TaskStatus = 'proposed' | 'todo' | 'doing' | 'review' | 'done' | 'archived';
export type Horizon = 'now' | 'next' | 'later';
export type Priority = 'high' | 'normal' | 'low';
export type MilestoneStatus = 'planned' | 'active' | 'achieved';
export type CaptureKind = 'idea' | 'task' | 'decision';
export interface Project { id: string; name: string; description: string; goal: string; color: 'orange' | 'teal'; priority: 'equal'; repositories: { name: string; url: string }[]; }
export interface MilestoneInput { projectId: string; title: string; description: string; acceptance: string; status: MilestoneStatus; targetDate: string | null; evidence: string; }
export interface Milestone extends MilestoneInput { id: string; updatedAt: string; }
export interface TaskInput { projectId: string; milestoneId: string | null; title: string; notes: string; status: TaskStatus; horizon: Horizon; priority: Priority; dueDate: string | null; weekly: boolean; dependsOn: string[]; blocker: string; sourceUrl: string | null; evidence: string; }
export interface Task extends TaskInput { id: string; createdAt: string; updatedAt: string; completedAt: string | null; }
export interface CaptureInput { title: string; body: string; projectId: string | null; kind: CaptureKind; sourceUrl: string | null; }
export interface Capture extends CaptureInput { id: string; status: 'inbox' | 'filed' | 'archived'; createdAt: string; convertedTaskId: string | null; }
export interface Activity { id: string; text: string; at: string; projectId: string | null; }
export interface Workspace { schemaVersion: 1; projects: Project[]; milestones: Milestone[]; tasks: Task[]; captures: Capture[]; activity: Activity[]; }
export interface WorkspaceEnvelope { workspace: Workspace; revision: number; updatedAt: string; }
export type Command =
  | { type: 'task.create'; task: TaskInput }
  | { type: 'task.update'; id: string; patch: Partial<TaskInput> }
  | { type: 'milestone.create'; milestone: MilestoneInput }
  | { type: 'milestone.update'; id: string; patch: Partial<MilestoneInput> }
  | { type: 'project.update'; id: string; patch: Partial<Pick<Project, 'description' | 'goal'>> }
  | { type: 'capture.create'; capture: CaptureInput }
  | { type: 'capture.update'; id: string; patch: Partial<CaptureInput & { status: Capture['status'] }> }
  | { type: 'capture.convert'; id: string; milestoneId: string | null; horizon: Horizon; projectId?: string };
export interface Recommendation { taskId: string; reason: string; }
