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
  public timeoutDuration: number;
  public errorThreshold: number;
  public volumeThreshold: number;

  public onCircuitOpen: (m: Metrics) => void;
  public onCircuitClose: (m: Metrics) => void;

  private readonly buckets: Bucket[];
  private bucketIndex: number;
  private state: State;
  private forced?: State;

  constructor(options?: CircuitBreakerOptions) {
    options = options || {};

    this.windowDuration = options.windowDuration || 10000;
    this.timeoutDuration = options.timeoutDuration || 3000;
    this.errorThreshold = options.errorThreshold || 50;
    this.volumeThreshold = options.volumeThreshold || 5;

    this.onCircuitOpen = options.onCircuitOpen || noop;
    this.onCircuitClose = options.onCircuitClose || noop;

    this.buckets = [];
    const numberOfBuckets = Math.max(1, options.numBuckets || 10);
    for (let i = 0; i < numberOfBuckets; ++i) {
      this.buckets.push({
        failures: 0,
        successes: 0,
        timeouts: 0,
        shortCircuits: 0
      });
    }
    this.bucketIndex = 0;
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
    const bucketDuration = this.windowDuration / this.buckets.length;

    const tick = () => {
      ++this.bucketIndex;

      // FIXME this is very broken as it means that the time
      //       till CB is changing to half-open state depends on
      //       the index of the bucket at the time when it opened.
      if (this.bucketIndex >= this.buckets.length) {
        this.bucketIndex = 0;

        if (self.isOpen()) {
          self.state = State.HALF_OPEN;
        }
      }

      // Since we are recycling the buckets they need to be
      // reset before the can be used again.
      const bucket = this.lastBucket();
      bucket.failures = 0;
      bucket.successes = 0;
      bucket.timeouts = 0;
      bucket.shortCircuits = 0;
    };

    setInterval(tick, bucketDuration).unref();
  }

  private lastBucket() {
    return this.buckets[this.bucketIndex];
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
