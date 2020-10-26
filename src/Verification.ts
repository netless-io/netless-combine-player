import { VideoOptions } from "./Types";
import { INSTANCE_PARAMS_MISS_URL } from "./ErrorConstant";

export const verifyInstanceParams = (options: VideoOptions): void => {
    if (!options.url) {
        throw Error(INSTANCE_PARAMS_MISS_URL);
    }
};
