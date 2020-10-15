import { debugLog } from "./Log";
import { CombineStatus, Source, Status } from "./StatusContant";
import {
    CombinationStatusData,
    EmptyCallback,
    EventList,
    GenerateTable,
    LockInfo,
    Mixing,
    OnEventCallback,
    StatusData,
    Table,
    TableData,
} from "./Types";

const emptyFnHandler = (_previous: Mixing, _current: Mixing, done: EmptyCallback): void => {
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
    private readonly videoStatus: StatusData = {
        current: Status.PauseBuffering,
        previous: Status.PauseBuffering,
    };

    private readonly whiteboardStatus: StatusData = {
        current: Status.PauseBuffering,
        previous: Status.PauseBuffering,
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
    public setStatus(source: Source, status: Status): void {
        switch (source) {
            case Source.Video: {
                if (this.videoStatus.current === status) {
                    return;
                }

                this.videoStatus.current = status;

                this.debug("Single", "Video", Status[status]);
                break;
            }
            case Source.Whiteboard: {
                if (this.whiteboardStatus.current === status) {
                    return;
                }

                this.whiteboardStatus.current = status;

                this.debug("Single", "Whiteboard", Status[status]);
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

                this.eventHandler(combineStatus);
            }
        } else {
            this.eventHandler(combineStatus);
        }
    }

    /**
     * 开启 状态锁
     * @param {CombineStatus[]} allowStatusList - 允许进入的组合状态名列表
     * @param {CombineStatus[]} unLockStatusList - 解锁的组合状态名列表
     */
    public lockCombineStatus(
        allowStatusList: CombineStatus[],
        unLockStatusList: CombineStatus[],
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
    public getCombinationStatus(): CombinationStatusData {
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
     * @param {Source} source - 要查看的端
     */
    public getStatus(source: Source): StatusData {
        switch (source) {
            case Source.Video:
                return {
                    previous: this.videoStatus.previous,
                    current: this.videoStatus.current,
                };
            case Source.Whiteboard:
                return {
                    previous: this.whiteboardStatus.previous,
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
    private setPreviousStatus(whiteboard: Status, video: Status): void {
        this.whiteboardStatus.previous = whiteboard;
        this.videoStatus.previous = video;
    }

    /**
     * 根据传入的 table 数据，进行处理
     * @param tableData
     * @private
     */
    private eventHandler(tableData: TableData): void {
        const { videoStatus, whiteboardStatus, combineStatus } = tableData;

        const previous: Mixing = {
            whiteboard: this.getStatus(Source.Whiteboard).previous,
            video: this.getStatus(Source.Video).previous,
        };

        const current: Mixing = {
            whiteboard: whiteboardStatus,
            video: videoStatus,
        };

        this.debug("CombinedStatus", combineStatus, {
            previous: {
                whiteboard: Status[previous.whiteboard],
                video: Status[previous.video],
            },
            current: {
                whiteboard: Status[current.whiteboard],
                video: Status[current.video],
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
        const generateTable = (combineStatus: CombineStatus): GenerateTable => {
            return (whiteboardStatus: Status, videoStatus: Status): TableData => {
                return Object.freeze({
                    combineStatus,
                    whiteboardStatus,
                    videoStatus,
                });
            };
        };

        const pauseSeeking = generateTable(CombineStatus.PauseSeeking);
        const playingSeeking = generateTable(CombineStatus.PlayingSeeking);
        const pauseBuffering = generateTable(CombineStatus.PauseBuffering);
        const playingBuffering = generateTable(CombineStatus.PlayingBuffering);
        const toPlay = generateTable(CombineStatus.ToPlay);
        const toPause = generateTable(CombineStatus.ToPause);
        const pause = generateTable(CombineStatus.Pause);
        const playing = generateTable(CombineStatus.Playing);
        const disabled = generateTable(CombineStatus.Disabled);
        const ended = generateTable(CombineStatus.Ended);

        // prettier-ignore
        return Object.freeze([
            Object.freeze([
                pauseSeeking(Status.PauseSeeking, Status.PauseSeeking),
                pauseSeeking(Status.PauseSeeking, Status.Pause),
                disabled(Status.PauseSeeking, Status.PauseBuffering),
                disabled(Status.PauseSeeking, Status.PlayingBuffering),
                disabled(Status.PauseSeeking, Status.Playing),
                disabled(Status.PauseSeeking, Status.PlayingSeeking),
                pauseSeeking(Status.PauseSeeking, Status.Ended),
            ]),
            Object.freeze([
                pauseSeeking(Status.Pause, Status.PauseSeeking),
                pause(Status.Pause, Status.Pause),
                pauseBuffering(Status.Pause, Status.PauseBuffering),
                playingBuffering(Status.Pause, Status.PlayingBuffering),
                toPlay(Status.Pause, Status.Playing),
                playingSeeking(Status.Pause, Status.PlayingSeeking),
                ended(Status.Pause, Status.Ended),
            ]),
            Object.freeze([
                disabled(Status.PauseBuffering, Status.PauseSeeking),
                pauseBuffering(Status.PauseBuffering, Status.Pause),
                pauseBuffering(Status.PauseBuffering, Status.PauseBuffering),
                disabled(Status.PauseBuffering, Status.PlayingBuffering),
                disabled(Status.PauseBuffering, Status.Playing),
                disabled(Status.PauseBuffering, Status.PlayingSeeking),
                disabled(Status.PauseBuffering, Status.Ended),
            ]),
            ([
                disabled(Status.PlayingBuffering, Status.PauseSeeking),
                playingBuffering(Status.PlayingBuffering, Status.Pause),
                disabled(Status.PlayingBuffering, Status.PauseBuffering),
                playingBuffering(Status.PlayingBuffering, Status.PlayingBuffering),
                toPause(Status.PlayingBuffering, Status.Playing),
                disabled(Status.PlayingBuffering, Status.PlayingSeeking),
                disabled(Status.PlayingBuffering, Status.Ended),
            ]),
            Object.freeze([
                disabled(Status.Playing, Status.PauseSeeking),
                toPlay(Status.Playing, Status.Pause),
                disabled(Status.Playing, Status.PauseBuffering),
                toPause(Status.Playing, Status.PlayingBuffering),
                playing(Status.Playing, Status.Playing),
                toPause(Status.Playing, Status.PlayingSeeking),
                toPause(Status.Playing, Status.Ended),
            ]),
            Object.freeze([
                disabled(Status.PlayingSeeking, Status.PauseSeeking),
                playingSeeking(Status.PlayingSeeking, Status.Pause),
                disabled(Status.PlayingSeeking, Status.PauseBuffering),
                disabled(Status.PlayingSeeking, Status.PlayingBuffering),
                toPause(Status.PlayingSeeking, Status.Playing),
                playingSeeking(Status.PlayingSeeking, Status.PlayingSeeking),
                playingSeeking(Status.PlayingSeeking, Status.Ended),
            ]),
            Object.freeze([
                pauseSeeking(Status.Ended, Status.PauseSeeking),
                ended(Status.Ended, Status.Pause),
                disabled(Status.Ended, Status.PauseBuffering),
                disabled(Status.Ended, Status.PlayingBuffering),
                toPause(Status.Ended, Status.Playing),
                playingSeeking(Status.Ended, Status.PlayingSeeking),
                ended(Status.Ended, Status.Ended),
            ]),
        ]);
    }
}
