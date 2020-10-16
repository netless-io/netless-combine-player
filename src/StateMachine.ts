import { debugLog } from "./Log";
import { CombinePlayerStatus, AtomPlayerSource, AtomPlayerStatus } from "./StatusContant";
import {
    CombinePlayerStatusTransfer,
    EmptyCallback,
    EventList,
    LockInfo,
    AtomPlayerStatusPair,
    OnEventCallback,
    AtomPlayerStatusTransfer,
} from "./Types";

const emptyFnHandler = (
    _previous: AtomPlayerStatusPair,
    _current: AtomPlayerStatusPair,
    done: EmptyCallback,
): void => {
    done();
};

// 设置默认的 组合状态触发器
const defaultCombineStatusHandler = (): EventList => {
    const result = {} as EventList;
    const keys = Object.keys(CombinePlayerStatus);
    const len = keys.length;

    for (let i = 0; i < len; i++) {
        const key = keys[i] as CombinePlayerStatus;
        result[key] = {
            handler: emptyFnHandler,
            once: false,
        };
    }

    return result;
};

export class StateMachine {
    private readonly videoStatus: AtomPlayerStatusTransfer = {
        current: AtomPlayerStatus.PauseBuffering,
        previous: AtomPlayerStatus.PauseBuffering,
    };

    private readonly whiteboardStatus: AtomPlayerStatusTransfer = {
        current: AtomPlayerStatus.PauseBuffering,
        previous: AtomPlayerStatus.PauseBuffering,
    };

    private readonly statusLockInfo: LockInfo = {
        isLocked: false,
        allowStatusList: [],
        unLockStatusList: [],
    };

    private readonly events: EventList = defaultCombineStatusHandler();

    private readonly table: Table;

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
     * @param {CombinePlayerStatus} eventName - 需要监听的组合状态名
     * @param {OnEventCallback} cb - 事件回调
     */
    public one(eventName: CombinePlayerStatus, cb: OnEventCallback): void {
        this.events[eventName] = {
            handler: cb,
            once: true,
        };
    }

    /**
     * 监听组合状态变更回调
     * @param {CombinePlayerStatus} eventName - 需要监听的组合状态名
     * @param {OnEventCallback} cb - 事件回调
     */
    public on(eventName: CombinePlayerStatus, cb: OnEventCallback): void {
        this.events[eventName] = {
            handler: cb,
            once: false,
        };
    }

    /**
     * 解除监听器
     * @param {CombinePlayerStatus | CombinePlayerStatus[]} eventName - 需要取消监听的组合状态名
     */
    public off(eventName: CombinePlayerStatus | CombinePlayerStatus[]): void {
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
     * @param {AtomPlayerSource} source - 需要更改哪端的状态
     * @param {AtomPlayerStatus} status - 即将要更改的状态名
     */
    public setStatus(source: AtomPlayerSource, status: AtomPlayerStatus): void {
        switch (source) {
            case AtomPlayerSource.Video: {
                if (this.videoStatus.current === status) {
                    return;
                }

                this.videoStatus.current = status;

                this.debug("Single", "Video", AtomPlayerStatus[status]);
                break;
            }
            case AtomPlayerSource.Whiteboard: {
                if (this.whiteboardStatus.current === status) {
                    return;
                }

                this.whiteboardStatus.current = status;

                this.debug("Single", "Whiteboard", AtomPlayerStatus[status]);
                break;
            }
        }

        const whiteboardStatusIndex = this.whiteboardStatus.current;
        const videoStatusIndex = this.videoStatus.current;

        const combineStatus = this.table[whiteboardStatusIndex][videoStatusIndex];

        // 如果当前设置了 lock，则只有在 允许状态列表里，才会运行相关的组合状态回调
        // 当不在 解锁状态列表里，是不会运行任何的组合状态回调
        if (this.statusLockInfo.isLocked) {
            if (this.statusLockInfo.allowStatusList.includes(combineStatus.combineStatus)) {
                // 当符合条件时解锁
                if (this.statusLockInfo.unLockStatusList.includes(combineStatus.combineStatus)) {
                    this.unlockCombineStatus();
                }

                this.handleEvent(combineStatus);
            }
        } else {
            this.handleEvent(combineStatus);
        }
    }

    /**
     * 开启 状态锁
     * @param {CombinePlayerStatus[]} allowStatusList - 允许进入的组合状态名列表
     * @param {CombinePlayerStatus[]} unLockStatusList - 解锁的组合状态名列表
     */
    public lockCombineStatus(
        allowStatusList: CombinePlayerStatus[],
        unLockStatusList: CombinePlayerStatus[],
    ): void {
        // 如果当前已经有锁，则跳过，不再进行设置
        if (this.statusLockInfo.isLocked) {
            return;
        }
        this.statusLockInfo.isLocked = true;
        this.statusLockInfo.allowStatusList = allowStatusList;
        this.statusLockInfo.unLockStatusList = unLockStatusList;
    }

    /**
     * 关闭 状态锁
     */
    public unlockCombineStatus(): void {
        this.statusLockInfo.isLocked = false;
        this.statusLockInfo.allowStatusList = [];
        this.statusLockInfo.unLockStatusList = [];
    }

    /**
     * 获取组合状态
     */
    public getCombinationStatus(): CombinePlayerStatusTransfer {
        const { previous: videoPrevious, current: videoCurrent } = this.videoStatus;
        const { previous: whiteboardPrevious, current: whiteboardCurrent } = this.whiteboardStatus;

        const previous = this.table[whiteboardPrevious][videoPrevious].combineStatus;
        const current = this.table[whiteboardCurrent][videoCurrent].combineStatus;

        return {
            previous,
            current,
        };
    }

    /**
     * 获取端状态
     * @param {AtomPlayerSource} source - 要查看的端
     */
    public getStatus(source: AtomPlayerSource): AtomPlayerStatusTransfer {
        switch (source) {
            case AtomPlayerSource.Video:
                return {
                    previous: this.videoStatus.previous,
                    current: this.videoStatus.current,
                };
            case AtomPlayerSource.Whiteboard:
                return {
                    previous: this.whiteboardStatus.previous,
                    current: this.whiteboardStatus.current,
                };
        }
    }

    /**
     * 设置上一次的状态下标
     * @param {AtomPlayerStatus} whiteboard - 回放的状态下标
     * @param {AtomPlayerStatus} video - videoJS 的状态下标
     * @private
     */
    private setPreviousStatus(whiteboard: AtomPlayerStatus, video: AtomPlayerStatus): void {
        this.whiteboardStatus.previous = whiteboard;
        this.videoStatus.previous = video;
    }

    /**
     * 根据传入的 table 数据，进行处理
     * @param tableData
     * @private
     */
    private handleEvent(tableData: TableData): void {
        const { videoStatus, whiteboardStatus, combineStatus } = tableData;

        const previous: AtomPlayerStatusPair = {
            whiteboard: this.getStatus(AtomPlayerSource.Whiteboard).previous,
            video: this.getStatus(AtomPlayerSource.Video).previous,
        };

        const current: AtomPlayerStatusPair = {
            whiteboard: whiteboardStatus,
            video: videoStatus,
        };

        this.debug("CombinedStatus", combineStatus, {
            previous: {
                whiteboard: AtomPlayerStatus[previous.whiteboard],
                video: AtomPlayerStatus[previous.video],
            },
            current: {
                whiteboard: AtomPlayerStatus[current.whiteboard],
                video: AtomPlayerStatus[current.video],
            },
        });

        const handler = this.events[combineStatus].handler;

        // 如果当前为 once，则运行完成后，置空 handler
        if (this.events[combineStatus].once) {
            this.events[combineStatus] = {
                handler: emptyFnHandler,
                once: false,
            };
        }

        handler(previous, current, (): void => {
            this.setPreviousStatus(whiteboardStatus, videoStatus);
        });
    }

    /**
     * 初始化二维表格
     * @private
     */
    private initTables(): Table {
        const generateTable = (combineStatus: CombinePlayerStatus): GenerateTable => {
            return (
                whiteboardStatus: AtomPlayerStatus,
                videoStatus: AtomPlayerStatus,
            ): TableData => {
                return Object.freeze({
                    combineStatus,
                    whiteboardStatus,
                    videoStatus,
                });
            };
        };

        const pauseSeeking = generateTable(CombinePlayerStatus.PauseSeeking);
        const playingSeeking = generateTable(CombinePlayerStatus.PlayingSeeking);
        const pauseBuffering = generateTable(CombinePlayerStatus.PauseBuffering);
        const playingBuffering = generateTable(CombinePlayerStatus.PlayingBuffering);
        const toPlay = generateTable(CombinePlayerStatus.ToPlay);
        const toPause = generateTable(CombinePlayerStatus.ToPause);
        const pause = generateTable(CombinePlayerStatus.Pause);
        const playing = generateTable(CombinePlayerStatus.Playing);
        const disabled = generateTable(CombinePlayerStatus.Disabled);
        const ended = generateTable(CombinePlayerStatus.Ended);

        // prettier-ignore
        return Object.freeze([
            Object.freeze([
                pauseSeeking(AtomPlayerStatus.PauseSeeking, AtomPlayerStatus.PauseSeeking),
                pauseSeeking(AtomPlayerStatus.PauseSeeking, AtomPlayerStatus.Pause),
                disabled(AtomPlayerStatus.PauseSeeking, AtomPlayerStatus.PauseBuffering),
                disabled(AtomPlayerStatus.PauseSeeking, AtomPlayerStatus.PlayingBuffering),
                disabled(AtomPlayerStatus.PauseSeeking, AtomPlayerStatus.Playing),
                disabled(AtomPlayerStatus.PauseSeeking, AtomPlayerStatus.PlayingSeeking),
                pauseSeeking(AtomPlayerStatus.PauseSeeking, AtomPlayerStatus.Ended),
            ]),
            Object.freeze([
                pauseSeeking(AtomPlayerStatus.Pause, AtomPlayerStatus.PauseSeeking),
                pause(AtomPlayerStatus.Pause, AtomPlayerStatus.Pause),
                pauseBuffering(AtomPlayerStatus.Pause, AtomPlayerStatus.PauseBuffering),
                playingBuffering(AtomPlayerStatus.Pause, AtomPlayerStatus.PlayingBuffering),
                toPlay(AtomPlayerStatus.Pause, AtomPlayerStatus.Playing),
                playingSeeking(AtomPlayerStatus.Pause, AtomPlayerStatus.PlayingSeeking),
                ended(AtomPlayerStatus.Pause, AtomPlayerStatus.Ended),
            ]),
            Object.freeze([
                disabled(AtomPlayerStatus.PauseBuffering, AtomPlayerStatus.PauseSeeking),
                pauseBuffering(AtomPlayerStatus.PauseBuffering, AtomPlayerStatus.Pause),
                pauseBuffering(AtomPlayerStatus.PauseBuffering, AtomPlayerStatus.PauseBuffering),
                disabled(AtomPlayerStatus.PauseBuffering, AtomPlayerStatus.PlayingBuffering),
                disabled(AtomPlayerStatus.PauseBuffering, AtomPlayerStatus.Playing),
                disabled(AtomPlayerStatus.PauseBuffering, AtomPlayerStatus.PlayingSeeking),
                disabled(AtomPlayerStatus.PauseBuffering, AtomPlayerStatus.Ended),
            ]),
            ([
                disabled(AtomPlayerStatus.PlayingBuffering, AtomPlayerStatus.PauseSeeking),
                playingBuffering(AtomPlayerStatus.PlayingBuffering, AtomPlayerStatus.Pause),
                disabled(AtomPlayerStatus.PlayingBuffering, AtomPlayerStatus.PauseBuffering),
                playingBuffering(AtomPlayerStatus.PlayingBuffering, AtomPlayerStatus.PlayingBuffering),
                toPause(AtomPlayerStatus.PlayingBuffering, AtomPlayerStatus.Playing),
                disabled(AtomPlayerStatus.PlayingBuffering, AtomPlayerStatus.PlayingSeeking),
                disabled(AtomPlayerStatus.PlayingBuffering, AtomPlayerStatus.Ended),
            ]),
            Object.freeze([
                disabled(AtomPlayerStatus.Playing, AtomPlayerStatus.PauseSeeking),
                toPlay(AtomPlayerStatus.Playing, AtomPlayerStatus.Pause),
                disabled(AtomPlayerStatus.Playing, AtomPlayerStatus.PauseBuffering),
                toPause(AtomPlayerStatus.Playing, AtomPlayerStatus.PlayingBuffering),
                playing(AtomPlayerStatus.Playing, AtomPlayerStatus.Playing),
                toPause(AtomPlayerStatus.Playing, AtomPlayerStatus.PlayingSeeking),
                toPause(AtomPlayerStatus.Playing, AtomPlayerStatus.Ended),
            ]),
            Object.freeze([
                disabled(AtomPlayerStatus.PlayingSeeking, AtomPlayerStatus.PauseSeeking),
                playingSeeking(AtomPlayerStatus.PlayingSeeking, AtomPlayerStatus.Pause),
                disabled(AtomPlayerStatus.PlayingSeeking, AtomPlayerStatus.PauseBuffering),
                disabled(AtomPlayerStatus.PlayingSeeking, AtomPlayerStatus.PlayingBuffering),
                toPause(AtomPlayerStatus.PlayingSeeking, AtomPlayerStatus.Playing),
                playingSeeking(AtomPlayerStatus.PlayingSeeking, AtomPlayerStatus.PlayingSeeking),
                playingSeeking(AtomPlayerStatus.PlayingSeeking, AtomPlayerStatus.Ended),
            ]),
            Object.freeze([
                pauseSeeking(AtomPlayerStatus.Ended, AtomPlayerStatus.PauseSeeking),
                ended(AtomPlayerStatus.Ended, AtomPlayerStatus.Pause),
                disabled(AtomPlayerStatus.Ended, AtomPlayerStatus.PauseBuffering),
                disabled(AtomPlayerStatus.Ended, AtomPlayerStatus.PlayingBuffering),
                toPause(AtomPlayerStatus.Ended, AtomPlayerStatus.Playing),
                playingSeeking(AtomPlayerStatus.Ended, AtomPlayerStatus.PlayingSeeking),
                ended(AtomPlayerStatus.Ended, AtomPlayerStatus.Ended),
            ]),
        ]);
    }
}

export type Table = readonly (readonly TableData[])[];

export type TableData = {
    readonly combineStatus: CombinePlayerStatus;
    readonly whiteboardStatus: AtomPlayerStatus;
    readonly videoStatus: AtomPlayerStatus;
};

export type GenerateTable = (whiteboard: AtomPlayerStatus, video: AtomPlayerStatus) => TableData;
