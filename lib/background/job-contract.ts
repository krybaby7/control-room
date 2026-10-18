/** Private extension of a foundation workspace_job_intents row, never a second queue. */
export interface IntegrationJobExtension {intentId:string;sourceId:string;configurationHash:string}
export interface IntegrationJobClaim extends IntegrationJobExtension {scheduleId?:string|null;scheduleConfigurationHash?:string|null;occurrenceDueAt?:string|null;automationPrincipalRef?:string|null;ownerId:string;executionEpoch:number;operationalRevision:number;jobRevision:number;connectionId:string;accessMode:'manual'|'interactive'|'unattended';principalRef:string;token:string;expiresAt:string;attempt:number;cursor:string|null;etag:string|null}
/** Constructed only after authenticating a registered renewable server principal. */
export interface IntegrationPrincipal {ownerId:string;principalId:string;scope:readonly ['source:read'];expiresAt:string}
export type IntegrationJobResult={status:'completed'|'partial'|'cancelled'}|{status:'blocked';reason:string}|{status:'retry';retryAt:string|null;reason:string};

export type SourceJobAuthority={mode:'manual';authenticatedOwner:string}|{mode:'interactive';authenticatedOwner:string;principalRef:string}|{mode:'unattended';principal:IntegrationPrincipal};
