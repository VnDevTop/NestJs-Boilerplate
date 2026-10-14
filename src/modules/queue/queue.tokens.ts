/**
 * The injection tokens the queue is provided under.
 *
 * In their own file, and that is the whole reason. A token is a string; reading
 * one used to mean importing `queue.module.ts`, which means evaluating the
 * entire queue graph — and `QueueModule` imports the retention module, whose
 * scheduled entry point imports `QueueModule` back. That cycle is invisible in
 * the source, resolves under `node` because the evaluation order happens to
 * suit it, and fails under any other loader with
 * `The module at index [2] of the QueueModule "imports" array is undefined`.
 *
 * A token has no dependencies, so it is in a file with none, and the cycle cannot
 * be re-created by importing a constant.
 *
 * `queue.module.ts` re-exports both, so `app.module.ts` and anything already
 * importing from there keep working.
 */

/** The queue itself. A consumer injects this and never branches on the driver. */
export const JOB_QUEUE = 'JOB_QUEUE';

/**
 * The registry the deduplication wrapper decorates.
 *
 * Separate from `JOB_QUEUE` because the queue holds a reference to it, so
 * providing one from the other would be a cycle of its own.
 */
export const PROCESSOR_REGISTRY = 'PROCESSOR_REGISTRY';
