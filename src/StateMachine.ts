import { debugLog } from "./Log";
import { Status } from "./StatusContant";
import { EventList, EmptyCallback, OnEventCallback, Mixing, LockStatus } from "./Types";
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
const baseStatusData = {
    status: Object.freeze(baseStatus),
    currentIndex: NaN,
    lastIndex: NaN,
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
    private videoStatus = {
        ...baseStatusData,
    };

    private whiteboardStatus = {
        ...baseStatusData,
    };

    private lockInfo: LockStatus = {
        status: false,
        allowStatusList: [],
        unLockStatusList: [],
    };

    private events = defaultCombineStatusHandler();

    private table = this.initTables();

    private readonly debug: (...args: any[]) => void = () => {};

    /**
     * 实例化 状态机
     * @param {boolean} debug - 是否开启 debug 日志
     */
    public constructor(debug: boolean) {
        if (debug) {
            this.debug = debugLog;
        }
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
     * @param {"video" | "whiteboard"} source - 需要更改哪端的状态
     * @param {Status} event - 即将要更改的状态名
     */
    public emit(source: "video" | "whiteboard", event: Status): void {
        const index = baseStatus.indexOf(event) + 1;
        if (source === "video") {
            if (this.videoStatus.currentIndex === index) {
                return;
            }

            this.videoStatus.currentIndex = index;

            this.debug(
                "Single",
                "Video",
                this.videoStatus.status[this.videoStatus.currentIndex - 1],
            );
        } else {
            if (this.whiteboardStatus.currentIndex === index) {
                return;
            }

            this.whiteboardStatus.currentIndex = index;

            this.debug(
                "Single",
                "Whiteboard",
                this.whiteboardStatus.status[this.whiteboardStatus.currentIndex - 1],
            );
        }

        // 只要有一个为 NaN 则不做任何处理
        if (isNaN(this.whiteboardStatus.currentIndex) || isNaN(this.videoStatus.currentIndex)) {
            return;
        }

        const combineStatus = this.table[this.whiteboardStatus.currentIndex - 1][
            this.videoStatus.currentIndex - 1
        ];

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

    public getLockInfo(): LockStatus {
        return this.lockInfo;
    }

    /**
     * 获取组合状态
     */
    public getCombinationStatus(): {
        last: CombineStatus | undefined;
        current: CombineStatus | undefined;
    } {
        const { lastIndex: videoLastIndex, currentIndex: videoCurrentIndex } = this.videoStatus;
        const {
            lastIndex: whiteboardLastIndex,
            currentIndex: whiteboardCurrentIndex,
        } = this.whiteboardStatus;

        let last: CombineStatus | undefined = undefined;
        let current: CombineStatus | undefined = undefined;

        if (!isNaN(videoLastIndex) && !isNaN(whiteboardLastIndex)) {
            last = this.table[videoLastIndex - 1][whiteboardLastIndex - 1].name;
        }

        if (!isNaN(videoCurrentIndex) && !isNaN(whiteboardCurrentIndex)) {
            current = this.table[videoCurrentIndex - 1][whiteboardCurrentIndex - 1].name;
        }

        return {
            last,
            current,
        };
    }

    /**
     * 获取端状态
     * @param {"video" | "whiteboard"} source - 要查看的端
     */
    public getStatus(
        source: "video" | "whiteboard",
    ): {
        last: Status;
        current: Status;
    } {
        if (source === "video") {
            const { lastIndex, currentIndex } = this.videoStatus;
            return {
                last: this.videoStatus.status[lastIndex - 1],
                current: this.videoStatus.status[currentIndex - 1],
            };
        } else {
            const { lastIndex, currentIndex } = this.whiteboardStatus;
            return {
                last: this.whiteboardStatus.status[lastIndex - 1],
                current: this.whiteboardStatus.status[currentIndex - 1],
            };
        }
    }

    /**
     * 设置上一次的状态下标
     * @param {number} whiteboardIndex - 回放的状态下标
     * @param {number} videoIndex - videoJS 的状态下标
     * @private
     */
    private setLastIndex(whiteboardIndex: number, videoIndex: number): void {
        this.whiteboardStatus.lastIndex = whiteboardIndex;
        this.videoStatus.lastIndex = videoIndex;
    }

    /**
     * 生成 event 数据
     * @param {CombineStatus} status - 需要生成的状态
     * @private
     */
    private generateEvent(status: CombineStatus) {
        return (
            whiteboardIndex: number,
            videoIndex: number,
        ): { name: CombineStatus; event: EmptyCallback } => ({
            name: status,
            event: (): void => {
                const last = {
                    whiteboardStatus: this.getStatus("whiteboard").last,
                    videoStatus: this.getStatus("video").last,
                };

                const current = {
                    whiteboardStatus: this.getStatus("whiteboard").current,
                    videoStatus: this.getStatus("video").current,
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

                handler(last, current, (): void => this.setLastIndex(whiteboardIndex, videoIndex));
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
                pauseSeeking(1, 1),
                pauseSeeking(1, 2),
                disabled(1, 3),
                disabled(1, 4),
                disabled(1, 5),
                disabled(1, 6),
                pauseSeeking(1, 7),

            ],
            [
                pauseSeeking(2, 1),
                pause(2, 2),
                pauseBuffering(2, 3),
                playingBuffering(2, 4),
                toPlay(2, 5),
                playingSeeking(2, 6),
                ended(2, 7),
            ],
            [
                disabled(3, 1),
                pauseBuffering(3, 2),
                pauseBuffering(3, 3),
                disabled(3, 4),
                disabled(3, 5),
                disabled(3, 6),
                disabled(3, 7),
            ],
            [
                disabled(4, 1),
                playingBuffering(4, 2),
                disabled(4, 3),
                playingBuffering(4, 4),
                toPause(4, 5),
                disabled(4, 6),
                disabled(4, 7),
            ],
            [
                disabled(5, 1),
                toPlay(5, 2),
                disabled(5, 3),
                toPause(5, 4),
                playing(5, 5),
                toPause(5, 6),
                toPause(5, 7),
            ],
            [
                disabled(6, 1),
                playingSeeking(6, 2),
                disabled(6, 3),
                disabled(6, 4),
                toPause(6, 5),
                playingSeeking(6, 6),
                playingSeeking(6, 7),
            ],
            [
                pauseSeeking(7, 1),
                ended(7, 2),
                disabled(7, 3),
                disabled(7, 4),
                toPause(7, 5),
                playingSeeking(7, 6),
                ended(7, 7),
            ],
        ];
    }
}
