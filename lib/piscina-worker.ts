import path = require("path");
import { ServiceClientRequestOptions, ServiceClientResponse, request } from "./request";

const requestWithWorker = async({
  options
}:{  options: any
}): Promise<Array<any>> => {
    console.log("START_+");
    options.span = { log: (val:any)=>{} };
    console.log("OPTS: ",options);
    let res: ServiceClientResponse;
    try{
      res = await request(options)
    }catch(e){
      console.log("ERR_WORKER: ", e);
      throw e;
    }
    console.log("RES_BODY: ", res.body)
    console.log("RES_STATUS: ", res.statusCode)
    console.log("RES_STATUS: ", res.headers)
    console.log("RES_STATUS: ", res.timings)
    // const k = new ServiceClientResponse(
    //   public statusCode: number,
    //   public headers: IncomingHttpHeaders,
    //   public body: Buffer | string | object,
    //   public request: ServiceClientRequestOptions
    // )
    return [res.statusCode, res.headers, res.body, res.request ];
}

export default requestWithWorker;
