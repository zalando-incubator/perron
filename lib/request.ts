import {
  IncomingHttpHeaders,
  IncomingMessage,
  request as httpRequest
} from "http";
import { request as httpsRequest, RequestOptions } from "https";
import * as querystring from "querystring";
import * as zlib from "zlib";
import { ServiceClientError } from "./client";
import { Socket } from "net";

const DEFAULT_READ_TIMEOUT = 2000;
const DEFAULT_CONNECTION_TIMEOUT = 1000;

const getInterval = (time: [number, number]): number => {
  const diff = process.hrtime(time);
  return Math.round(diff[0] * 1000 + diff[1] / 1000000);
};

/**
 * The NodeJS typescript definitions has OutgoingHttpHeaders
 * with `undefined` as one of the possible values, but NodeJS
 * runtime will throw an error for undefined values in headers.
 *
 * This overwrites the headers type in the RequestOptions
 * and removes undefined from one of the possible values of headers.
 */
export interface OutgoingHttpHeaders {
  [header: string]: number | string | string[];
}

export interface ServiceClientRequestOptions extends RequestOptions {
  pathname: string;
  query?: object;
  timing?: boolean;
  /** @deprecated Since 0.10.0 */
  dropRequestAfter?: number;
  body?: any;
  headers?: OutgoingHttpHeaders;
  /**
   * Happens when the socket connection cannot be established
   */
  timeout?: number;
  /**
   * Happens after the socket connection is successfully established
   * and there is no activity on that socket
   */
  readTimeout?: number;
}

export class ServiceClientResponse {
  public timings?: Timings;
  public timingPhases?: TimingPhases;
  public retryErrors: ServiceClientError[];
  constructor(
    public statusCode: number,
    public headers: IncomingHttpHeaders,
    public body: any,
    public request: ServiceClientRequestOptions
  ) {
    this.retryErrors = [];
  }
}

export interface Timings {
  lookup?: number;
  socket?: number;
  connect?: number;
  response?: number;
  end?: number;
}
export interface TimingPhases {
  wait?: number;
  dns?: number;
  tcp?: number;
  firstByte?: number;
  download?: number;
  total?: number;
}

const subtract = (a?: number, b?: number): number | undefined => {
  if (typeof a === "number" && typeof b === "number") {
    return a - b;
  }
  return undefined;
};

export class RequestError extends Error {
  public timings?: Timings;
  public timingPhases?: TimingPhases;
  public requestOptions: ServiceClientRequestOptions;
  constructor(
    message: string,
    requestOptions: ServiceClientRequestOptions,
    timings?: Timings
  ) {
    super(message);
    this.requestOptions = requestOptions;
    this.timings = timings;
    this.timingPhases = timings && makeTimingPhases(timings);
  }
}

export class NetworkError extends RequestError {
  constructor(
    originalError: Error,
    requestOptions: ServiceClientRequestOptions,
    timings?: Timings
  ) {
    super(originalError.message, requestOptions, timings);
    this.stack = originalError.stack;
  }
}

export class ConnectionTimeoutError extends RequestError {
  constructor(requestOptions: ServiceClientRequestOptions, timings?: Timings) {
    super("socket timeout", requestOptions, timings);
  }
}

export class ReadTimeoutError extends RequestError {
  constructor(requestOptions: ServiceClientRequestOptions, timings?: Timings) {
    super("read timeout", requestOptions, timings);
  }
}

export class UserTimeoutError extends RequestError {
  constructor(requestOptions: ServiceClientRequestOptions, timings?: Timings) {
    super("request timeout", requestOptions, timings);
  }
}

const makeTimingPhases = (timings: Timings): TimingPhases => {
  return {
    wait: timings.socket,
    dns: subtract(timings.lookup, timings.socket),
    tcp: subtract(timings.connect, timings.lookup),
    firstByte: subtract(timings.response, timings.connect),
    download: subtract(timings.end, timings.response),
    total: timings.end
  };
};

export const request = (
  options: ServiceClientRequestOptions
): Promise<ServiceClientResponse> => {
  options = {
    protocol: "https:",
    ...options
  };

  if ("pathname" in options && !("path" in options)) {
    if ("query" in options) {
      let query = querystring.stringify(options.query);
      if (query) {
        query = "?" + query;
      }
      options.path = `${options.pathname}${query}`;
    } else {
      options.path = options.pathname;
    }
  }

  const connectionTimeout = options.timeout || DEFAULT_CONNECTION_TIMEOUT;
  const readTimeout = options.readTimeout || DEFAULT_READ_TIMEOUT;

  const httpRequestFn =
    options.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject: (error: RequestError) => void) => {
    let hasRequestEnded = false;
    let startTime: [number, number];
    let timings: Timings;
    if (options.timing) {
      startTime = process.hrtime();
      timings = {
        lookup: undefined,
        socket: undefined,
        connect: undefined,
        response: undefined,
        end: undefined
      };
    }

    const requestObject = httpRequestFn(options);
    requestObject.setTimeout(readTimeout, () => {
      requestObject.socket.destroy();
      reject(new ReadTimeoutError(options));
    });

    requestObject.once("error", err => reject(new NetworkError(err, options)));

    // Fires once the socket is assigned to a request
    requestObject.once("socket", (socket: Socket) => {
      if (options.timing) {
        timings.socket = getInterval(startTime);
      }
      if (socket.connecting) {
        socket.setTimeout(connectionTimeout, () => {
          // socket should be manually cleaned up
          socket.destroy();
          reject(new ConnectionTimeoutError(options));
        });
        if (options.timing) {
          socket.once("lookup", () => {
            timings.lookup = getInterval(startTime);
          });
        }
        // connect event would kick in only for new socket connections
        // and not for connections that are kept alive
        socket.once("connect", () => {
          if (options.timing) {
            timings.connect = getInterval(startTime);
          }
        });
      } else {
        if (options.timing) {
          timings.lookup = timings.socket;
          timings.connect = timings.socket;
        }
      }
    });

    requestObject.on("response", (response: IncomingMessage) => {
      if (options.timing) {
        timings.response = getInterval(startTime);
      }

      const { headers, statusCode } = response;
      let bodyStream;

      const encoding = headers && headers["content-encoding"];
      if (encoding === "gzip" || encoding === "deflate") {
        response.on("error", err => reject(new NetworkError(err, options)));
        bodyStream = response.pipe(zlib.createUnzip());
      } else {
        bodyStream = response;
      }

      let chunks: Buffer[] = [];
      let bufferLength = 0;

      bodyStream.on("error", err => reject(new NetworkError(err, options)));

      bodyStream.on("data", data => {
        bufferLength += data.length;
        chunks.push(data as Buffer);
      });

      bodyStream.on("end", () => {
        hasRequestEnded = true;
        const body = Buffer.concat(chunks, bufferLength).toString("utf8");

        // to avoid leaky behavior
        chunks = [];
        bufferLength = 0;

        const serviceClientResponse = new ServiceClientResponse(
          statusCode || 0,
          headers,
          body,
          options
        );

        if (options.timing) {
          timings.end = getInterval(startTime);
          serviceClientResponse.timings = timings;
          serviceClientResponse.timingPhases = makeTimingPhases(timings);
        }
        resolve(serviceClientResponse);
      });
    });

    if (options.dropRequestAfter) {
      setTimeout(() => {
        if (!hasRequestEnded) {
          requestObject.abort();
          reject(new UserTimeoutError(options, timings));
        }
      }, options.dropRequestAfter);
    }

    if (options.body) {
      requestObject.write(options.body);
    }
    requestObject.end();
  });
};
