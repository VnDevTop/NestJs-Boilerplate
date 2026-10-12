import { SetMetadata } from '@nestjs/common';

import { AUDIT_KEY } from '../constants/index.js';
import type { AuditPolicy } from '../constants/index.js';

/**
 * Marks a route as one whose execution belongs in the audit trail.
 *
 * **Opt-in, like every other gate in this application.** An audit log that records
 * every request is a log nobody reads, and the entries that do matter — a
 * permission changed, an account deleted, a role granted — are exactly the ones a
 * developer has to remember. The alternative, defaulting to on, would produce a
 * table dominated by sign-ins and profile reads, which is the failure this whole
 * module is built to avoid.
 *
 * The cost is the same one the verified-email gate has: a route added without this
 * decorator is unaudited. `audit-policy.spec.ts` closes that by asserting every
 * privileged route carries it, so the cost is caught by the build rather than
 * discovered during an incident.
 *
 * ```ts
 * @Audited({ action: 'users.delete', target: 'user' })
 * @Delete(':id')
 * remove(@Param('id') id: string) { … }
 * ```
 */
export const Audited = (policy: AuditPolicy) => SetMetadata(AUDIT_KEY, policy);
