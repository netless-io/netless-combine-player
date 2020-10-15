import { debugLog } from "./Log";
import { Source, Status } from "./StatusContant";
import {
    EventList,
    EmptyCallback,
    OnEventCallback,
    Mixing,
    LockStatus,
    BaseStatusData,
} from "./Types";
import { CombineStatus } from "./StatusContant";

// 共同的状态
const baseStatus = [
    Status.PauseSeeking,
    Status.Pause,
    Status.PauseBuffering,
    Status.PlayingBuffering,
    Status.Playing,
    Status.PlayingSeeking,
    Status.Ended,
];
const baseStatusData: BaseStatusData = {
    status: Object.freeze(baseStatus),
    current: "",
    last: "",
};

const emptyFnHandler = (_last: Mixing, _current: Mixing, done: EmptyCallback): void => {
    done();
};

// 设置默认的 组合状态触发器
const defaultCombineStatusHandler = (): EventList => {
    const result = {} as EventList;
    const keys = Object.keys(CombineStatus);
    const len = keys.length;

    for (let i = 0; i < len; i++) {
        const key = keys[i] as CombineStatus;
        result[key] = {
            handler: emptyFnHandler,
            once: false,
        };
    }

    return result;
};

export class StateMachine {
    private videoStatus: BaseStatusData = {
        ...baseStatusData,
    };

    private whiteboardStatus: BaseStatusData = {
        ...baseStatusData,
    };

    private lockInfo: LockStatus = {
        status: false,
        allowStatusList: [],
        unLockStatusList: [],
    };

    private events: EventList = defaultCombineStatusHandler();

    private readonly table: { name: CombineStatus; event: EmptyCallback }[][];

    private readonly debug: (...args: any[]) => void = () => {};

    /**
     * 实例化 状态机
     * @param {boolean} debug - 是否开启 debug 日志
     */
    public constructor(debug: boolean) {
        if (debug) {
            this.debug = debugLog;
        }

        this.table = this.initTables();
    }

    /**
     * 监听组合状态变更回调，只运行一次
     * @param {CombineStatus} eventName - 需要监听的组合状态名
     * @param {OnEventCallback} cb - 事件回调
     */
    public one(eventName: CombineStatus, cb: OnEventCallback): void {
        this.events[eventName] = {
            handler: cb,
            once: true,
        };
    }

    /**
     * 监听组合状态变更回调
     * @param {CombineStatus} eventName - 需要监听的组合状态名
     * @param {OnEventCallback} cb - 事件回调
     */
    public on(eventName: CombineStatus, cb: OnEventCallback): void {
        this.events[eventName] = {
            handler: cb,
            once: false,
        };
    }

    /**
     * 解除监听器
     * @param {CombineStatus | CombineStatus[]} eventName - 需要取消监听的组合状态名
     */
    public off(eventName: CombineStatus | CombineStatus[]): void {
        if (typeof eventName === "string") {
            this.events[eventName] = {
                handler: emptyFnHandler,
                once: false,
            };
        } else {
            for (let i = 0; i < eventName.length; i++) {
                this.events[eventName[i]] = {
                    handler: emptyFnHandler,
                    once: false,
                };
            }
        }
    }

    /**
     * 通知状态变更
     * @param {Source} source - 需要更改哪端的状态
     * @param {Status} status - 即将要更改的状态名
     */
    public emit(source: Source, status: Status): void {
        const index = baseStatus.indexOf(status);
        if (source === Source.Video) {
            if (this.videoStatus.current === status || index === -1) {
                return;
            }

            this.videoStatus.current = status;

            this.debug("Single", "Video", this.videoStatus.status[index]);
        } else {
            if (this.whiteboardStatus.current === status || index === -1) {
                return;
            }

            this.whiteboardStatus.current = status;

            this.debug("Single", "Whiteboard", this.whiteboardStatus.status[index]);
        }

        // 只要有一个为 空字符串 则不做任何处理
        if (this.whiteboardStatus.current === "" || this.videoStatus.current === "") {
            return;
        }

        const whiteboardStatusIndex = baseStatus.indexOf(this.whiteboardStatus.current);
        const videoStatusIndex = baseStatus.indexOf(this.videoStatus.current);

        const combineStatus = this.table[whiteboardStatusIndex][videoStatusIndex];

        // 如果当前设置了 lock，则只有在 允许状态列表里，才会运行相关的组合状态回调
        // 当不在 解锁状态列表里，是不会运行任何的组合状态回调
        if (this.lockInfo.status) {
            if (this.lockInfo.allowStatusList.includes(combineStatus.name)) {
                // 当符合条件时解锁
                if (this.lockInfo.unLockStatusList.includes(combineStatus.name)) {
                    this.unLockStatus();
                }

                combineStatus.event();
            }
        } else {
            combineStatus.event();
        }
    }

    /**
     * 开启 状态锁
     * @param {CombineStatus[]} allowStatusList - 允许进入的组合状态名列表
     * @param {CombineStatus[]} unLockStatusList - 解锁的组合状态名列表
     */
    public lockStatus(allowStatusList: CombineStatus[], unLockStatusList: CombineStatus[]): void {
        // 如果当前已经有锁，则跳过，不再进行设置
        if (this.lockInfo.status) {
            return;
        }
        this.lockInfo.status = true;
        this.lockInfo.allowStatusList = allowStatusList;
        this.lockInfo.unLockStatusList = unLockStatusList;
    }

    /**
     * 关闭 状态锁
     */
    public unLockStatus(): void {
        this.lockInfo.status = false;
        this.lockInfo.allowStatusList = [];
        this.lockInfo.unLockStatusList = [];
    }

    /**
     * 获取组合状态
     */
    public getCombinationStatus(): {
        last: CombineStatus | undefined;
        current: CombineStatus | undefined;
    } {
        const { last: videoLast, current: videoCurrent } = this.videoStatus;
        const { last: whiteboardLast, current: whiteboardCurrent } = this.whiteboardStatus;

        let last: CombineStatus | undefined = undefined;
        let current: CombineStatus | undefined = undefined;

        if (videoLast !== "" && whiteboardLast !== "") {
            const videoStatusLast = baseStatus.indexOf(videoLast);
            const whiteboardStatusLast = baseStatus.indexOf(whiteboardLast);

            last = this.table[whiteboardStatusLast][videoStatusLast].name;
        }

        if (videoCurrent !== "" && whiteboardCurrent !== "") {
            const videoStatusCurrent = baseStatus.indexOf(videoCurrent);
            const whiteboardStatusCurrent = baseStatus.indexOf(whiteboardCurrent);

            current = this.table[whiteboardStatusCurrent][videoStatusCurrent].name;
        }

        return {
            last,
            current,
        };
    }

    /**
     * 获取端状态
     * @param {Source} source - 要查看的端
     */
    public getStatus(
        source: Source,
    ): {
        last: Status | "";
        current: Status | "";
    } {
        if (source === Source.Video) {
            return {
                last: this.videoStatus.last,
                current: this.videoStatus.current,
            };
        } else {
            return {
                last: this.whiteboardStatus.last,
                current: this.whiteboardStatus.current,
            };
        }
    }

    /**
     * 设置上一次的状态下标
     * @param {Status} whiteboard - 回放的状态下标
     * @param {Status} video - videoJS 的状态下标
     * @private
     */
    private setLastIndex(whiteboard: Status, video: Status): void {
        this.whiteboardStatus.last = whiteboard;
        this.videoStatus.last = video;
    }

    /**
     * 生成 event 数据
     * @param {CombineStatus} status - 需要生成的状态
     * @private
     */
    private generateEvent(status: CombineStatus) {
        return (
            whiteboard: Status,
            video: Status,
        ): { name: CombineStatus; event: EmptyCallback } => ({
            name: status,
            event: (): void => {
                const last = {
                    whiteboard: this.getStatus(Source.Whiteboard).last,
                    video: this.getStatus(Source.Video).last,
                };

                const current = {
                    whiteboard: this.getStatus(Source.Whiteboard).current,
                    video: this.getStatus(Source.Video).current,
                };

                this.debug("CombinedStatus", status, {
                    last,
                    current,
                });

                const handler = this.events[status].handler;

                // 如果当前为 once，则运行完成后，置空 handler
                if (this.events[status].once) {
                    this.events[status] = {
                        handler: emptyFnHandler,
                        once: false,
                    };
                }

                handler(last, current, (): void => this.setLastIndex(whiteboard, video));
            },
        });
    }

    /**
     * 初始化二维表格
     * @private
     */
    private initTables(): { name: CombineStatus; event: EmptyCallback }[][] {
        const pauseSeeking = this.generateEvent(CombineStatus.PauseSeeking);
        const playingSeeking = this.generateEvent(CombineStatus.PlayingSeeking);
        const pauseBuffering = this.generateEvent(CombineStatus.PauseBuffering);
        const playingBuffering = this.generateEvent(CombineStatus.PlayingBuffering);
        const toPlay = this.generateEvent(CombineStatus.ToPlay);
        const toPause = this.generateEvent(CombineStatus.ToPause);
        const pause = this.generateEvent(CombineStatus.Pause);
        const playing = this.generateEvent(CombineStatus.Playing);
        const disabled = this.generateEvent(CombineStatus.Disabled);
        const ended = this.generateEvent(CombineStatus.Ended);

        // prettier-ignore
        return [
            [
                pauseSeeking(Status.PauseSeeking, Status.PauseSeeking),
                pauseSeeking(Status.PauseSeeking, Status.Pause),
                disabled(Status.PauseSeeking, Status.PauseBuffering),
                disabled(Status.PauseSeeking, Status.PlayingBuffering),
                disabled(Status.PauseSeeking, Status.Playing),
                disabled(Status.PauseSeeking, Status.PlayingSeeking),
                pauseSeeking(Status.PauseSeeking, Status.Ended),

            ],
            [
                pauseSeeking(Status.Pause, Status.PauseSeeking),
                pause(Status.Pause, Status.Pause),
                pauseBuffering(Status.Pause, Status.PauseBuffering),
                playingBuffering(Status.Pause, Status.PlayingBuffering),
                toPlay(Status.Pause, Status.Playing),
                playingSeeking(Status.Pause, Status.PlayingSeeking),
                ended(Status.Pause, Status.Ended),
            ],
            [
                disabled(Status.PauseBuffering, Status.PauseSeeking),
                pauseBuffering(Status.PauseBuffering, Status.Pause),
                pauseBuffering(Status.PauseBuffering, Status.PauseBuffering),
                disabled(Status.PauseBuffering, Status.PlayingBuffering),
                disabled(Status.PauseBuffering, Status.Playing),
                disabled(Status.PauseBuffering, Status.PlayingSeeking),
                disabled(Status.PauseBuffering, Status.Ended),
            ],
            [
                disabled(Status.PlayingBuffering, Status.PauseSeeking),
                playingBuffering(Status.PlayingBuffering, Status.Pause),
                disabled(Status.PlayingBuffering, Status.PauseBuffering),
                playingBuffering(Status.PlayingBuffering, Status.PlayingBuffering),
                toPause(Status.PlayingBuffering, Status.Playing),
                disabled(Status.PlayingBuffering, Status.PlayingSeeking),
                disabled(Status.PlayingBuffering, Status.Ended),
            ],
            [
                disabled(Status.Playing, Status.PauseSeeking),
                toPlay(Status.Playing, Status.Pause),
                disabled(Status.Playing, Status.PauseBuffering),
                toPause(Status.Playing, Status.PlayingBuffering),
                playing(Status.Playing, Status.Playing),
                toPause(Status.Playing, Status.PlayingSeeking),
                toPause(Status.Playing, Status.Ended),
            ],
            [
                disabled(Status.PlayingSeeking, Status.PauseSeeking),
                playingSeeking(Status.PlayingSeeking, Status.Pause),
                disabled(Status.PlayingSeeking, Status.PauseBuffering),
                disabled(Status.PlayingSeeking, Status.PlayingBuffering),
                toPause(Status.PlayingSeeking, Status.Playing),
                playingSeeking(Status.PlayingSeeking, Status.PlayingSeeking),
                playingSeeking(Status.PlayingSeeking, Status.Ended),
            ],
            [
                pauseSeeking(Status.Ended, Status.PauseSeeking),
                ended(Status.Ended, Status.Pause),
                disabled(Status.Ended, Status.PauseBuffering),
                disabled(Status.Ended, Status.PlayingBuffering),
                toPause(Status.Ended, Status.Playing),
                playingSeeking(Status.Ended, Status.PlayingSeeking),
                ended(Status.Ended, Status.Ended),
            ],
        ];
    }
}
