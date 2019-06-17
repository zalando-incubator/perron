// Based on https://github.com/yammer/circuit-breaker-js

export interface CircuitBreakerOptions {
  /** milliseconds */
  windowDuration?: number;
  numBuckets?: number;
  /** milliseconds */
  timeoutDuration?: number;
  /** percentage */
  errorThreshold?: number;
  /** absolute number */
  volumeThreshold?: number;

  onCircuitOpen?: (m: Metrics) => void;
  onCircuitClose?: (m: Metrics) => void;
}

const enum State {
  OPEN,
  HALF_OPEN,
  CLOSED
}

export interface Metrics {
  totalCount: number;
  errorCount: number;
  errorPercentage: number;
}

interface Bucket {
  failures: number;
  successes: number;
  timeouts: number;
  shortCircuits: number;
}

function createBucket(): Bucket {
  return {
    failures: 0,
    successes: 0,
    timeouts: 0,
    shortCircuits: 0
  };
}

export type Command = (success: () => void, failure: () => void) => void;

function noop() {}

export interface CircuitBreakerPublicApi {
  run(command: Command, fallback?: () => void): void;
  forceClose(): void;
  forceOpen(): void;
  unforce(): void;
  isOpen(): boolean;
}

export class CircuitBreaker implements CircuitBreakerPublicApi {
  public windowDuration: number;
  public numBuckets: number;
  public timeoutDuration: number;
  public errorThreshold: number;
  public volumeThreshold: number;

  public onCircuitOpen: (m: Metrics) => void;
  public onCircuitClose: (m: Metrics) => void;

  private readonly buckets: Bucket[];
  private state: State;
  private forced?: State;

  constructor(options?: CircuitBreakerOptions) {
    options = options || {};

    this.windowDuration = options.windowDuration || 10000;
    this.numBuckets = options.numBuckets || 10;
    this.timeoutDuration = options.timeoutDuration || 3000;
    this.errorThreshold = options.errorThreshold || 50;
    this.volumeThreshold = options.volumeThreshold || 5;

    this.onCircuitOpen = options.onCircuitOpen || noop;
    this.onCircuitClose = options.onCircuitClose || noop;

    this.buckets = [createBucket()];
    this.state = State.CLOSED;
    this.forced = undefined;

    this.startTicker();
  }

  public run(command: Command, fallback?: () => void) {
    if (this.isOpen()) {
      this.executeFallback(fallback || function() {});
    } else {
      this.executeCommand(command);
    }
  }

  public forceClose() {
    this.forced = this.state;
    this.state = State.CLOSED;
  }

  public forceOpen() {
    this.forced = this.state;
    this.state = State.OPEN;
  }

  public unforce() {
    if (this.forced !== undefined) {
      this.state = this.forced;
      this.forced = undefined;
    }
  }

  public isOpen() {
    return this.state === State.OPEN;
  }

  private startTicker() {
    const self = this;
    let bucketIndex = 0;
    const bucketDuration = this.windowDuration / this.numBuckets;

    const tick = function() {
      if (self.buckets.length > self.numBuckets) {
        self.buckets.shift();
      }

      bucketIndex++;

      if (bucketIndex > self.numBuckets) {
        bucketIndex = 0;

        if (self.isOpen()) {
          self.state = State.HALF_OPEN;
        }
      }

      self.buckets.push(createBucket());
    };

    setInterval(tick, bucketDuration);
  }

  private lastBucket() {
    return this.buckets[this.buckets.length - 1];
  }

  private executeCommand(command: Command) {
    const self = this;
    let timeout: NodeJS.Timer | undefined;

    const increment = function(prop: keyof Bucket) {
      return function() {
        if (!timeout) {
          return;
        }

        const bucket = self.lastBucket();
        bucket[prop]++;

        if (self.forced == null) {
          self.updateState();
        }

        clearTimeout(timeout);
        timeout = undefined;
      };
    };

    timeout = setTimeout(increment("timeouts"), this.timeoutDuration);

    command(increment("successes"), increment("failures"));
  }

  private executeFallback(fallback: () => void) {
    fallback();

    const bucket = this.lastBucket();
    bucket.shortCircuits++;
  }

  private calculateMetrics() {
    let totalCount = 0;
    let errorCount = 0;

    for (const bucket of this.buckets) {
      const errors = bucket.failures + bucket.timeouts;

      errorCount += errors;
      totalCount += errors + bucket.successes;
    }

    const errorPercentage =
      (errorCount / (totalCount > 0 ? totalCount : 1)) * 100;

    return {
      totalCount,
      errorCount,
      errorPercentage
    };
  }

  private updateState() {
    const metrics = this.calculateMetrics();

    if (this.state == State.HALF_OPEN) {
      const lastCommandFailed =
        !this.lastBucket().successes && metrics.errorCount > 0;

      if (lastCommandFailed) {
        this.state = State.OPEN;
      } else {
        this.state = State.CLOSED;
        this.onCircuitClose(metrics);
      }
    } else {
      const overErrorThreshold = metrics.errorPercentage > this.errorThreshold;
      const overVolumeThreshold = metrics.totalCount > this.volumeThreshold;
      const overThreshold = overVolumeThreshold && overErrorThreshold;

      if (overThreshold) {
        this.state = State.OPEN;
        this.onCircuitOpen(metrics);
      }
    }
  }
}
