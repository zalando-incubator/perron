import {
  CircuitBreaker,
  CircuitBreakerOptions,
  Metrics as CircuitBreakerMetrics,
  CircuitBreakerPublicApi
} from "./circuit-breaker";
import { operation } from "./retry";
import * as url from "url";
import {
  ConnectionTimeoutError,
  NetworkError,
  ReadTimeoutError,
  request,
  RequestError,
  ServiceClientRequestOptions,
  ServiceClientResponse,
  TimingPhases,
  Timings,
  UserTimeoutError,
  BodyStreamError
} from "./request";

import Piscina from "piscina";
import path from "path";
export {
  CircuitBreaker,
  CircuitBreakerOptions,
  CircuitBreakerMetrics,
  CircuitBreakerPublicApi,
  ServiceClientResponse,
  ServiceClientRequestOptions
};

/**
 * This interface defines factory function for getting a circuit breaker
 */
export type CircuitBreakerFactory = (
  params: ServiceClientRequestOptions
) => CircuitBreaker;

/**
 * A request filter may introduce one or both functions in this interface. For more information
 * regarding request filters, refer to the readme of this project.
 */
export interface ServiceClientRequestFilter {
  /**
   * This callback is called before the requests is done.
   * You can short-circuit the request by both returning
   * a ServiceClient.Response object which is helpful for
   * implementing caching or mocking. You could also
   * fail the request by throwing an Error.
   * @throws {Error}
   */
  request?: (
    requestOptions: ServiceClientRequestOptions
  ) =>
    | ServiceClientResponse
    | ServiceClientRequestOptions
    | Promise<ServiceClientResponse | ServiceClientRequestOptions>;
  /**
   * This callback is called after the response has arrived.
   * @throws {Error}
   */
  response?: (
    response: ServiceClientResponse
  ) => ServiceClientResponse | Promise<ServiceClientResponse>;
}

/**
 * This interface describes all the options that may be passed to the service client at construction time.
 */
export class ServiceClientOptions {
  /**
   * This is the only mandatory option when creating a service client. All other properties have
   * reasonable defaults.
   */
  public hostname = "";
  /**
   * Name of the client. Primarily used in errors. Defaults to hostname.
   */
  public name?: string;
  /**
   * If this property is not provided, the {@link ServiceClient.DEFAULT_FILTERS} will be used.
   */
  public filters?: ServiceClientRequestFilter[];
  /**
   * should the service client record request timings?
   */
  public timing?: boolean;
  public autoParseJson?: boolean;
  public retryOptions?: {
    retries?: number;
    factor?: number;
    minTimeout?: number;
    maxTimeout?: number;
    randomize?: boolean;
    shouldRetry?: (err?: Error, req?: ServiceClientRequestOptions) => boolean;
    onRetry?: (
      currentAttempt?: number,
      err?: Error,
      req?: ServiceClientRequestOptions
    ) => void;
  };
  public circuitBreaker?: false | CircuitBreakerOptions | CircuitBreakerFactory;
  public defaultRequestOptions?: Partial<ServiceClientRequestOptions>;
}

/**
 * Internal only, this interface guarantees, that the service client has all options available at runtime.
 */
class ServiceClientStrictOptions {
  public hostname: string;
  public filters: ServiceClientRequestFilter[];
  public timing: boolean;
  public autoParseJson: boolean;
  public retryOptions: {
    retries: number;
    factor: number;
    minTimeout: number;
    maxTimeout: number;
    randomize: boolean;
    shouldRetry: (err?: Error, req?: ServiceClientRequestOptions) => boolean;
    onRetry: (
      currentAttempt?: number,
      err?: Error,
      req?: ServiceClientRequestOptions
    ) => void;
  };
  public defaultRequestOptions: ServiceClientRequestOptions;

  constructor(options: ServiceClientOptions) {
    if (!options.hostname) {
      throw new Error("Please provide a `hostname` for this client");
    }

    this.hostname = options.hostname;
    this.filters = Array.isArray(options.filters)
      ? options.filters
      : [...ServiceClient.DEFAULT_FILTERS];
    this.timing = Boolean(options.timing);
    const autoParseJson = options.autoParseJson;
    this.autoParseJson = autoParseJson === undefined ? true : autoParseJson;
    this.retryOptions = {
      factor: 2,
      maxTimeout: 400,
      minTimeout: 200,
      randomize: true,
      retries: 0,
      shouldRetry() {
        return true;
      },
      onRetry() {
        /* do nothing */
      },
      ...options.retryOptions
    };

    if (
      (this.retryOptions.minTimeout || 0) > (this.retryOptions.maxTimeout || 0)
    ) {
      throw new TypeError(
        "The `maxTimeout` must be equal to or greater than the `minTimeout`"
      );
    }

    this.defaultRequestOptions = {
      pathname: "/",
      protocol: "https:",
      timeout: 2000,
      ...options.defaultRequestOptions
    };
  }
}

/**
 * A custom error returned in case something goes wrong.
 */
export abstract class ServiceClientError extends Error {
  public timings?: Timings;
  public timingPhases?: TimingPhases;
  public retryErrors: ServiceClientError[];
  /**
   * Use `instanceof` checks instead.
   * @deprecated since 0.9.0
   */
  public type: string;

  protected constructor(
    originalError: Error,
    type: string,
    public response?: ServiceClientResponse,
    name = "ServiceClient"
  ) {
    super(`${name}: ${type}. ${originalError.message || ""}`);
    this.type = type;
    this.retryErrors = [];
    // Does not copy `message` from the original error
    Object.assign(this, originalError);
    const timingSource: {
      timings?: Timings;
      timingPhases?: TimingPhases;
      // This is necessary to shut up TypeScript as otherwise it treats
      // types with all optional properties differently
      // eslint-disable-next-line @typescript-eslint/ban-types
      constructor: Function;
    } = response || originalError;
    this.timings = timingSource.timings;
    this.timingPhases = timingSource.timingPhases;
  }
}

export class CircuitOpenError extends ServiceClientError {
  constructor(originalError: Error, name: string) {
    super(originalError, ServiceClient.CIRCUIT_OPEN, undefined, name);
  }
}

export class BodyParseError extends ServiceClientError {
  constructor(
    originalError: Error,
    public response: ServiceClientResponse,
    name: string
  ) {
    super(originalError, ServiceClient.BODY_PARSE_FAILED, response, name);
  }
}

export class RequestFilterError extends ServiceClientError {
  constructor(originalError: Error, name: string) {
    super(originalError, ServiceClient.REQUEST_FILTER_FAILED, undefined, name);
  }
}

export class ResponseFilterError extends ServiceClientError {
  constructor(
    originalError: Error,
    public response: ServiceClientResponse,
    name: string
  ) {
    super(originalError, ServiceClient.RESPONSE_FILTER_FAILED, response, name);
  }
}

export class RequestNetworkError extends ServiceClientError {
  public requestOptions: ServiceClientRequestOptions;

  constructor(originalError: RequestError, name: string) {
    super(originalError, ServiceClient.REQUEST_FAILED, undefined, name);
    this.requestOptions = originalError.requestOptions;
  }
}

export class RequestConnectionTimeoutError extends ServiceClientError {
  public requestOptions: ServiceClientRequestOptions;

  constructor(originalError: RequestError, name: string) {
    super(originalError, ServiceClient.REQUEST_FAILED, undefined, name);
    this.requestOptions = originalError.requestOptions;
  }
}

export class RequestReadTimeoutError extends ServiceClientError {
  public requestOptions: ServiceClientRequestOptions;

  constructor(originalError: RequestError, name: string) {
    super(originalError, ServiceClient.REQUEST_FAILED, undefined, name);
    this.requestOptions = originalError.requestOptions;
  }
}

export class RequestUserTimeoutError extends ServiceClientError {
  public requestOptions: ServiceClientRequestOptions;

  constructor(originalError: RequestError, name: string) {
    super(originalError, ServiceClient.REQUEST_FAILED, undefined, name);
    this.requestOptions = originalError.requestOptions;
  }
}

export class RequestBodyStreamError extends ServiceClientError {
  public requestOptions: ServiceClientRequestOptions;

  constructor(originalError: RequestError, name: string) {
    super(originalError, ServiceClient.REQUEST_FAILED, undefined, name);
    this.requestOptions = originalError.requestOptions;
  }
}

export class ShouldRetryRejectedError extends ServiceClientError {
  constructor(originalError: Error, type: string, name: string) {
    super(originalError, type, undefined, name);
  }
}

export class MaximumRetriesReachedError extends ServiceClientError {
  constructor(originalError: Error, type: string, name: string) {
    super(originalError, type, undefined, name);
  }
}

export class InternalError extends ServiceClientError {
  constructor(originalError: Error, name: string) {
    super(originalError, ServiceClient.INTERNAL_ERROR, undefined, name);
  }
}

const JSON_CONTENT_TYPE_REGEX = /application\/(.*?[+])?json/i;

const agentPropKeys: string[] = [
  "keepAliveMsecs",
  "keepAlive",
  "maxSockets",
  "maxFreeSockets",
  "scheduling",
  "maxTotalSockets",
  "totalSocketCount",
  "createSocketCount",
  "createSocketCountLastCheck",
  "createSocketErrorCount"
  // "createSocketErrorCountLastCheck",
  // "closeSocketCount",
  // "closeSocketCountLastCheck",
  // "errorSocketCount",
  // "errorSocketCountLastCheck",
  // "requestCount",
  // "requestCountLastCheck",
  // "timeoutSocketCount",
  // "timeoutSocketCountLastCheck"
];

/**
 * This function takes a response and if it is of type json, tries to parse the body.
 */
const decodeResponse = (
  client: ServiceClient,
  response: ServiceClientResponse
): ServiceClientResponse => {
  const contentType =
    response.headers["content-type"] ||
    (response.body ? "application/json" : "");
  if (
    typeof response.body === "string" &&
    JSON_CONTENT_TYPE_REGEX.test(contentType)
  ) {
    try {
      response.body = JSON.parse(response.body);
    } catch (error) {
      throw new BodyParseError(error as Error, response, client.name);
    }
  }
  return response;
};

/**
 * Reducer function to unwind response filters.
 */
const unwindResponseFilters = (
  promise: Promise<ServiceClientResponse>,
  filter: ServiceClientRequestFilter
): Promise<ServiceClientResponse> => {
  return promise.then(params =>
    filter.response ? filter.response(params) : params
  );
};

/**
 * Actually performs the request and applies the available filters in their respective phases.
 */
const requestWithFilters = (
  client: ServiceClient,
  requestOptions: ServiceClientRequestOptions,
  filters: ServiceClientRequestFilter[],
  autoParseJson: boolean,
  enableWorkers = false
): Promise<ServiceClientResponse> => {
  const pendingResponseFilters: ServiceClientRequestFilter[] = [];

  const requestFilterPromise = filters.reduce(
    (
      promise: Promise<ServiceClientResponse | ServiceClientRequestOptions>,
      filter
    ) => {
      return promise.then(params => {
        if (params instanceof ServiceClientResponse) {
          return params;
        }
        const filtered = filter.request ? filter.request(params) : params;
        // also apply this filter when unwinding the chain
        pendingResponseFilters.unshift(filter);
        return filtered;
      });
    },
    Promise.resolve(requestOptions)
  );

  let piscina: Piscina | undefined;
  if (enableWorkers) {
    piscina = new Piscina({
      filename: path.resolve(__dirname, "piscina-worker.js")
    });
  }

  return requestFilterPromise
    .catch((error: Error) => {
      throw new RequestFilterError(error, client.name);
    })
    .then(paramsOrResponse => {
      const {
        span,
        agent,
        ...otherOptions
      } = paramsOrResponse as ServiceClientRequestOptions;

      const agentOptions: { [key: string]: any } = {};

      if (agent) {
        for (const key of agentPropKeys) {
          agentOptions[key] = (requestOptions.agent as any)[key];
        }
      }

      return paramsOrResponse instanceof ServiceClientResponse
        ? paramsOrResponse
        : enableWorkers
        ? piscina
            ?.run({
              options: {
                agentOptions,
                ...otherOptions,
                spanCode: span?.log.toString()
              }
            })
            .catch((error: RequestError) => {
              if (error instanceof ConnectionTimeoutError) {
                throw new RequestConnectionTimeoutError(error, client.name);
              } else if (error instanceof UserTimeoutError) {
                throw new RequestUserTimeoutError(error, client.name);
              } else if (error instanceof BodyStreamError) {
                throw new RequestBodyStreamError(error, client.name);
              } else if (error instanceof ReadTimeoutError) {
                throw new RequestReadTimeoutError(error, client.name);
              } else if (error instanceof NetworkError) {
                throw new RequestNetworkError(error, client.name);
              } else {
                throw error;
              }
            })
        : request(paramsOrResponse).catch((error: RequestError) => {
            if (error instanceof ConnectionTimeoutError) {
              throw new RequestConnectionTimeoutError(error, client.name);
            } else if (error instanceof UserTimeoutError) {
              throw new RequestUserTimeoutError(error, client.name);
            } else if (error instanceof BodyStreamError) {
              throw new RequestBodyStreamError(error, client.name);
            } else if (error instanceof ReadTimeoutError) {
              throw new RequestReadTimeoutError(error, client.name);
            } else if (error instanceof NetworkError) {
              throw new RequestNetworkError(error, client.name);
            } else {
              throw error;
            }
          });
    })
    .then(response => {
      if (Array.isArray(response)) {
        const [statusCode, headers, body, timings, timingPhases] = response;
        const scResponse = new ServiceClientResponse(
          statusCode,
          headers,
          body,
          requestOptions
        );
        scResponse.timings = timings;
        scResponse.timingPhases = timingPhases;
        return scResponse;
      }
      return response;
    })
    .then(rawResponse =>
      autoParseJson ? decodeResponse(client, rawResponse) : rawResponse
    )
    .then(resp =>
      pendingResponseFilters
        .reduce(unwindResponseFilters, Promise.resolve(resp))
        .catch(error => {
          throw new ResponseFilterError(error, resp, client.name);
        })
    );
};

const noop = () => {
  /* do nothing */
};
const noopBreaker: CircuitBreakerPublicApi = {
  run(command) {
    command(noop, noop);
  },
  forceClose: () => null,
  forceOpen: () => null,
  unforce: () => null,
  isOpen: () => false
};

const buildStatusCodeFilter = (
  isError: (statusCode: number) => boolean
): ServiceClientRequestFilter => {
  return {
    response(response: ServiceClientResponse) {
      if (isError(response.statusCode)) {
        return Promise.reject(
          new Error(`Response status ${response.statusCode}`)
        );
      }
      return Promise.resolve(response);
    }
  };
};

export class ServiceClient {
  /**
   * This filter will mark 5xx responses as failures. This is relevant for the circuit breaker.
   */
  public static treat5xxAsError: ServiceClientRequestFilter = buildStatusCodeFilter(
    statusCode => statusCode >= 500
  );

  /**
   * This filter will mark 4xx responses as failures. This is relevant for the circuit breaker.
   *
   * This is not the default behaviour!
   */
  public static treat4xxAsError: ServiceClientRequestFilter = buildStatusCodeFilter(
    statusCode => statusCode >= 400 && statusCode < 500
  );

  /**
   * Use `instanceof BodyParseError` check instead
   * @deprecated since 0.9.0
   */
  public static BODY_PARSE_FAILED = "Parsing of the response body failed";

  /**
   * Use `instanceof RequestFailedError` check instead
   * @deprecated since 0.9.0
   */
  public static REQUEST_FAILED = "HTTP Request failed";

  /**
   * Use `instanceof RequestFilterError` check instead
   * @deprecated since 0.9.0
   */
  public static REQUEST_FILTER_FAILED =
    "Request filter marked request as failed";

  /**
   * Use `instanceof ResponseFilterError` check instead
   * @deprecated since 0.9.0
   */
  public static RESPONSE_FILTER_FAILED =
    "Response filter marked request as failed";

  /**
   * Use `instanceof CircuitOpenError` check instead
   * @deprecated since 0.9.0
   */
  public static CIRCUIT_OPEN =
    "Circuit breaker is open and prevented the request";

  /**
   * Use `instanceof CircuitOpenError` check instead
   * @deprecated since 0.9.0
   */
  public static INTERNAL_ERROR =
    "Perron internal error due to a bug or misconfiguration";

  /**
   * Default list of post-filters which includes
   * `ServiceClient.treat5xxAsError`
   */
  public static DEFAULT_FILTERS: ReadonlyArray<
    ServiceClientRequestFilter
  > = Object.freeze([ServiceClient.treat5xxAsError]);

  /**
   * Interface that the response will implement.
   * Deprecated: Use ServiceClientResponse instead.
   * @see ServiceClientResponse
   * @deprecated
   */
  public static Response = ServiceClientResponse;

  /**
   * Interface, that errors will implement.
   * Deprecated: Use ServiceClientError instead.
   * @see ServiceClientError
   * @deprecated
   */
  public static Error = ServiceClientError;
  public name: string;

  private breaker?: CircuitBreaker;
  private breakerFactory?: CircuitBreakerFactory;
  private options: ServiceClientStrictOptions;

  /**
   * A ServiceClient can be constructed with all defaults by simply providing a URL, that can be parsed
   * by nodes url parser. Alternatively, provide actual ServiceClientOptions, that implement the
   * @{link ServiceClientOptions} interface.
   */
  constructor(optionsOrUrl: ServiceClientOptions | string) {
    let options: ServiceClientOptions;
    if (typeof optionsOrUrl === "string") {
      const {
        port,
        protocol,
        query,
        hostname = "",
        pathname = "/"
      } = url.parse(optionsOrUrl, true);
      options = {
        hostname: hostname as any,
        defaultRequestOptions: {
          port,
          protocol,
          query,
          // pathname will be overwritten in actual usage, we just guarantee a sane default
          pathname: pathname as any
        }
      };
    } else {
      options = optionsOrUrl;
    }

    if (typeof options.circuitBreaker === "object") {
      const breakerOptions = {
        windowDuration: 10000,
        numBuckets: 10,
        timeoutDuration: 2000,
        errorThreshold: 50,
        volumeThreshold: 10,
        ...options.circuitBreaker
      };
      this.breaker = new CircuitBreaker(breakerOptions);
    }

    if (typeof options.circuitBreaker === "function") {
      this.breakerFactory = options.circuitBreaker;
    }

    this.options = new ServiceClientStrictOptions(options);
    this.name = options.name || options.hostname;
  }

  /**
   * Return an instance of a CircuitBreaker based on params.
   * Choses between a factory and a single static breaker
   */
  public getCircuitBreaker(
    params: ServiceClientRequestOptions
  ): CircuitBreakerPublicApi {
    if (this.breaker) {
      return this.breaker;
    }

    if (this.breakerFactory) {
      return this.breakerFactory(params);
    }

    return noopBreaker;
  }

  /**
   * Perform a request to the service using given @{link ServiceClientRequestOptions}, returning the result in a promise.
   */
  public request(
    userParams: ServiceClientRequestOptions,
    enableWorkers = false
  ): Promise<ServiceClientResponse> {
    const params = { ...this.options.defaultRequestOptions, ...userParams };

    params.hostname = this.options.hostname;
    params.port = params.port || (params.protocol === "https:" ? 443 : 80);
    params.timing =
      params.timing !== undefined ? params.timing : this.options.timing;

    params.headers = {
      accept: "application/json",
      ...params.headers
    };

    const {
      retries,
      factor,
      minTimeout,
      maxTimeout,
      randomize,
      shouldRetry,
      onRetry
    } = this.options.retryOptions;

    const opts = {
      retries,
      factor,
      minTimeout,
      maxTimeout,
      randomize
    };

    const retryErrors: ServiceClientError[] = [];
    return new Promise<ServiceClientResponse>((resolve, reject) => {
      const breaker = this.getCircuitBreaker(params);
      const retryOperation = operation(opts, (currentAttempt: number) => {
        breaker.run(
          (success: () => void, failure: () => void) => {
            return requestWithFilters(
              this,
              params,
              this.options.filters || [],
              this.options.autoParseJson,
              enableWorkers
            )
              .then((result: ServiceClientResponse) => {
                success();
                result.retryErrors = retryErrors;
                resolve(result);
              })
              .catch((error: ServiceClientError) => {
                retryErrors.push(error);
                failure();
                if (!shouldRetry(error, params)) {
                  reject(
                    new ShouldRetryRejectedError(error, error.type, this.name)
                  );
                  return;
                }
                if (!retryOperation.retry()) {
                  // Wrapping error when user does not want retries would result
                  // in bad developer experience where you always have to unwrap it
                  // knowing there is only one error inside, so we do not do that.
                  if (retries === 0) {
                    reject(error);
                  } else {
                    reject(
                      new MaximumRetriesReachedError(
                        error,
                        error.type,
                        this.name
                      )
                    );
                  }
                  return;
                }
                onRetry(currentAttempt + 1, error, params);
              });
          },
          () => {
            reject(new CircuitOpenError(new Error(), this.name));
          }
        );
      });
      retryOperation.attempt();
    }).catch((error: unknown) => {
      const rawError =
        error instanceof Error ? error : new Error(String(error));
      const wrappedError =
        rawError instanceof ServiceClientError
          ? rawError
          : new InternalError(rawError, this.name);
      wrappedError.retryErrors = retryErrors;
      throw wrappedError;
    });
  }

  public requestWithWorker(
    userParams: ServiceClientRequestOptions
  ): Promise<ServiceClientResponse> {
    return this.request({ ...userParams }, true);
  }
}

Object.freeze(ServiceClient);

export default ServiceClient;
