'use strict';

const request = require('./request');
const url = require('url');
const CircuitBreaker = require('circuit-breaker-js');
const retry = require('retry');

/**
 * @typedef {Object.<string, (string|Array.<string>)>} ServiceClientHeaders
 */

/**
 * @typedef {{
 *   request?: ServiceClient~requestFilter,
 *   response?: ServiceClient~responseFilter
 * }} ServiceClientFilter
 */

/**
 * @typedef {{
 *  name?: string,
 *  protocol?: string,
 *  service: string,
 *  filters?: Array.<ServiceClient~requestFilter>,
 *  timing?: boolean,
 *  retryOptions?: {
 *      retries?: number,
 *      factor?: number,
 *      minTimeout?: number,
 *      maxTimeout?: number,
 *      randomize?: boolean,
 *      shouldRetry?: Function,
 *      onRetry?: Function
 *  },
 *  circuitBreaker?: (false|{
 *      windowDuration?: number,
 *      numBuckets?: number,
 *      timeoutDuration?: number,
 *      errorThreshold?: number,
 *      volumeThreshold?: number })
 *  defaultRequestOptions?: ServiceClientRequestParams
 * }} ServiceClientOptions
 */

/**
 * @typedef {{
 *  headers?: ServiceClientHeaders,
 *  method?: string,
 *  protocol?: string,
 *  port?: number,
 *  path?: string,
 *  body?: string
 *  timeout?: number,
 *  dropRequestAfter?: number,
 * }} ServiceClientRequestParams
 */

/**
 * @typedef {{
 *  headers: ServiceClientHeaders,
 *  method: string,
 *  statusCode: number,
 *  body: any,
 *  request: ?ServiceClientRequestParams
 * }} ServiceClientResponse
 */

/**
 * This callback is called after the requests has arrived
 * @callback ServiceClient~responseFilter
 * @param {ServiceClientResponse} response
 * @throws {Error}
 * @returns {ServiceClientResponse}
 */

/**
 * This callback is called before the requests is done.
 * You can short-circuit the request by both returning
 * a ServiceClient.Response object which is helpful for
 * implementing caching or mocking. You could also
 * can fail the request by throwing an Error.
 * @callback ServiceClient~requestFilter
 * @param {ServiceClientRequestParams} request
 * @throws {Error}
 * @returns {ServiceClientRequestParams|ServiceClientResponse}
 */

/**
 *
 * @param {{ headers: ServiceClientHeaders, statusCode: number, body: string, request: ServiceClientRequestParams }} response
 * @param {string} serviceClientName
 * @throws {ServiceClient.Error}
 * @returns {ServiceClient.Response}
 */
const decodeResponse = (response, serviceClientName) => {
    const contentType = response.headers['content-type'] || (response.body ? 'application/json' : '');
    if (contentType.startsWith('application/json') && typeof response.body !== 'object') {
        try {
            response.body = JSON.parse(response.body);
        } catch (error) {
            throw new ServiceClient.Error(
                serviceClientName, error, ServiceClient.BODY_PARSE_FAILED, response
            );
        }
    }
    const clientResponse = new ServiceClient.Response(
        response.statusCode,
        response.headers,
        response.body,
        response.request
    );
    clientResponse.timings = response.timings;
    clientResponse.timingPhases = response.timingPhases;
    return clientResponse;
};

/**
 * Wrapper that makes sure that all error coming out
 * of ServiceClients are of the correct type.
 * @function ServiceClient~errorWrapper
 * @param {string} type
 * @param {Error} error
 * @param {function=} responseThunk
 * @returns {Promise<Error>}
 */

/**
 * Builder for a ServiceClient~errorWrapper
 * @param {string} serviceClientName
 * @returns {ServiceClient~errorWrapper}
 */
const wrapFailedErrorBuilder = (serviceClientName) => (type, error, responseThunk) => {
    error = error instanceof ServiceClient.Error ?
        error :
        new ServiceClient.Error(serviceClientName, error, type);
    if (!error.response && responseThunk) {
        error.response = responseThunk();
    }
    return Promise.reject(error);
};

/**
 * Reducer function to unwind response filters.
 * @param {Promise.<ServiceClientResponse>} promise the promised folded upon
 * @param {ServiceClientFilter} filter the current filter in the reduce step
 * @returns {Promise.<ServiceClientResponse>}
 */
const unwindResponseFilters = (promise, filter) => {
    return promise.then(params => filter.response ? filter.response(params) : params);
};

/**
 * @param {ServiceClientRequestParams} params
 * @param {Array.<ServiceClientFilter>} filters
 * @param {string} serviceClientName
 * @returns {Promise.<ServiceClientResponse>}
 */
const requestWithFilters = (params, filters, serviceClientName) => {
    const pendingResponseFilters = [];
    const wrapFailedError = wrapFailedErrorBuilder(serviceClientName);

    const requestFilterPromise = filters.reduce((promise, filter) => {
        return promise.then(params => {
            if (params instanceof ServiceClient.Response) {
                return params;
            }
            const filtered = filter.request ? filter.request(params) : params;
            // also apply this filter when unwinding the chain
            pendingResponseFilters.unshift(filter);
            return filtered;
        });
    }, Promise.resolve(params));

    let response = null;
    let responseThunk = () => response;

    return requestFilterPromise
        .catch((err) => wrapFailedError(ServiceClient.REQUEST_FILTER_FAILED, err))
        .then((paramsOrResponse) =>
            (paramsOrResponse instanceof ServiceClient.Response) ? paramsOrResponse : request(paramsOrResponse)
        )
        .then(
            (rawResponse) => {
                response = rawResponse;
                return decodeResponse(rawResponse, serviceClientName);
            },
            (err) => wrapFailedError(ServiceClient.REQUEST_FAILED, err, responseThunk)
        )
        .then(resp => pendingResponseFilters.reduce(unwindResponseFilters, Promise.resolve(resp)))
        .catch((err) => wrapFailedError(ServiceClient.RESPONSE_FILTER_FAILED, err, responseThunk));
};

const DEFAULT_REQUEST_TIMEOUT = 2000;

/** @typedef string URL */

/**
 * @constructor
 * @property {CircuitBreaker} breaker
 * @property {ServiceClientOptions} options
 */
class ServiceClient {

    /**
     * @param {ServiceClientOptions|URL} optionsOrUrl
     */
    constructor(optionsOrUrl) {
        let options;
        if (typeof optionsOrUrl === 'string') {
            const parsed = url.parse(optionsOrUrl, true);
            const defaultRequestOptions = {};
            ['port', 'protocol', 'query', 'pathname'].forEach((option) => {
                if (parsed.hasOwnProperty(option)) {
                    defaultRequestOptions[option] = parsed[option];
                }
            });
            options = {
                hostname: parsed.hostname,
                defaultRequestOptions
            };
        } else {
            options = optionsOrUrl;
        }

        this.options = Object.assign({
            filters: ServiceClient.DEFAULT_FILTERS,
            circuitBreaker: {},
            name: options.hostname
        }, options);

        if (!this.options.hostname) {
            throw new Error('Please provide a `hostname` for this client');
        }

        this.options.defaultRequestOptions = Object.assign({
            protocol: 'https:',
            pathname: '/',
            timeout: DEFAULT_REQUEST_TIMEOUT
        }, this.options.defaultRequestOptions);

        this.options.retryOptions = Object.assign({
            retries: 0,
            factor: 2,
            minTimeout: 200,
            maxTimeout: 400,
            randomize: true,
            // eslint-disable-next-line
            shouldRetry(err, req) {
                return true;
            },
            // eslint-disable-next-line
            onRetry(currentAttempt, err, req) {}
        }, this.options.retryOptions);

        if (this.options.retryOptions.minTimeout > this.options.retryOptions.maxTimeout) {
            throw new Error('The `maxTimeout` must be equal to or greater than the `minTimeout`');
        }

        if (this.options.circuitBreaker) {
            const breakerOptions = Object.assign({
                windowDuration: 10000,
                numBuckets: 10,
                timeoutDuration: DEFAULT_REQUEST_TIMEOUT,
                errorThreshold: 50,
                volumeThreshold: 10
            }, this.options.circuitBreaker);
            this.breaker = new CircuitBreaker(breakerOptions);
        } else {
            const noop = () => {};
            this.breaker = { run(command) { command(noop, noop); } };
        }
    }

    /**
     * Perform a request to the service using given `params`.
     * @param {ServiceClientRequestParams=} userParams
     * @returns {Promise.<ServiceClientResponse>}
     */
    request(userParams) {
        const params = Object.assign({}, this.options.defaultRequestOptions, userParams);

        params.hostname = this.options.hostname;
        params.port = params.port || (params.protocol === 'https:' ? 443 : 80);

        params.headers = Object.assign({
            accept: 'application/json'
        }, params.headers);

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

        return new Promise((resolve, reject) => operation.attempt((currentAttempt) => {
            this.breaker.run((success, failure) => {
                return requestWithFilters(params, this.options.filters, this.options.name)
                    .then(result => {
                        success();
                        resolve(result);
                    })
                    .catch(error => {
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
                reject(new ServiceClient.Error(this.options.name, {}, ServiceClient.CIRCUIT_OPEN));
            });
        }));
    }
}

/**
 * @type {ServiceClientFilter}
 */
ServiceClient.treat5xxAsError = {
    response(response) {
        if (response.statusCode >= 500) {
            return Promise.reject(new Error(`Response status ${response.statusCode}`));
        }
        return response;
    }
};

/**
 * @type {ServiceClientFilter}
 */
ServiceClient.treat4xxAsError = {
    response(response) {
        if (response.statusCode >= 400 && response.statusCode < 500) {
            return Promise.reject(new Error(`Response status ${response.statusCode}`));
        }
        return response;
    }
};

ServiceClient.BODY_PARSE_FAILED = 'Parsing of the response body failed';
ServiceClient.REQUEST_FAILED = 'HTTP Request failed';
ServiceClient.REQUEST_FILTER_FAILED = 'Request filter marked request as failed';
ServiceClient.RESPONSE_FILTER_FAILED = 'Response filter marked request as failed';
ServiceClient.CIRCUIT_OPEN = 'Circuit breaker is open and prevented the request';

/**
 * Default list of post-filters which includes
 * `ServiceClient.treat5xxAsError`
 * @type {Array.<ServiceClientFilter>}
 */
ServiceClient.DEFAULT_FILTERS = Object.freeze([ServiceClient.treat5xxAsError]);

ServiceClient.Response = class ServiceClientResponse {
    // eslint-disable-next-line max-params
    constructor(statusCode, headers, body, request) {
        this.statusCode = statusCode;
        this.headers = headers;
        this.body = body;
        this.request = request;
    }
};

ServiceClient.Error = class ServiceClientError extends Error {
    // eslint-disable-next-line max-params
    constructor(name, originalError, type, response) {
        super(`${name}: ${type}. ${originalError.message || ''}`);
        Object.assign(this, originalError);
        this.type = type;
        this.response = response;
    }
};

module.exports = Object.freeze(ServiceClient);

