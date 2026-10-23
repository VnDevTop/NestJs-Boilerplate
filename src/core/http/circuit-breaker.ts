/**
 * Circuit breaker for outbound HTTP calls.
 *
 * States:
 * - `closed` — calls pass through; failures increment the failure count.
 * - `open` — calls are rejected immediately without attempting the request,
 *   because the downstream is believed to be unhealthy.
 * - `half-open` — one trial call is allowed after the recovery timeout; if it
 *   succeeds the breaker closes, if it fails the breaker reopens.
 *
 * Failure count resets on success while closed, so a breaker with a healthy
 * downstream never opens. The failure threshold and recovery timeout are
 * configurable per breaker instance.
 */
export enum CircuitState {
  Closed = 'closed',
  Open = 'open',
  HalfOpen = 'half-open',
}

export interface CircuitBreakerOptions {
  /** Failures within `windowMs` that flip the breaker to open. */
  readonly failureThreshold: number;
  /** Window in milliseconds for counting failures. */
  readonly windowMs: number;
  /** Milliseconds to wait in open before allowing a trial call. */
  readonly recoveryTimeoutMs: number;
}

/**
 * Result of a breaker-guarded call.
 */
export interface CircuitBreakerResult<T> {
  readonly value: T;
  readonly state: CircuitState;
  readonly opened: boolean;
}

/**
 * A breaker that wraps an async function. On each call it decides whether the
 * request may proceed based on current state, then records success or failure.
 *
 * The breaker is safe to share across call sites: all calls to the same
 * downstream service use the same breaker instance and therefore the same
 * state.
 */
export class CircuitBreaker {
  private state: CircuitState = CircuitState.Closed;
  private failures: number[] = [];
  private lastStateChangeMs = 0;
  private halfOpenCallAllowed = false;

  constructor(private readonly options: CircuitBreakerOptions) {
    this.lastStateChangeMs = Date.now();
  }

  /**
   * Current state of the breaker.
   */
  get currentState(): CircuitState {
    return this.state;
  }

  /**
   * Number of failures recorded in the current window.
   */
  get failureCount(): number {
    this.expireOldFailures();
    return this.failures.length;
  }

  /**
   * Execute `fn` through the breaker. If the breaker is open, the call is
   * rejected without touching `fn`. If half-open, exactly one call proceeds.
   *
   * On success, the failure count resets and the breaker closes. On failure,
   * the failure count increments and may flip the breaker to open.
   */
  async execute<T>(fn: () => Promise<T>): Promise<CircuitBreakerResult<T>> {
    this.transition();

    if (this.state === CircuitState.Open) {
      throw new CircuitBreakerOpenError(
        'Circuit breaker is open; call rejected without attempting request.',
      );
    }

    if (this.state === CircuitState.HalfOpen) {
      if (!this.halfOpenCallAllowed) {
        throw new CircuitBreakerOpenError(
          'Circuit breaker is half-open; trial call already in progress.',
        );
      }
      this.halfOpenCallAllowed = false;
    }

    try {
      const value = await fn();
      this.onSuccess();
      return { value, state: this.state, opened: false };
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  private transition(): void {
    const now = Date.now();

    switch (this.state) {
      case CircuitState.Closed:
        this.expireOldFailures();
        if (this.failures.length >= this.options.failureThreshold) {
          this.setState(CircuitState.Open, now);
        }
        break;

      case CircuitState.Open:
        if (now - this.lastStateChangeMs >= this.options.recoveryTimeoutMs) {
          this.setState(CircuitState.HalfOpen, now);
          this.halfOpenCallAllowed = true;
        }
        break;

      case CircuitState.HalfOpen:
        // A trial call is in progress or already decided; nothing to transition.
        break;
    }
  }

  private onSuccess(): void {
    this.failures = [];
    if (this.state === CircuitState.HalfOpen) {
      this.setState(CircuitState.Closed, Date.now());
    }
  }

  private onFailure(): void {
    this.failures.push(Date.now());
    if (this.state === CircuitState.HalfOpen) {
      this.setState(CircuitState.Open, Date.now());
      this.halfOpenCallAllowed = false;
    } else if (this.failures.length >= this.options.failureThreshold) {
      this.setState(CircuitState.Open, Date.now());
    }
  }

  private setState(state: CircuitState, now: number): void {
    this.state = state;
    this.lastStateChangeMs = now;
  }

  private expireOldFailures(): void {
    const cutoff = Date.now() - this.options.windowMs;
    this.failures = this.failures.filter((ts) => ts > cutoff);
  }
}

/**
 * Thrown when the circuit breaker is open and rejects a call.
 */
export class CircuitBreakerOpenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CircuitBreakerOpenError';
  }
}
