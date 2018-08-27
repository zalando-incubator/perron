import * as CircuitBreaker from "circuit-breaker-js";
import * as retry from "retry";
import * as url from "url";
import {
  ErrorWithTimings,
  request,
  ServiceClientRequestOptions,
  ServiceClientResponse,
  TimingPhases,
  Timings
} from "./request";

export { ServiceClientResponse, ServiceClientRequestOptions };

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
  ) => Promise<ServiceClientResponse | ServiceClientRequestOptions>;
  /**
   * This callback is called after the response has arrived.
   * @throws {Error}
   */
  response?: (
    response: ServiceClientResponse
  ) => Promise<ServiceClientResponse>;
}

/**
 * This interface describes all the options that may be passed to the service client at construction time.
 */
export class ServiceClientOptions {
  /**
   * This is the only mandatory option when creating a service client. All other properties have
   * reasonable defaults.
   */
  public hostname: string = "";
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
  public circuitBreaker?:
    | false
    | CircuitBreaker.Options
    | CircuitBreakerFactory;
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
export class ServiceClientError extends Error {
  public timings?: Timings;
  public timingPhases?: TimingPhases;
  constructor(
    originalError: Error,
    public type: string,
    public response?: ServiceClientResponse,
    name: string = "ServiceClient"
  ) {
    super(`${name}: ${type}. ${originalError.message || ""}`);
    Object.assign(this, originalError);
    if (originalError instanceof ErrorWithTimings) {
      this.timings = originalError.timings;
      this.timingPhases = originalError.timingPhases;
    }
  }
}

const JSON_CONTENT_TYPE_REGEX = /application\/(.*?[+])?json/i;

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
      throw new ServiceClientError(
        error,
        ServiceClient.BODY_PARSE_FAILED,
        response,
        client.name
      );
    }
  }
  return response;
};

/**
 * Wrapper that makes sure that all error coming out
 * of ServiceClients are actual ServiceClientError
 */
const wrapFailedError = (
  client: ServiceClient,
  type: string,
  error: Error | ServiceClientError,
  responseThunk?: () => any
) => {
  const serviceClientError =
    error instanceof ServiceClientError
      ? error
      : new ServiceClientError(error, type, undefined, client.name);
  if (!serviceClientError.response && responseThunk) {
    serviceClientError.response = responseThunk();
  }
  return Promise.reject(serviceClientError);
};

/**
 * Reducer function to unwind response filters.
 */
const unwindResponseFilters = (
  promise: Promise<ServiceClientResponse>,
  filter: ServiceClientRequestFilter
): Promise<ServiceClientResponse> => {
  return promise.then(
    params => (filter.response ? filter.response(params) : params)
  );
};

/**
 * Actually performs the request and applies the available filters in their respective phases.
 */
const requestWithFilters = (
  client: ServiceClient,
  requestOptions: ServiceClientRequestOptions,
  filters: ServiceClientRequestFilter[],
  autoParseJson: boolean
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

  let response: ServiceClientResponse | null = null;
  const responseThunk = () => response;

  return requestFilterPromise
    .catch((err: Error) =>
      wrapFailedError(client, ServiceClient.REQUEST_FILTER_FAILED, err)
    )
    .then(
      paramsOrResponse =>
        paramsOrResponse instanceof ServiceClientResponse
          ? paramsOrResponse
          : request(paramsOrResponse)
    )
    .then(
      rawResponse => {
        response = rawResponse;
        if (autoParseJson) {
          return decodeResponse(client, rawResponse);
        }
        return rawResponse;
      },
      err =>
        wrapFailedError(
          client,
          ServiceClient.REQUEST_FAILED,
          err,
          responseThunk
        )
    )
    .then(resp =>
      pendingResponseFilters.reduce(
        unwindResponseFilters,
        Promise.resolve(resp)
      )
    )
    .catch(err =>
      wrapFailedError(
        client,
        ServiceClient.RESPONSE_FILTER_FAILED,
        err,
        responseThunk
      )
    );
};

const noop = () => {
  /* do nothing */
};
const noopBreaker: CircuitBreaker = {
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
        let error = new Error(`Response status ${response.statusCode}`);
        if (response.timings && response.timingPhases) {
          error = new ErrorWithTimings(
            { name: "", ...error },
            response.timings,
            response.timingPhases
          );
        }
        return Promise.reject(error);
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

  public static BODY_PARSE_FAILED = "Parsing of the response body failed";
  public static REQUEST_FAILED = "HTTP Request failed";
  public static REQUEST_FILTER_FAILED =
    "Request filter marked request as failed";
  public static RESPONSE_FILTER_FAILED =
    "Response filter marked request as failed";
  public static CIRCUIT_OPEN =
    "Circuit breaker is open and prevented the request";

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
      const parsed = url.parse(optionsOrUrl, true);
      // pathname will be overwritten in actual usage, we just guarantee a sane default
      const defaultRequestOptions: ServiceClientRequestOptions = {
        pathname: "/"
      };
      const keys: Array<"port" | "protocol" | "query" | "pathname"> = [
        "port",
        "protocol",
        "query",
        "pathname"
      ];
      keys.forEach(option => {
        if (parsed.hasOwnProperty(option)) {
          defaultRequestOptions[option] = parsed[option];
        }
      });
      options = {
        hostname: parsed.hostname || "",
        defaultRequestOptions
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
  ): CircuitBreaker {
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
    userParams: ServiceClientRequestOptions
  ): Promise<ServiceClientResponse> {
    const params = { ...this.options.defaultRequestOptions, ...userParams };

    params.hostname = this.options.hostname;
    params.port = params.port || (params.protocol === "https:" ? 443 : 80);

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

    const operation = retry.operation(opts);

    const breaker = this.getCircuitBreaker(params);

    return new Promise<ServiceClientResponse>((resolve, reject) =>
      operation.attempt((currentAttempt: number) => {
        breaker.run(
          (success: () => void, failure: () => void) => {
            return requestWithFilters(
              this,
              params,
              this.options.filters || [],
              this.options.autoParseJson
            )
              .then((result: ServiceClientResponse) => {
                success();
                resolve(result);
              })
              .catch((error: Error) => {
                failure();
                if (!shouldRetry(error, params)) {
                  reject(error);
                  return;
                }
                if (!operation.retry(error)) {
                  reject(error);
                  return;
                }
                onRetry(currentAttempt + 1, error, params);
              });
          },
          () => {
            reject(
              new ServiceClientError(
                new Error(),
                ServiceClient.CIRCUIT_OPEN,
                undefined,
                this.name
              )
            );
          }
        );
      })
    );
  }
}
Object.freeze(ServiceClient);

export default ServiceClient;
