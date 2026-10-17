'use client';

import { createContext } from 'react';

// Expiry is latched until a full same-origin sign-in navigation. Private drafts
// remain only in component memory and are never revealed after an account switch.
export const SessionExpiredContext = createContext(false);
