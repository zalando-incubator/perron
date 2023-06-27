import path = require("path");
import { ServiceClientRequestOptions, ServiceClientResponse, request } from "./request";
import { workerData, parentPort, Worker, isMainThread } from "worker_threads";

export const requestWithWorker = (
  options: ServiceClientRequestOptions
): Promise<ServiceClientResponse> => {
  return new Promise((resolve, reject) => {
    let worker: Worker | null = null;
    console.log("BG")
    try {
      const { agent, span, ...otherOptions } = options
      console.log(JSON.stringify(options, null, 2))
      worker = new Worker(path.resolve(__dirname, 'request-worker.js'), {
        workerData: { options: { ...otherOptions, spanCode: span?.log.toString() } }
      })
    } catch (e) {
      console.log("Worker creation failed: ", e);
    }
    console.log("AF");
    if (worker) {
      worker.on("message", array => {
        const [statusCode, headers, body, options] = array;
        console.log("POST_ARRAY: ", array);
        resolve(new ServiceClientResponse(statusCode, headers, body, options));
      });
      worker.on("error", err => {
        console.log("PERRON: ", err);
        reject(err);
      }); worker.on("exit", err => {
        if (process.exitCode != 0) {
          reject(Error(`request-worker crashed - ${err.toString()}`))
        }
      })
    }
  })
}

if (isMainThread) {
  exports.requestWithWorker = requestWithWorker
} else {
  console.log("START_");
  const { options } = workerData;
  options.span = { log: new Function(`return ${options.spanCode}`) }
  console.log("START_+");
  request(options).then((res) => {
    const statusCode = res.statusCode;
    const headers = res.headers;
    const body = res.body;
    try {
      console.log("POST_RES: ", res);
      parentPort?.postMessage([statusCode, headers, body, options]);
    } catch (e) {
      console.log("CLONE ERROR: ", e);
      throw e;
    }
  })
}
