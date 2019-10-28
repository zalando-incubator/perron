export function operation(
  options: OperationOptions,
  fn: (aggressiveRetry: boolean) => void
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
   * The maximum amount of times to retry the operation.
   * @default 0
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
   * @default 200
   */
  minTimeout: number;
  /**
   * The maximum number of milliseconds between two retries.
   * @default 400
   */
  maxTimeout: number;
  /**
   * Randomizes the timeouts by multiplying a factor between 1-2.
   * @default true
   */
  randomize: boolean;
}

class RetryOperation {
  private readonly _timeouts: number[];
  private readonly _fn: (aggressiveRetry: boolean) => void;
  private _resolved: boolean;
  private _attempts: number;
  constructor(timeouts: number[], fn: (aggressiveRetry: boolean) => void) {
    this._timeouts = timeouts;
    this._fn = fn;
    this._resolved = false;
    this._attempts = 1;
  }

  retry(immediate: boolean = false) {
    if (this._attempts > this._timeouts.length) {
      return false;
    }
    let timeout = immediate ? 0 : this._timeouts[this._attempts - 1];
    setTimeout(() => {
      this._attempts++;
      this._fn(immediate);
    }, timeout);

    return this._attempts;
  }

  attempt() {
    this._fn(false);
  }

  resolved() {
    this._resolved = true;
  }

  isResolved() {
    return this._resolved;
  }
}
