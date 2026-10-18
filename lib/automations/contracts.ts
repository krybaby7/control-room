export type AutomationKind='source_refresh'|'daily_review'|'weekly_review'|'backup';
export type AutomationRecurrence={frequency:'daily';localTime:string}|{frequency:'weekly';localTime:string;weekday:number}|{frequency:'interval';minutes:number;anchorAt:string};
/** Owner configuration only. Imported enabled flags never establish runtime authority. */
export interface AutomationSchedule {id:string;kind:AutomationKind;timezone:'Africa/Cairo';enabled:boolean;configurationVersion:number;recurrence:AutomationRecurrence;sourceId:string|null;projectIds:string[];catchUp:'latest_only';backupMode?:'metadata'|'files';fileBackupConsent?:boolean;createdAt:string;updatedAt:string;archivedAt:string|null}
export type AutomationFailure='unsupported'|'principal_unavailable'|'configuration_changed'|'storage_unavailable'|'storage_capacity'|'timeout'|'cancelled'|'execution_failed';
export interface AutomationRuntime {scheduleId:string;configurationHash:string;operationalRevision:number;executionEpoch:number;paused:boolean;nextDueAt:string;lastAttemptAt:string|null;lastSuccessAt:string|null;failure:AutomationFailure|null;retryAt:string|null}
/** Terminal portable history, never a queue or executable intent. */
export interface AutomationOccurrence {id:string;scheduleId:string;dueAt:string;kind:AutomationKind;configurationHash:string;startedAt:string;finishedAt:string;outcome:'success'|'failed'|'cancelled'|'partial';failure:AutomationFailure|null;missedPeriods:number;resultRef:{kind:'source-run'|'review'|'backup';id:string;hash:string|null}|null}
export const AUTOMATION_LIMITS=Object.freeze({schedules:100,duePerWakeup:10,missedPeriods:100000,leaseMs:30000,runMs:20000});
/** Private lease over an existing foundation metadata-backup intent. */
export interface ScheduledBackupClaim {ownerId:string;intentId:string;backupId:string;configurationHash:string;jobRevision:number;executionEpoch:number;attempt:number;token:string;expiresAt:string;startedAt:string;accessMode:'unattended';principalRef:string;scheduleId:string;scheduleConfigurationHash:string;occurrenceDueAt:string}
