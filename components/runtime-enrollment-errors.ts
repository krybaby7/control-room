/** Enrollment outcomes shared by the control centre and the runtime panel without loading the panel. */
export interface RuntimeEnrollmentResult {deviceId:string;enrollmentId:string;secret:string;expiresAt:string}
export class EnrollmentSecretUnavailableError extends Error {readonly deviceLabel:string;constructor(deviceLabel='this device'){super('The original enrollment committed, but its one-time secret cannot be recovered.');this.deviceLabel=deviceLabel;}}
export class EnrollmentNotStartedError extends Error {constructor(message='Enrollment has not been submitted. Review the request and try again.'){super(message);}}
