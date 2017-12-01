import { ServiceClientRequestOptions, ServiceClientResponse, request } from './request'
import * as url from 'url'

// There are not good d.ts files available. Just using vanilla require here is less confusing  to tsc.
const retry = require('retry')
const CircuitBreaker = require('circuit-breaker-js')

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
  request?: (requestOptions: ServiceClientRequestOptions) => Promise<ServiceClientResponse | ServiceClientRequestOptions>
  /**
   * This callback is called after the response has arrived.
   * @throws {Error}
   */
  response?: (response: ServiceClientResponse) => Promise<ServiceClientResponse>
}

/**
 * This interface describes all the options that may be passed to the service client at construction time.
 */
export class ServiceClientOptions {
  /**
   * This is the only mandatory option when creating a service client. All other properties have
   * reasonable defaults.
   */
  hostname: string
  /**
   * If this property is not provided, the {@link ServiceClient.DEFAULT_FILTERS} will be used.
   */
  filters?: ServiceClientRequestFilter[]
  /**
   * should the service client record request timings?
   */
  timing?: boolean
  retryOptions?: {
    retries?: number
    factor?: number
    minTimeout?: number
    maxTimeout?: number
    randomize?: boolean
    shouldRetry?: (err?: Error, req?: ServiceClientRequestOptions) => boolean
    onRetry?: (currentAttempt?: number, err?: Error, req?: ServiceClientRequestOptions) => void
  }
  circuitBreaker?: (false | {
    windowDuration?: number,
    numBuckets?: number,
    timeoutDuration?: number,
    errorThreshold?: number,
    volumeThreshold?: number
  })
  defaultRequestOptions?: ServiceClientRequestOptions
}

/**
 * Internal only, this interface guarantees, that the service client has all options available at runtime.
 */
class ServiceClientStrictOptions {
  hostname: string
  filters: ServiceClientRequestFilter[]
  timing: boolean
  retryOptions: {
    retries: number
    factor: number
    minTimeout: number
    maxTimeout: number
    randomize: boolean
    shouldRetry: (err?: Error, req?: ServiceClientRequestOptions) => boolean
    onRetry: (currentAttempt?: number, err?: Error, req?: ServiceClientRequestOptions) => void
  }
  defaultRequestOptions: ServiceClientRequestOptions

  constructor(options: ServiceClientOptions){
    if (!options.hostname) {
      throw new Error('Please provide a `hostname` for this client')
    }

    this.hostname = options.hostname
    this.filters = Array.isArray(options.filters) ? options.filters : [...ServiceClient.DEFAULT_FILTERS]
    this.timing = Boolean(options.timing)
    this.retryOptions = Object.assign({
      retries: 0,
      factor: 2,
      minTimeout: 200,
      maxTimeout: 400,
      randomize: true,
      shouldRetry () {
        return true
      },
      onRetry () {}
    }, options.retryOptions)

    if ((this.retryOptions.minTimeout || 0) > (this.retryOptions.maxTimeout || 0)) {
      throw new TypeError('The `maxTimeout` must be equal to or greater than the `minTimeout`')
    }

    this.defaultRequestOptions = Object.assign({
      protocol: 'https:',
      pathname: '/',
      timeout: 2000
    }, options.defaultRequestOptions)
  }
}

/**
 * A custom error returned in case something goes wrong.
 */
export class ServiceClientError extends Error {
  constructor (originalError: Error, public type: string, public response?: ServiceClientResponse) {
    super(`${type}. ${originalError.message || ''}`)
    Object.assign(this, originalError)
  }
}

/**
 * This function takes a response and if it is of type json, tries to parse the body.
 */
const decodeResponse = (response: ServiceClientResponse): ServiceClientResponse => {
  const contentType = response.headers['content-type'] || (response.body ? 'application/json' : '')
  if (contentType.startsWith('application/json') && typeof response.body !== 'object') {
    try {
      response.body = JSON.parse(response.body)
    } catch (error) {
      throw new ServiceClientError(
        error, ServiceClient.BODY_PARSE_FAILED, response
      )
    }
  }
  return response;
}

/**
 * Wrapper that makes sure that all error coming out
 * of ServiceClients are actual ServiceClientError
 */
const wrapFailedError = (type: string, error: Error | ServiceClientError, responseThunk?: () => any) => {
  const serviceClientError = (error instanceof ServiceClientError) ? error : new ServiceClientError(error, type)
  if (!serviceClientError.response && responseThunk) {
    serviceClientError.response = responseThunk()
  }
  return Promise.reject(serviceClientError)
}

/**
 * Reducer function to unwind response filters.
 */
const unwindResponseFilters = (promise: Promise<ServiceClientResponse>, filter: ServiceClientRequestFilter): Promise<ServiceClientResponse> => {
  return promise.then(params => filter.response ? filter.response(params) : params)
}

/**
 * Actually performs the request and applies the available filters in their respective phases.
 */
const requestWithFilters = (params: ServiceClientRequestOptions, filters: ServiceClientRequestFilter[]): Promise<ServiceClientResponse> => {
  const pendingResponseFilters: ServiceClientRequestFilter[] = []

  const requestFilterPromise = filters.reduce((promise: Promise<ServiceClientResponse | ServiceClientRequestOptions>, filter) => {
    return promise.then(params => {
      if (params instanceof ServiceClientResponse) {
        return params
      }
      const filtered = filter.request ? filter.request(params) : params
      // also apply this filter when unwinding the chain
      pendingResponseFilters.unshift(filter)
      return filtered
    })
  }, Promise.resolve(params))

  let response: ServiceClientResponse | null = null
  const responseThunk = () => response

  return requestFilterPromise
    .catch((err: Error) => wrapFailedError(ServiceClient.REQUEST_FILTER_FAILED, err))
    .then((paramsOrResponse) =>
      (paramsOrResponse instanceof ServiceClientResponse) ? paramsOrResponse : request(paramsOrResponse)
    )
    .then(
      (rawResponse) => {
        response = rawResponse
        return decodeResponse(rawResponse)
      },
      (err) => wrapFailedError(ServiceClient.REQUEST_FAILED, err, responseThunk)
    )
    .then(resp => pendingResponseFilters.reduce(unwindResponseFilters, Promise.resolve(resp)))
    .catch((err) => wrapFailedError(ServiceClient.RESPONSE_FILTER_FAILED, err, responseThunk))
}

class ServiceClient {

  private breaker: any
  private options: ServiceClientStrictOptions

  /**
   * A ServiceClient can be constructed with all defaults by simply providing a URL, that can be parsed
   * by nodes url parser. Alternatively, provide actual ServiceClientOptions, that implement the
   * @{link ServiceClientOptions} interface.
   */
  constructor (optionsOrUrl: ServiceClientOptions | string) {
    let options: ServiceClientOptions
    if (typeof optionsOrUrl === 'string') {
      const parsed = url.parse(optionsOrUrl, true)
      // pathname will be overwritten in actual usage, we just guarantee a sane default
      const defaultRequestOptions: ServiceClientRequestOptions = {pathname: '/'}
      const keys: ('port' | 'protocol' | 'query' | 'pathname')[] = ['port', 'protocol', 'query', 'pathname']
      keys.forEach((option) => {
        if (parsed.hasOwnProperty(option)) {
          defaultRequestOptions[option] = parsed[option]
        }
      })
      options = {
        hostname: parsed.hostname || '',
        defaultRequestOptions
      }
    } else {
      options = optionsOrUrl
    }

    if (options.circuitBreaker) {
      const breakerOptions = Object.assign({
        windowDuration: 10000,
        numBuckets: 10,
        timeoutDuration: 2000,
        errorThreshold: 50,
        volumeThreshold: 10
      }, options.circuitBreaker)
      this.breaker = new CircuitBreaker(breakerOptions)
    } else {
      const noop = () => {}
      this.breaker = {run (command: Function) { command(noop, noop) }}
    }

    this.options = new ServiceClientStrictOptions(options)
  }

  /**
   * Perform a request to the service using given @{link ServiceClientRequestOptions}, returning the result in a promise.
   */
  request (userParams: ServiceClientRequestOptions): Promise<ServiceClientResponse> {
    const params = Object.assign({}, this.options.defaultRequestOptions, userParams)

    params.hostname = this.options.hostname
    params.port = params.port || (params.protocol === 'https:' ? 443 : 80)

    params.headers = Object.assign({
      accept: 'application/json'
    }, params.headers)

    const {
      retries,
      factor,
      minTimeout,
      maxTimeout,
      randomize,
      shouldRetry,
      onRetry
    } = this.options.retryOptions

    const opts = {
      retries,
      factor,
      minTimeout,
      maxTimeout,
      randomize
    }

    const operation = retry.operation(opts)

    return new Promise<ServiceClientResponse>((resolve, reject) => operation.attempt((currentAttempt: number) => {
      this.breaker.run((success: () => void, failure: () => void) => {
          return requestWithFilters(params, this.options.filters || [])
            .then((result: ServiceClientResponse) => {
              success()
              resolve(result)
            })
            .catch((error: Error) => {
              failure()
              if (!shouldRetry(error, params)) {
                reject(error)
                return
              }
              if (!operation.retry(error)) {
                reject(error)
                return
              }
              onRetry(currentAttempt + 1, error, params)
            })
        },
        () => {
          reject(new ServiceClientError(new Error(), ServiceClient.CIRCUIT_OPEN))
        })
    }))
  }

  /**
   * This filter will mark 5xx responses as failures. This is relevant for the circuit breaker.
   */
  static treat5xxAsError: ServiceClientRequestFilter = {
    response (response: ServiceClientResponse) {
      if (response.statusCode >= 500) {
        return Promise.reject(new Error(`Response status ${response.statusCode}`))
      }
      return Promise.resolve(response)
    }
  }

  /**
   * This filter will mark 4xx responses as failures. This is relevant for the circuit breaker.
   *
   * This is not the default behaviour!
   */
  static treat4xxAsError: ServiceClientRequestFilter = {
    response (response: ServiceClientResponse) {
      if (response.statusCode >= 400 && response.statusCode < 500) {
        return Promise.reject(new Error(`Response status ${response.statusCode}`))
      }
      return Promise.resolve(response)
    }
  }

  static BODY_PARSE_FAILED = 'Parsing of the response body failed'
  static REQUEST_FAILED = 'HTTP Request failed'
  static REQUEST_FILTER_FAILED = 'Request filter marked request as failed'
  static RESPONSE_FILTER_FAILED = 'Response filter marked request as failed'
  static CIRCUIT_OPEN = 'Circuit breaker is open and prevented the request'

  /**
   * Default list of post-filters which includes
   * `ServiceClient.treat5xxAsError`
   */
  static DEFAULT_FILTERS: ReadonlyArray<ServiceClientRequestFilter> = Object.freeze([ServiceClient.treat5xxAsError])

  /**
   * Interface that the response will implement.
   * Deprecated: Use ServiceClientResponse instead.
   * @see ServiceClientResponse
   * @deprecated
   */
  static Response = ServiceClientResponse

  /**
   * Interface, that errors will implement.
   * Deprecated: Use ServiceClientError instead.
   * @see ServiceClientError
   * @deprecated
   */
  static Error = ServiceClientError
}

export {ServiceClientResponse, ServiceClientRequestOptions} from './request'

module.exports = Object.freeze(ServiceClient)

