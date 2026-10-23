/**
 * Retry budget for outbound HTTP calls.
 *
 * A retry budget prevents a retry storm from outliving the outage that caused it.
 * Each call site draws from the budget when it retries; when the budget is
 * exhausted, further retries are rejected until the budget refills.
 *
 * The budget is per-breaker-key (typically the downstream host), so an outage
 * on one downstream does not block retries for a healthy downstream.
 */
export interface RetryBudgetOptions {
  /** Maximum number of retries allowed per window. */
  readonly maxRetries: number;
  /** Time window in milliseconds. */
  readonly windowMs: number;
}

/**
 * A retry budget that tracks how many retries have been consumed in the
 * current window for a given key.
 */
export class RetryBudget {
  private readonly windows = new Map<string, number[]>();

  constructor(private readonly options: RetryBudgetOptions) {}

  /**
   * Returns true if a retry should be allowed for the given key, consuming one
   * retry from the budget. Returns false if the budget is exhausted.
   */
  tryConsume(key: string): boolean {
    this.expireOld(key);

    const window = this.windows.get(key) ?? [];
    if (window.length >= this.options.maxRetries) {
      return false;
    }

    window.push(Date.now());
    this.windows.set(key, window);
    return true;
  }

  /**
   * Returns the number of retries remaining in the current window for the key.
   */
  remaining(key: string): number {
    this.expireOld(key);
    const window = this.windows.get(key) ?? [];
    return Math.max(0, this.options.maxRetries - window.length);
  }

  /**
   * Clears the budget for a specific key (e.g. after a successful call).
   */
  clear(key: string): void {
    this.windows.delete(key);
  }

  private expireOld(key: string): void {
    const cutoff = Date.now() - this.options.windowMs;
    const window = this.windows.get(key);
    if (!window) return;

    const filtered = window.filter((ts) => ts > cutoff);
    if (filtered.length === 0) {
      this.windows.delete(key);
    } else {
      this.windows.set(key, filtered);
    }
  }
}

/**
 * Options for the global retry budget registry.
 */
export interface RetryBudgetRegistryOptions {
  /** Default budget options used when a key is not explicitly configured. */
  readonly default: RetryBudgetOptions;
  /** Optional per-key overrides. */
  readonly perKey?: Partial<Record<string, RetryBudgetOptions>>;
}

/**
 * Registry of retry budgets keyed by downstream identifier (e.g. hostname).
 */
export class RetryBudgetRegistry {
  private readonly budgets = new Map<string, RetryBudget>();

  constructor(private readonly options: RetryBudgetRegistryOptions) {}

  /**
   * Get or create the budget for a key.
   */
  budget(key: string): RetryBudget {
    let budget = this.budgets.get(key);
    if (!budget) {
      const opts = this.options.perKey?.[key] ?? this.options.default;
      budget = new RetryBudget(opts);
      this.budgets.set(key, budget);
    }
    return budget;
  }

  /**
   * Try to consume a retry for the key. Returns true if allowed.
   */
  tryConsume(key: string): boolean {
    return this.budget(key).tryConsume(key);
  }

  /**
   * Remaining retries for the key.
   */
  remaining(key: string): number {
    return this.budget(key).remaining(key);
  }

  /**
   * Clear budget for a key (e.g. after successful call).
   */
  clear(key: string): void {
    this.budgets.get(key)?.clear(key);
  }
}
