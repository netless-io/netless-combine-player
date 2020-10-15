import { VideoJsPlayerOptions } from "video.js";
import { CombineStatus, Status } from "./StatusContant";

export interface VideoOptions extends DefaultOptions {
    url: string;
    videoJsOptions?: VideoJsPlayerOptions;
}

export interface DefaultOptions {
    videoDOM?: HTMLVideoElement;
    videoJsOptions?: VideoJsPlayerOptions;
}

export type Mixing = {
    whiteboard: Status;
    video: Status;
};
export type OnEventCallback = (previous: Mixing, current: Mixing, done: () => void) => any;

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

export type LockInfo = {
    isLocked: boolean;
    allowStatusList: CombineStatus[];
    unLockStatusList: CombineStatus[];
};

export type StatusData = {
    current: Status;
    previous: Status;
};

export type Table = readonly (readonly TableData[])[];

export type CombinationStatusData = {
    previous: CombineStatus;
    current: CombineStatus;
};

export type GenerateTable = (whiteboard: Status, video: Status) => TableData;

export type TableData = {
    combineStatus: CombineStatus;
    whiteboardStatus: Status;
    videoStatus: Status;
};
