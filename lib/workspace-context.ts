import {prepareFileBackupRemoval} from './automations/backup-archive-removal.ts';
import type {FileBackupServices} from './automations/backup-archive-store.ts';
import {ownerAgentContext} from './agents/context.ts';
import {readLatestRuntimeEvidence} from './runtime/store.ts';
import {previewBaselineRevision} from './baselines/preview.ts';
import {canResumeAutomation} from './automations/runtime-access.ts';
import type {SqlDatabase} from './workspace-store.ts';
import type {WorkspaceEnvelope} from './types.ts';
import type {WorkspaceCommand} from './workspace-protocol.ts';
import type {PrepareContext} from './workspace-transaction.ts';
import {ownerReader} from './workspace-modules.ts';
import {readStagedImport} from './import-staging.ts';
import {readWorkspaceBackup,listWorkspaceBackups} from './workspace-backups.ts';
import {readAuditCommandGroup} from './history-command-group.ts';
import {canResumeSource} from './sources/runtime-access.ts';
import {readSourceSyncState} from './sources/store.ts';
export type OwnerCommandServices=Pick<PrepareContext,'attachmentAccess'|'verifyAttachment'|'agentArtifact'>&{fileBackupServices?:FileBackupServices;deviceEnrollment?:import('./runtime/command-contracts.ts').DeviceEnrollmentMaterial};
/** Used by authenticated server routes and the compiler; no request may override owner or authority lookups. */
export function ownerPrepareContext(db:SqlDatabase,userId:string,before:WorkspaceEnvelope,command:WorkspaceCommand,now:string,services:OwnerCommandServices={},mutationId?:string):PrepareContext{
 if(!userId)throw new Error('An authenticated owner is required.');
 const fileBackupServices=services.fileBackupServices;
 return {agentArtifact:services.agentArtifact,mutationId,userId,before,command,now,query:ownerReader(db,userId),attachmentAccess:services.attachmentAccess,verifyAttachment:services.verifyAttachment,
  agentRuntime:ownerAgentContext(db,userId,now),
  deviceRuntime:{enrollment:services.deviceEnrollment,latest:input=>readLatestRuntimeEvidence(db,userId,input)},
  baselineRuntime:{preview:input=>previewBaselineRevision(db,userId,input,now)},
  automationRuntime:{canResume:schedule=>canResumeAutomation(db,userId,schedule,now)},
  sourceRuntime:{state:sourceId=>readSourceSyncState(db,userId,sourceId),canResume:(connection,target)=>canResumeSource(db,userId,connection,target,now)},
  readImport:id=>readStagedImport(db,userId,id,now),backups:{get:id=>readWorkspaceBackup(db,userId,id),list:()=>listWorkspaceBackups(db,userId),...(fileBackupServices?{prepareFileRemoval:(input:import('./backup-removal.ts').BackupRemoval)=>prepareFileBackupRemoval(db,userId,input,fileBackupServices,now)}:{})},readAuditGroup:eventId=>readAuditCommandGroup(db,userId,eventId),
  trustedDecisionVersion:async(id,version,hash)=>Boolean(await db.prepare('SELECT decision_id FROM decision_owner_grants WHERE user_id=? AND decision_id=? AND version=? AND content_hash=?').bind(userId,id,version,hash).first()),
  trustedAcceptanceRecord:async(id,hash)=>Boolean(await db.prepare('SELECT record_id FROM acceptance_owner_grants WHERE user_id=? AND record_id=? AND content_hash=?').bind(userId,id,hash).first()),
 };
}
