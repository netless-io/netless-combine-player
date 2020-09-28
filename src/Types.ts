import { VideoJsPlayerOptions } from "video.js";
import { CombineStatus, Status } from './StatusContant';

export interface VideoOptions extends DefaultOptions {
    url: string;
    videoJsOptions?: VideoJsPlayerOptions;
}

export interface DefaultOptions {
    videoDOM?: HTMLVideoElement;
    videoJsOptions?: VideoJsPlayerOptions;
}

export type Mixing = {
    whiteboarderStatus: Status;
    videoStatus: Status;
};
export type OnEventCallback = (last: Mixing, current: Mixing, done: () => void) => any;

export type EventList = {
    -readonly [key in CombineStatus]: {
        handler: OnEventCallback;
        once: boolean;
    };
};

export type EmptyCallback = () => void;

export type AnyFunction = (...args: any[]) => any;

export type PublicCombinedStatus =
    | CombineStatus.PauseSeeking
    | CombineStatus.PlayingSeeking
    | CombineStatus.Pause
    | CombineStatus.PauseBuffering
    | CombineStatus.PlayingBuffering
    | CombineStatus.Playing
    | CombineStatus.Ended
    | CombineStatus.Disabled;

export type LockStatus = {
    status: boolean;
    allowStatusList: CombineStatus[];
    unLockStatusList: CombineStatus[];
}

export type TriggerSource = "none" | "video" | "whiteboarder" | "manual";