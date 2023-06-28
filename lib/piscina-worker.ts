import {
  ServiceClientRequestOptions,
  ServiceClientResponse,
  request
} from "./request";

const requestWithWorker = async ({
  options
}: {
  options: any;
}): Promise<Array<any>> => {
  let opts = options;
  if (!opts) {
    opts = {} as ServiceClientRequestOptions;
  }
  if (!opts.span)
    opts.span = {
      log: (val: any) => {
        console.log(val);
      }
    };
  // opts.agent = new httpAgent(opts.agentOptions);
  let res: ServiceClientResponse;
  try {
    res = await request(opts);
  } catch (e) {
    throw e;
  }
  return [res.statusCode, res.headers, res.body, res.timings, res.timingPhases];
};

export default requestWithWorker;
