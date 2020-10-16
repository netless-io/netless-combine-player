import { VideoJsPlayerOptions } from "video.js";
import { CombinePlayerStatus, AtomPlayerStatus } from "./StatusContant";

export interface VideoOptions extends VideoDefaultOptions {
    readonly url: string;
}

export interface VideoDefaultOptions {
    readonly videoDOM?: HTMLVideoElement;
    readonly videoJsOptions?: VideoJsPlayerOptions;
}

export type AtomPlayerStatusPair = {
    readonly whiteboard: AtomPlayerStatus;
    readonly video: AtomPlayerStatus;
};

export type OnEventCallback = (
    previous: AtomPlayerStatusPair,
    current: AtomPlayerStatusPair,
    done: () => void,
) => any;

export type EventList = {
    -readonly [key in CombinePlayerStatus]: {
        handler: OnEventCallback;
        once: boolean;
    };
};

export type EmptyCallback = () => void;

export type AnyFunction = (...args: any[]) => any;

export type PublicCombinedStatus =
    | CombinePlayerStatus.PauseSeeking
    | CombinePlayerStatus.PlayingSeeking
    | CombinePlayerStatus.Pause
    | CombinePlayerStatus.PauseBuffering
    | CombinePlayerStatus.PlayingBuffering
    | CombinePlayerStatus.Playing
    | CombinePlayerStatus.Ended
    | CombinePlayerStatus.Disabled;

export type LockInfo = {
    isLocked: boolean;
    allowStatusList: readonly CombinePlayerStatus[];
    unLockStatusList: readonly CombinePlayerStatus[];
};

export type AtomPlayerStatusTransfer = {
    current: AtomPlayerStatus;
    previous: AtomPlayerStatus;
};

export type CombinePlayerStatusTransfer = {
    readonly previous: CombinePlayerStatus;
    readonly current: CombinePlayerStatus;
};
