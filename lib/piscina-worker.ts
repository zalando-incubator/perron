import { ServiceClientResponse, request } from "./request";

const requestWithWorker = async ({
  options
}: {
  options: any;
}): Promise<Array<any>> => {
  options.span = {
    log: (val: any) => {
      console.log(val);
    }
  };
  let res: ServiceClientResponse;
  try {
    res = await request(options);
  } catch (e) {
    throw e;
  }
  return [res.statusCode, res.headers, res.body];
};

export default requestWithWorker;
