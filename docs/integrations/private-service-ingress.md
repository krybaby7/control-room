# Private bridge ingress

Status: **unsupported by default; real acquisition and renewal unverified**.

Platform ingress grants access to the private hosted application. A separately enrolled application device credential identifies one mapped device and its telemetry scope. Neither substitutes for the other. A supplied owner header, browser login or another subsystem's service token is not device authority.

The bridge defaults to unavailablePrivateIngress. A server-selected adapter must supply supported platform headers and a future expiration for the exact HTTPS origin, method and fixed bridge endpoint. No production credential supplier is included or implicitly selected. Keep the hosted application private. Redirects, browser cookies, fabricated visitor/owner headers and arbitrary proxy headers are not fallbacks.

Before activation record supported platform documentation and deployment evidence, without credential values:

| Required proof | Current result |
| --- | --- |
| Intended private deployment and endpoint allowlist | Deployment verification pending |
| Supported unattended Windows credential acquisition | NOT VERIFIED |
| Supported header names and least privilege scope | NOT VERIFIED; do not guess arbitrary headers |
| Expiration, renewal and revocation behavior | NOT VERIFIED |
| Renewal under the actual current-user logon task | NOT RUN on Windows |
| Ingress without application device identity is denied | Synthetic protocol evidence only; intended deployment must be checked |
| Device identity without verified ingress is denied | Intended private deployment must be checked |
| Owner isolation and telemetry-only scope | Application fixtures do not prove private platform access |

Authentication failure stops upload and requires reconnect. It does not copy browser cookies, silently re-enroll, change privacy or expose a loopback service. Detailed local errors and credentials must not enter issues, exports, screenshots or cloud telemetry.

If supported acquisition and renewal are unavailable, leave transport disconnected. A relay is a separate deployment design and owner decision; it must retain mapped device identity and cannot fabricate visitor headers. Synthetic ingress proves protocol behavior, not live private-site access.
