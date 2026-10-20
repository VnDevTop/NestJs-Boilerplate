import { randomUUID } from 'node:crypto';

/**
 * Mints the id a job is known by.
 *
 * A uuid rather than a counter or a timestamp, because the id is handed to an
 * HTTP route and to a log line and has to be unguessable enough that one
 * operator cannot read another operator's job by walking the ids. It is also
 * minted by the queue rather than by the caller, so it is unique across
 * processes: two replicas enqueueing at the same moment cannot collide.
 *
 * Its own file because it is the one piece of the queue's vocabulary that is a
 * value rather than a type, and putting it in `queue.interface.ts` would make
 * that file importable only as a value — which the maintenance module, which
 * sits below the queue in the graph, must not do.
 */
export const newJobId = (): string => randomUUID();
