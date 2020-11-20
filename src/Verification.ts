import { VideoOptions } from "./Types";
import {
    CANNOT_FIND_VIDEO_ELEMENT_ID,
    INSTANCE_PARAMS_MISS_URL,
    MULTIPLE_VIDEO_SELECTOR,
    VIDEO_DOM_NOT_VIDEO_ELEMENT,
    VIDEO_ELEMENT_ID_NOT_VIDEO_ELEMENT,
} from "./ErrorConstant";

export const verifyInstanceParams = (options: VideoOptions): void => {
    if (!options.url) {
        throw Error(INSTANCE_PARAMS_MISS_URL);
    }

    if (typeof options.videoElementID !== "undefined") {
        const videoDOM = document.getElementById(options.videoElementID);
        if (videoDOM === null) {
            throw new Error(CANNOT_FIND_VIDEO_ELEMENT_ID);
        }

        if (videoDOM.tagName.toLowerCase() !== "video") {
            throw new Error(VIDEO_ELEMENT_ID_NOT_VIDEO_ELEMENT);
        }
    }

    if (options.videoElementID && options.videoDOM) {
        throw new Error(MULTIPLE_VIDEO_SELECTOR);
    }

    if (typeof options.videoDOM !== "undefined") {
        if (options.videoDOM.tagName.toLowerCase() !== "video") {
            throw new Error(VIDEO_DOM_NOT_VIDEO_ELEMENT);
        }
    }
};
