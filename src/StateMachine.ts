import { debugLog } from "./Log";
import { AtomPlayerSource, AtomPlayerStatus, CombinePlayerStatus } from "./StatusContant";
import {
    AnyFunction,
    AtomPlayerStatusCompose,
    AtomPlayerStatusPair,
    AtomPlayerStatusTransfer,
    CombinePlayerStatusTransfer,
    LockInfo,
} from "./Types";
import { EventEmitter } from "./EventEmitter";
import {
    ACCIDENT_ENTERED_DISABLED,
    MONITOR_LEGAL_DISABLE_STATE_MULTIPLE_TIMES,
} from "./ErrorConstant";

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

    private readonly events: EventEmitter = new EventEmitter();

    private readonly table: Table;

    private readonly debug: (...args: any[]) => void = () => {};

    private statusIgnoreCrashByDisabled: AtomPlayerStatusPair[] = [];
    private statusIgnoreCrashByDisabledCallback: Callback = () => Promise.resolve();

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

    public one(
        eventName: CombinePlayerStatus,
        cb?: OnStatusUpdate,
    ): Promise<AtomPlayerStatusCompose> {
        return new Promise((resolve, reject) => {
            this.events.one(eventName, async (previous, current, done) => {
                try {
                    if (cb) {
                        await cb({
                            previous,
                            current,
                        });
                    }
                    resolve();
                } catch (err) {
                    reject(err);
                } finally {
                    done();
                }
            });
        });
    }

    public async setOnCrashByDisabledStatus(crashHandler: AnyFunction): Promise<void> {
        return this.on(CombinePlayerStatus.Disabled, async ({ current }) => {
            const { video: videoStatus, whiteboard: whiteboardStatus } = current;

            // 当当前页面不在浏览器的Tab激活页时，而后又被激活，就会出现在这种情况。所以这里对其做了额外处理，认为是合法状态
            const whiteboardBuffering =
                whiteboardStatus === AtomPlayerStatus.PauseBuffering &&
                videoStatus === AtomPlayerStatus.Playing;

            const flag = this.shouldCrash(videoStatus, whiteboardStatus);

            if (flag && !whiteboardBuffering) {
                crashHandler();
            }
        });
    }

    /**
     * 在设计时，我们认为凡是进入到 Disable 状态的，都是意外情况，是不应该出现的。但实际上总会有几种情况，进入 Disable 是合法且正常的
     * 所以需要通过此函数来监听合法的 Disabled 状态
     *
     * @param {AtomPlayerStatusPair[]} statusIgnoreCrashByDisabled - 只有当满足此情况，才运行逻辑
     * 并不是所有的情况进入 Disable 状态 都是正常的，需要一个过滤器，只有当前的状态满足了这个过滤器，才会属于合法情况
     * @param {OnStatusUpdate} [cb] - 状态回调
     */
    public oneButNotCrashByDisabled(
        statusIgnoreCrashByDisabled: AtomPlayerStatusPair[],
        cb?: OnStatusUpdate,
    ): Promise<AtomPlayerStatusCompose> {
        return new Promise((resolve, reject) => {
            if (this.statusIgnoreCrashByDisabled.length !== 0) {
                return reject(new Error(MONITOR_LEGAL_DISABLE_STATE_MULTIPLE_TIMES));
            }

            this.statusIgnoreCrashByDisabled = statusIgnoreCrashByDisabled;

            const callback: Callback = async (previous, current, done): Promise<void> => {
                const whiteboardStatus = this.getStatus(AtomPlayerSource.Whiteboard).current;
                const videoStatus = this.getStatus(AtomPlayerSource.Video).current;

                const flag = !this.shouldCrash(videoStatus, whiteboardStatus);

                if (flag) {
                    if (cb) {
                        await cb({
                            previous,
                            current,
                        });
                    }

                    this.statusIgnoreCrashByDisabled = [];
                    // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
                    this.statusIgnoreCrashByDisabledCallback = () => Promise.resolve();
                    done();
                    resolve();
                } else {
                    reject(new Error(ACCIDENT_ENTERED_DISABLED));
                }
            };

            this.statusIgnoreCrashByDisabledCallback = callback;

            this.events.one(CombinePlayerStatus.Disabled, callback);
        });
    }

    /**
     * 取消对合法 Disable 状态的监听
     * 因为某些合法 Disable 状态监听，是为了处理极端情况而出现的，在大部分的使用场景中，是不会触发的
     */
    public cancelOneButNotCrashByDisabled(): void {
        this.events.removeListener(
            CombinePlayerStatus.Disabled,
            this.statusIgnoreCrashByDisabledCallback,
        );
        this.statusIgnoreCrashByDisabled = [];
        // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
        this.statusIgnoreCrashByDisabledCallback = () => Promise.resolve();
    }

    /**
     * 监听组合状态变更回调
     * @param {CombinePlayerStatus} eventName - 需要监听的组合状态名
     * @param {OnStatusUpdate} cb - 事件回调
     */
    public on(eventName: CombinePlayerStatus, cb: OnStatusUpdate): Promise<void> {
        return new Promise((resolve, reject) => {
            this.events.addListener(eventName, async (previous, current, done) => {
                try {
                    await cb({
                        previous,
                        current,
                    });
                    resolve();
                } catch (err) {
                    reject(err);
                } finally {
                    done();
                }
            });
        });
    }

    /**
     * 解除监听器
     * @param {CombinePlayerStatus | CombinePlayerStatus[]} eventName - 需要取消监听的组合状态名
     */
    public off(eventName: CombinePlayerStatus | CombinePlayerStatus[]): void {
        if (typeof eventName === "string") {
            this.events.removeAllListener(eventName);
        } else {
            for (let i = 0; i < eventName.length; i++) {
                this.events.removeAllListener(eventName[i]);
            }
        }
    }

    /**
     * 销毁整个 event 事件
     */
    public destroy(): void {
        this.events.destroy();
        this.unlockCombineStatus();
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

        const tableData = this.table[whiteboardStatusIndex][videoStatusIndex];

        // 如果当前设置了 lock，则只有在 允许状态列表里，才会运行相关的组合状态回调
        // 当不在 解锁状态列表里，是不会运行任何的组合状态回调
        if (this.statusLockInfo.isLocked) {
            if (this.statusLockInfo.allowStatusList.includes(tableData.combineStatus)) {
                // 当符合条件时解锁
                if (this.statusLockInfo.unLockStatusList.includes(tableData.combineStatus)) {
                    this.unlockCombineStatus();
                }

                this.dispatchEvent(tableData);
            }
        } else {
            this.dispatchEvent(tableData);
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
            case AtomPlayerSource.Video: {
                return {
                    previous: this.videoStatus.previous,
                    current: this.videoStatus.current,
                };
            }
            case AtomPlayerSource.Whiteboard: {
                return {
                    previous: this.whiteboardStatus.previous,
                    current: this.whiteboardStatus.current,
                };
            }
        }
    }

    private shouldCrash(
        videoStatus: AtomPlayerStatus,
        whiteboardStatus: AtomPlayerStatus,
    ): boolean {
        let foundAnyStatusMatches = false;

        for (const { video, whiteboard } of this.statusIgnoreCrashByDisabled) {
            if (whiteboardStatus === whiteboard && video === videoStatus) {
                foundAnyStatusMatches = true;
                break;
            }
        }

        return !foundAnyStatusMatches;
    }

    /**
     * 关闭 状态锁
     */
    private unlockCombineStatus(): void {
        this.statusLockInfo.isLocked = false;
        this.statusLockInfo.allowStatusList = [];
        this.statusLockInfo.unLockStatusList = [];
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
    private dispatchEvent(tableData: TableData): void {
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

        const done = (): void => {
            this.setPreviousStatus(whiteboardStatus, videoStatus);
        };

        this.events.emit(combineStatus, previous, current, done);
    }

    /**
     * 初始化二维表格
     * @private
     */
    private initTables(): Table {
        /**
         * 这里使用柯里化进行封装，是为了代码美观。实际上是没有意义的
         * @param {CombinePlayerStatus} combineStatus - 组合状态
         */
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

type Table = readonly (readonly TableData[])[];

type TableData = {
    readonly combineStatus: CombinePlayerStatus;
    readonly whiteboardStatus: AtomPlayerStatus;
    readonly videoStatus: AtomPlayerStatus;
};

type GenerateTable = (whiteboard: AtomPlayerStatus, video: AtomPlayerStatus) => TableData;

type OnStatusUpdate = ({
    previous,
    current,
}: {
    previous: AtomPlayerStatusPair;
    current: AtomPlayerStatusPair;
}) => Promise<void>;

type Callback = (
    previous: AtomPlayerStatusPair,
    current: AtomPlayerStatusPair,
    done: AnyFunction,
) => Promise<void>;
