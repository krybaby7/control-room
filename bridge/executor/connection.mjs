import {unavailablePrivateIngress} from '../src/transport.mjs';
/** Reviewed local source registry only. No launch JSON, cookies, arbitrary module
 * paths or caller headers can establish platform ingress. */
export function resolveExecutionPrivateIngress(){return unavailablePrivateIngress;}
