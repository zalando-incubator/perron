export function operation(
  options: OperationOptions,
  fn: (currentAttempt: number) => void
) {
  return new RetryOperation(timeouts(options), fn);
}

export function timeouts(options: OperationOptions) {
  if (options.minTimeout > options.maxTimeout) {
    throw new Error("minTimeout is greater than maxTimeout");
  }

  const timeouts: number[] = [];
  for (let i = 0; i < options.retries; i++) {
    timeouts.push(createTimeout(i, options));
  }

  // sort the array numerically ascending
  timeouts.sort(function(a, b) {
    return a - b;
  });

  return timeouts;
}

function createTimeout(
  attempt: number,
  opts: Required<CreateTimeoutOptions>
): number {
  const random = opts.randomize ? Math.random() + 1 : 1;

  let timeout = Math.round(
    random * opts.minTimeout * Math.pow(opts.factor, attempt)
  );
  timeout = Math.min(timeout, opts.maxTimeout);

  return timeout;
}
export interface OperationOptions extends CreateTimeoutOptions {
  /**
   * Whether to [unref](https://nodejs.org/api/timers.html#timers_unref) the setTimeout's.
   * @default false
   */
  unref?: boolean;
  /**
   * The maximum amount of times to retry the operation.
   * @default 10
   */
  retries: number;
}

interface CreateTimeoutOptions {
  /**
   * The exponential factor to use.
   * @default 2
   */
  factor: number;
  /**
   * The number of milliseconds before starting the first retry.
   * @default 1000
   */
  minTimeout: number;
  /**
   * The maximum number of milliseconds between two retries.
   * @default Infinity
   */
  maxTimeout: number;
  /**
   * Randomizes the timeouts by multiplying a factor between 1-2.
   * @default false
   */
  randomize: boolean;
}

class RetryOperation {
  private readonly _timeouts: number[];
  private readonly _fn: (currentAttempt: number) => void;
  private _attempts: number;
  constructor(timeouts: number[], fn: (currentAttempt: number) => void) {
    this._timeouts = timeouts;
    this._fn = fn;
    this._attempts = 1;
  }

  retry() {
    if (this._attempts > this._timeouts.length) {
      return false;
    }
    let timeout = this._timeouts[this._attempts - 1];
    setTimeout(() => {
      this._attempts++;
      this._fn(this._attempts);
    }, timeout);

    return true;
  }

  attempt() {
    this._fn(this._attempts);
  }
}
