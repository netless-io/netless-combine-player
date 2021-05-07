import { VideoJsPlayer } from "video.js";
import { Player } from "white-web-sdk";
import {
    AnyFunction,
    AtomPlayerStatusCompose,
    CombinePlayer,
    StatusChangeHandle,
    TimeDuration,
    VideoOptions,
} from "./Types";
import { StateMachine } from "./StateMachine";
import {
    AtomPlayerSource,
    AtomPlayerStatus,
    CombinePlayerStatus,
    PublicCombinedStatus,
    TriggerSource,
    VideoReadyState,
} from "./StatusContant";
import { EventEmitter } from "./EventEmitter";
import { TaskQueue } from "./TaskQueue";
import {
    ACCIDENT_ENTERED_DISABLED,
    COMBINE_PLAYER_DID_CRASH,
    COMBINE_PLAYER_DID_STOP,
} from "./ErrorConstant";

export class CombinePlayerImplement implements CombinePlayer {
    private readonly video: VideoJsPlayer;
    private readonly whiteboard: Player;
    private readonly videoOptions: VideoOptions;
    private readonly stateMachine: StateMachine;

    private _playbackRate: number = 1;

    private seekTime: number = NaN;

    private triggerSource: TriggerSource = TriggerSource.None;

    private currentCombineStatus: PublicCombinedStatus = PublicCombinedStatus.PauseBuffering;

    private readonly whiteboardEmitter: EventEmitter;
    private readonly taskQueue: TaskQueue = new TaskQueue();

    private onStatusChangeHandleList: StatusChangeHandle[] = [];

    /**
     * 实例化 Combine-Player 插件
     * @param {Config} config - 实例化配置项
     */
    public constructor(config: Config) {
        const { videoConfig, whiteboard, whiteboardEmitter, debug } = config;
        this.videoOptions = videoConfig.videoOptions;
        this.video = videoConfig.video;
        this.whiteboard = whiteboard;
        this.whiteboardEmitter = whiteboardEmitter;

        this.stateMachine = new StateMachine(debug);

        void this.initOnCrashByDisabledStatusCallback();
        this.initVideo(videoConfig.isCanplay);
        this.initWhiteboard();
    }

    /**
     * 状态通知监听
     * @param {StatusChangeHandle} cb - 状态发生回调
     */
    public setOnStatusChange(cb: StatusChangeHandle): void {
        this.onStatusChangeHandleList.push(cb);
    }

    /**
     * 移除指定的状态通知回调
     * @param {StatusChangeHandle} cb - 要移除的状态通知回调
     */
    public removeStatusChange(cb: StatusChangeHandle): void {
        this.onStatusChangeHandleList = this.onStatusChangeHandleList.filter(fn => {
            return fn !== cb;
        });
    }

    /**
     * 移除所有的状态通知回调
     */
    public removeAllStatusChange(): void {
        this.onStatusChangeHandleList = [];
    }

    /**
     * 方便用户主动获取当前的状态
     * @deprecated Use combinedStatus
     * 此方法在 2.0.0 版本删除
     */
    public getStatus(): PublicCombinedStatus {
        return this.combinedStatus;
    }

    public get combinedStatus(): PublicCombinedStatus {
        return this.currentCombineStatus;
    }

    /**
     * @deprecated Use playbackRate
     * 此方法在 2.0.0 版本删除
     */
    public playbackSpeed(rate: number): void {
        this.playbackRate = rate;
    }

    public set playbackRate(rate: number) {
        if (this.isNotResponse()) {
            return;
        }

        this._playbackRate = rate;
        this.whiteboard.playbackSpeed = rate;
        this.video.playbackRate(rate);
    }

    public get playbackRate(): number {
        return this._playbackRate;
    }

    public get timeDuration(): TimeDuration {
        const { video, whiteboard } = this.getPlayerDuration();
        return {
            duration: Math.min(video, whiteboard),
            video,
            whiteboard,
        };
    }

    public stop(): void {
        if (this.currentCombineStatus === PublicCombinedStatus.Stopped) {
            throw new Error(COMBINE_PLAYER_DID_STOP);
        }

        if (this.currentCombineStatus === PublicCombinedStatus.Disabled) {
            throw new Error(COMBINE_PLAYER_DID_CRASH);
        }

        this.releaseEvents();
        this.onStatusUpdate(PublicCombinedStatus.Stopped);
    }

    /**
     * 插件的播放处理
     */
    public async play(): Promise<void> {
        if (this.isNotResponse()) {
            return;
        }

        await this.taskQueue.append(
            async (): Promise<void> => {
                this.triggerSource = TriggerSource.Plugin;

                const videoCanAutoPlay = await this.checkVideoAutoPlay();
                if (!videoCanAutoPlay) {
                    console.error("[Combine-Player]: does not support auto play");
                    this.triggerSource = TriggerSource.None;
                    return;
                }

                const currentCombinedStatus = this.stateMachine.getCombinationStatus().current;

                switch (currentCombinedStatus) {
                    case CombinePlayerStatus.Pause: {
                        await this.playWhenPause();
                        break;
                    }
                    case CombinePlayerStatus.PauseBuffering: {
                        const videoStatus = this.stateMachine.getStatus(AtomPlayerSource.Video)
                            .current;
                        const whiteboardStatus = this.stateMachine.getStatus(
                            AtomPlayerSource.Whiteboard,
                        ).current;

                        if (
                            videoStatus === AtomPlayerStatus.Pause &&
                            whiteboardStatus === AtomPlayerStatus.PauseBuffering
                        ) {
                            await this.playWhenVideoIsPauseAndWhiteboardIsPauseBuffering();
                        } else if (
                            videoStatus === AtomPlayerStatus.PauseBuffering &&
                            whiteboardStatus === AtomPlayerStatus.Pause
                        ) {
                            // 其内部处理逻辑一致，所以直接使用 playWhenPause 方法处理
                            this.onStatusUpdate(PublicCombinedStatus.PlayingBuffering);
                            await this.playWhenPause();
                        } else {
                            await this.playWhenAllPlayerIsPauseBuffering();
                        }
                        break;
                    }
                    case CombinePlayerStatus.Ended: {
                        await this.playWhenEnded();
                        break;
                    }
                }

                if (!isNaN(this.seekTime)) {
                    await this.seekWhenPlaying(this.seekTime);
                    this.seekTime = NaN;
                }

                this.triggerSource = TriggerSource.None;
            },
        );
    }

    /**
     * 插件的暂停处理
     */
    public async pause(): Promise<void> {
        if (this.isNotResponse()) {
            return;
        }

        return this.taskQueue.append(
            async (): Promise<void> => {
                this.triggerSource = TriggerSource.Plugin;

                const currentCombinedStatus = this.stateMachine.getCombinationStatus().current;
                if (currentCombinedStatus === CombinePlayerStatus.Playing) {
                    await this.pauseWhenPlaying();
                }

                this.triggerSource = TriggerSource.None;
            },
        );
    }

    /**
     * 用户调用 seek 时的处理
     */
    public async seek(ms: number): Promise<void> {
        if (this.isNotResponse()) {
            return;
        }

        return this.taskQueue.append(
            async (): Promise<void> => {
                const whiteboardProgressTime = this.whiteboard.progressTime;
                const videoProgressTime = this.video.currentTime();

                // 当 两端的进度都 0 时，不进行 seek，留到下次用户调用 play 的时候 seek
                if (whiteboardProgressTime === 0 && videoProgressTime === 0) {
                    if (ms !== 0) {
                        this.seekTime = ms;
                    }
                    return;
                }

                this.triggerSource = TriggerSource.Plugin;

                const currentCombinedStatus = this.stateMachine.getCombinationStatus().current;

                switch (currentCombinedStatus) {
                    case CombinePlayerStatus.Playing: {
                        await this.seekWhenPlaying(ms);
                        break;
                    }
                    case CombinePlayerStatus.Pause:
                    case CombinePlayerStatus.PauseBuffering: {
                        const playerDuration = this.getPlayerDuration();
                        const { video, whiteboard } = playerDuration;
                        if (ms > video || ms > whiteboard) {
                            await this.seekWhenPauseFinallyIsEnded(ms, playerDuration);
                        } else {
                            await this.seekWhenPause(ms);
                        }

                        break;
                    }
                    case CombinePlayerStatus.Ended: {
                        const { video, whiteboard } = this.getPlayerDuration();
                        if (ms <= video && ms <= whiteboard) {
                            await this.seekWhenPause(ms);
                            await this.playWhenPause();
                        }

                        break;
                    }
                }

                this.triggerSource = TriggerSource.None;
            },
        );
    }

    /**
     * 对 video.js 的状态做出处理，以及添加 事件监听
     * @param {boolean} isCanplay - 当前 video 的状态，是否可以播放
     * @private
     */
    private initVideo(isCanplay: boolean): void {
        this.stateMachine.setStatus(
            AtomPlayerSource.Video,
            isCanplay ? AtomPlayerStatus.Pause : AtomPlayerStatus.PauseBuffering,
        );

        if (!isCanplay) {
            this.currentCombineStatus = PublicCombinedStatus.PauseBuffering;
        }

        this.initVideoJSEvents();
    }

    /**
     * 初始化 video.js 的监听事件
     * @private
     */
    private initVideoJSEvents(): void {
        let isDropFrame = false;

        /**
         * 中间处理件，判断当前回调是否应该调用真正的回调
         * @param cb
         */
        const warp = (cb: AnyFunction): AnyFunction => {
            return async (): Promise<void> => {
                // 如果当前是事件是由用户手动触发，则跳过。不做处理
                if (
                    this.triggerSource === TriggerSource.None ||
                    this.triggerSource === TriggerSource.Video
                ) {
                    this.triggerSource = TriggerSource.Video;
                    await cb();
                }
            };
        };

        this.video.on("canplay", (): void => {
            const whiteboardStatus = this.stateMachine.getStatus(AtomPlayerSource.Whiteboard)
                .current;
            const videoStatus = this.stateMachine.getStatus(AtomPlayerSource.Video).current;

            // 如果当前 video 处于 PauseBuffering 状态，则通知状态机，加载完成。改为 Pause 状态
            if (videoStatus === AtomPlayerStatus.PauseBuffering) {
                this.stateMachine.setStatus(AtomPlayerSource.Video, AtomPlayerStatus.Pause);

                if (whiteboardStatus === AtomPlayerStatus.Pause) {
                    this.onStatusUpdate(PublicCombinedStatus.Pause);
                }
            }
        });

        // 能触发此事件的，只有 video 丢帧时，会被触发。
        this.video.on(
            "seeking",
            warp(
                async (): Promise<void> => {
                    await this.taskQueue.append(() => {
                        isDropFrame = true;
                    });
                },
            ),
        );

        this.video.on(
            "waiting",
            warp(
                async (): Promise<void> => {
                    this.onStatusUpdate(PublicCombinedStatus.PlayingBuffering);
                    await this.taskQueue.append(
                        (): Promise<void> => {
                            return this.pauseWhiteboardWhenVideoWaiting();
                        },
                    );
                    this.triggerSource = TriggerSource.None;
                },
            ),
        );

        this.video.on(
            "playing",
            warp(
                async (): Promise<void> => {
                    await this.taskQueue.append(
                        async (): Promise<AtomPlayerStatusCompose | void> => {
                            if (isDropFrame) {
                                return this.playingWhiteboardWhenVideoPlayingDropFrame();
                            }

                            return this.playingWhiteboardWhenVideoPlaying();
                        },
                    );

                    isDropFrame = false;
                    this.triggerSource = TriggerSource.None;
                },
            ),
        );

        this.video.on(
            "ended",
            warp(
                async (): Promise<void> => {
                    await this.taskQueue.append(
                        (): Promise<void> => {
                            return this.pauseWhiteboardWhenVideoEnded();
                        },
                    );
                    this.triggerSource = TriggerSource.None;
                },
            ),
        );

        // 在 iOS Safari 中，如果 video 退出了全屏，则会自动暂停，导致影响到程序的正常逻辑，这里为 patch 代码
        this.video.on(
            "fullscreenchange",
            warp(
                async (): Promise<void> => {
                    await this.taskQueue.append((): void => {
                        const { current } = this.stateMachine.getStatus(AtomPlayerSource.Video);

                        // 只对 video 在 playing 或者 playingBuffering 状态时做出处理
                        if (
                            current === AtomPlayerStatus.Playing ||
                            current === AtomPlayerStatus.PlayingBuffering
                        ) {
                            // 如果当前是退出全屏，且暂停状态是由 iOS Safari 触发的
                            // 这里为了保持和 iOS Safari 行为一致，把两端都进行暂停。因为在这里触发 play 是没有用的，需要等待几百毫秒才可以。
                            // 这里暂停后，可以让用户手动点击 播放按钮，进行播放，在这期间其时间差已经超过了 1s，所以再去点击播放的时候，就没有问题了
                            if (!this.video.isFullscreen() && this.video.paused()) {
                                this.whiteboardEmitter.one("pause", () => {
                                    this.stateMachine.setStatus(
                                        AtomPlayerSource.Whiteboard,
                                        AtomPlayerStatus.Pause,
                                    );
                                    this.stateMachine.setStatus(
                                        AtomPlayerSource.Video,
                                        AtomPlayerStatus.Pause,
                                    );

                                    this.onStatusUpdate(PublicCombinedStatus.Pause);
                                });

                                this.whiteboard.pause();
                            }
                        }

                        this.triggerSource = TriggerSource.None;
                    });
                },
            ),
        );
    }

    /**
     * 对 whiteboard 状态做出处理，以及增加事件监听
     */
    private initWhiteboard(): void {
        this.initWhiteboardIsPlayable();
        this.initWhiteboardEvents();

        // 这里 提前进行了状态机改变，因为回放在 seek 时，不会触发 Buffering 事件，所以在这里需要提前设置。以保证状态正确
        this.stateMachine.setStatus(AtomPlayerSource.Whiteboard, AtomPlayerStatus.PauseBuffering);
        this.currentCombineStatus = PublicCombinedStatus.PauseBuffering;
        // 先seek到第一帧，以拿到 whiteboard 的状态。否则 whiteboard 会永远在 waitingFirstFrame 状态，isPlayable 也会一直是 false
        this.whiteboard.seekToProgressTime(0);
    }

    /**
     * 设置 回放 的 isPlayable 事件
     */
    private initWhiteboardIsPlayable(): void {
        this.whiteboardEmitter.addListener("playableChange", (isPlayable: boolean): void => {
            const whiteboardStatus = this.stateMachine.getStatus(AtomPlayerSource.Whiteboard)
                .current;
            const videoStatus = this.stateMachine.getStatus(AtomPlayerSource.Video).current;

            // 当 当前回放确认已经加载好了，并且当前 回放 的状态为 PauseBuffering 时，就可以把 回放 的状态修改为 Pause 状态了
            if (isPlayable && whiteboardStatus === AtomPlayerStatus.PauseBuffering) {
                this.stateMachine.setStatus(AtomPlayerSource.Whiteboard, AtomPlayerStatus.Pause);
                if (videoStatus === AtomPlayerStatus.Pause) {
                    this.onStatusUpdate(PublicCombinedStatus.Pause);
                }
            }
        });
    }

    private initWhiteboardEvents(): void {
        /**
         * 中间处理件，判断当前回调是否应该调用真正的回调
         * @param cb
         */
        const warp = (cb: AnyFunction): AnyFunction => {
            return async (): Promise<void> => {
                // 如果当前是事件是由用户手动触发，则跳过。不做处理
                if (
                    this.triggerSource === TriggerSource.None ||
                    this.triggerSource === TriggerSource.Whiteboard
                ) {
                    this.triggerSource = TriggerSource.Whiteboard;
                    await cb();
                    this.triggerSource = TriggerSource.None;
                }
            };
        };

        this.whiteboardEmitter.addListener(
            "buffering",
            warp(
                async (): Promise<void> => {
                    await this.taskQueue.append(
                        (): Promise<void> => {
                            return this.pauseVideoWhenWhiteboardBuffering();
                        },
                    );
                },
            ),
        );

        this.whiteboardEmitter.addListener(
            "playing",
            warp(
                async (): Promise<void> => {
                    await this.taskQueue.append(
                        (): Promise<void> => {
                            return this.playingVideoWhenWhiteboardPlaying();
                        },
                    );
                },
            ),
        );

        this.whiteboardEmitter.addListener(
            "ended",
            warp(
                async (): Promise<void> => {
                    await this.taskQueue.append(
                        (): Promise<void> => {
                            return this.pauseVideoWhenWhiteboardEnded();
                        },
                    );
                },
            ),
        );
    }

    /**
     * 在暂停状态下，用户调用播放时的处理
     * @private
     */
    private async playWhenPause(): Promise<void> {
        this.stateMachine.lockCombineStatus(
            [CombinePlayerStatus.ToPlay, CombinePlayerStatus.Playing],
            [CombinePlayerStatus.Playing],
        );

        const videoOnPlaying = (): void => {
            this.stateMachine.setStatus(AtomPlayerSource.Video, AtomPlayerStatus.Playing);
        };

        const whiteboardOnPlaying = (): void => {
            this.stateMachine.setStatus(AtomPlayerSource.Whiteboard, AtomPlayerStatus.Playing);
        };

        this.whiteboardEmitter.one("playing", whiteboardOnPlaying);

        const combinePlayerStatusWhenToPlay = this.stateMachine.one(
            CombinePlayerStatus.ToPlay,
            async () => {
                this.whiteboard.play();
            },
        );

        const combinePlayerStatusWhenToPlaying = this.stateMachine.one(
            CombinePlayerStatus.Playing,
            async () => {
                this.onStatusUpdate(PublicCombinedStatus.Playing);
            },
        );

        this.video.one("playing", videoOnPlaying);

        this.video.play();

        await Promise.all([combinePlayerStatusWhenToPlay, combinePlayerStatusWhenToPlaying]);
    }

    private async playWhenVideoIsPauseAndWhiteboardIsPauseBuffering(): Promise<void> {
        this.stateMachine.lockCombineStatus(
            [
                CombinePlayerStatus.Disabled,
                CombinePlayerStatus.Pause,
                CombinePlayerStatus.PauseBuffering,
                CombinePlayerStatus.ToPlay,
                CombinePlayerStatus.Playing,
            ],
            [CombinePlayerStatus.Playing],
        );

        const videoOnPlaying = (): void => {
            this.stateMachine.setStatus(AtomPlayerSource.Video, AtomPlayerStatus.Playing);
        };

        const videoOnPause = (): void => {
            this.stateMachine.setStatus(AtomPlayerSource.Video, AtomPlayerStatus.Pause);
        };

        const whiteboardOnBuffering = (): void => {
            this.stateMachine.setStatus(
                AtomPlayerSource.Whiteboard,
                AtomPlayerStatus.PlayingBuffering,
            );
        };

        const whiteboardOnPlaying = (): void => {
            this.stateMachine.setStatus(AtomPlayerSource.Whiteboard, AtomPlayerStatus.Playing);
        };

        const clearVideoAndWhiteboardEvents = (): void => {
            this.whiteboardEmitter.removeListener("playing", whiteboardOnPlaying);
            this.whiteboardEmitter.removeListener("buffering", whiteboardOnBuffering);
            this.video.off("playing", videoOnPlaying);
            this.video.off("pause", videoOnPause);
        };

        this.stateMachine
            .oneButNotCrashByDisabled(
                [
                    {
                        video: AtomPlayerStatus.Playing,
                        whiteboard: AtomPlayerStatus.PauseBuffering,
                    },
                ],
                async (): Promise<void> => {
                    this.video.pause();
                },
            )
            .catch(e => {
                throw Error(e);
            });

        const combinePlayerStatusWhenPauseBuffering = this.stateMachine.one(
            CombinePlayerStatus.PauseBuffering,
            async () => {
                this.whiteboard.play();
            },
        );

        const combinePlayerStatusWhenPause = this.stateMachine.one(
            CombinePlayerStatus.Pause,
            async () => {
                this.whiteboard.play();
            },
        );

        const combinePlayerStatusWhenToPlay = this.stateMachine.one(
            CombinePlayerStatus.ToPlay,
            async () => {
                this.video.play();
            },
        );

        const combinePlayerStatusWhenToPlaying = this.stateMachine.one(
            CombinePlayerStatus.Playing,
            async () => {
                this.onStatusUpdate(PublicCombinedStatus.Playing);
                this.stateMachine.off([
                    CombinePlayerStatus.PauseBuffering,
                    CombinePlayerStatus.Pause,
                    CombinePlayerStatus.ToPlay,
                ]);
                clearVideoAndWhiteboardEvents();
            },
        );

        this.whiteboardEmitter.one("buffering", whiteboardOnBuffering);

        this.whiteboardEmitter.one("playing", whiteboardOnPlaying);

        this.video.on("playing", videoOnPlaying);

        this.video.one("pause", videoOnPause);

        this.video.play();

        await Promise.all([
            Promise.race([combinePlayerStatusWhenPauseBuffering, combinePlayerStatusWhenPause]),
            combinePlayerStatusWhenToPlay,
            combinePlayerStatusWhenToPlaying,
        ]);
    }

    private async playWhenAllPlayerIsPauseBuffering(): Promise<void> {
        this.stateMachine.lockCombineStatus(
            [
                CombinePlayerStatus.Disabled,
                CombinePlayerStatus.ToPause,
                CombinePlayerStatus.ToPlay,
                CombinePlayerStatus.Playing,
            ],
            [CombinePlayerStatus.Playing],
        );

        const whiteboardOnBuffering = (): void => {
            this.stateMachine.setStatus(
                AtomPlayerSource.Whiteboard,
                AtomPlayerStatus.PlayingBuffering,
            );
        };

        const whiteboardOnPlaying = (): void => {
            this.stateMachine.setStatus(AtomPlayerSource.Whiteboard, AtomPlayerStatus.Playing);
        };

        const whiteboardOnPause = (): void => {
            this.stateMachine.setStatus(AtomPlayerSource.Whiteboard, AtomPlayerStatus.Pause);
        };

        const videoOnPlaying = (): void => {
            this.stateMachine.setStatus(AtomPlayerSource.Video, AtomPlayerStatus.Playing);
        };

        const videoOnPlay = (): void => {
            this.stateMachine.setStatus(AtomPlayerSource.Video, AtomPlayerStatus.PlayingBuffering);
        };

        const videoOnPause = (): void => {
            this.stateMachine.setStatus(AtomPlayerSource.Video, AtomPlayerStatus.Pause);
        };

        this.stateMachine
            .oneButNotCrashByDisabled(
                [
                    {
                        video: AtomPlayerStatus.PlayingBuffering,
                        whiteboard: AtomPlayerStatus.PauseBuffering,
                    },
                    {
                        video: AtomPlayerStatus.PauseBuffering,
                        whiteboard: AtomPlayerStatus.PlayingBuffering,
                    },
                ],
                async (): Promise<void> => {
                    this.stateMachine
                        .oneButNotCrashByDisabled(
                            [
                                {
                                    video: AtomPlayerStatus.Playing,
                                    whiteboard: AtomPlayerStatus.PauseBuffering,
                                },
                                {
                                    video: AtomPlayerStatus.PauseBuffering,
                                    whiteboard: AtomPlayerStatus.Playing,
                                },
                            ],
                            async ({ current }): Promise<void> => {
                                // 这里是因为有可能存在，有一端已经开始播放了，但是另一端还在 pauseBuffering 状态。所以需要把播放的一端进行暂停
                                if (current.video === AtomPlayerStatus.Playing) {
                                    this.video.pause();
                                } else if (current.whiteboard === AtomPlayerStatus.Playing) {
                                    this.whiteboard.pause();
                                }
                            },
                        )
                        .catch(e => {
                            throw Error(e);
                        });
                },
            )
            .catch(e => {
                throw Error(e);
            });

        const combinePlayerStatusWhenToPause = this.stateMachine.one(
            CombinePlayerStatus.ToPause,
            async ({ current }) => {
                if (current.video === AtomPlayerStatus.Playing) {
                    this.video.pause();
                } else {
                    this.whiteboard.pause();
                }
            },
        );

        const combinePlayerStatusWhenToPlay = this.stateMachine.one(
            CombinePlayerStatus.ToPlay,
            async ({ current }) => {
                if (current.video === AtomPlayerStatus.Playing) {
                    this.whiteboard.play();
                } else {
                    this.video.play();
                }
            },
        );

        const combinePlayerStatusWhenPlaying = this.stateMachine.one(
            CombinePlayerStatus.Playing,
            async () => {
                this.onStatusUpdate(PublicCombinedStatus.Playing);
                this.stateMachine.cancelOneButNotCrashByDisabled();
                this.stateMachine.off([CombinePlayerStatus.ToPause, CombinePlayerStatus.ToPlay]);
                this.video.off("playing", videoOnPlaying);
                this.whiteboardEmitter.removeListener("playing", whiteboardOnPlaying);
                this.whiteboardEmitter.removeListener("pause", whiteboardOnPause);
            },
        );

        this.whiteboardEmitter.one("buffering", whiteboardOnBuffering);

        this.whiteboardEmitter.addListener("playing", whiteboardOnPlaying);

        this.whiteboardEmitter.one("pause", whiteboardOnPause);

        this.video.on("playing", videoOnPlaying);

        this.video.one("play", videoOnPlay);

        this.video.one("pause", videoOnPause);

        this.video.play();
        this.whiteboard.play();

        await Promise.all([
            Promise.race([combinePlayerStatusWhenToPause, combinePlayerStatusWhenToPlay]),
            combinePlayerStatusWhenPlaying,
        ]);
    }

    /**
     * 在 ended 状态下，用户调用播放时的处理
     * @private
     */
    private async playWhenEnded(): Promise<void> {
        this.onStatusUpdate(PublicCombinedStatus.PlayingBuffering);

        let videoIsCanplayIntervalID = NaN;

        this.stateMachine.lockCombineStatus(
            [CombinePlayerStatus.Pause],
            [CombinePlayerStatus.Pause],
        );

        const whiteboardOnBuffering = (): void => {
            this.stateMachine.setStatus(AtomPlayerSource.Whiteboard, AtomPlayerStatus.PauseSeeking);
        };

        const whiteboardOnPause = (): void => {
            this.stateMachine.setStatus(AtomPlayerSource.Whiteboard, AtomPlayerStatus.Pause);
        };

        const whiteboardOnPlaying = (): void => {
            this.whiteboard.pause();
        };

        const videoOnSeeked = (): void => {
            this.video.off("pause", videoOnPause);
            this.video.off("play", videoOnPlay);

            this.video.one("play", () => {
                this.video.one("pause", () => {
                    this.stateMachine.setStatus(AtomPlayerSource.Video, AtomPlayerStatus.Pause);
                });

                this.video.pause();
            });

            // 这也是 iOS Video 的 bug，当在 seeked 事件后去调用 play 时，video 事件是正确的，但是 video 却不会播放
            // 需要先进行一次 play，然后再 pause，后面再去 play 时，就可以让 video 播放了
            this.video.play();
        };

        // 这是 iOS Video 的 bug，在 ended 情况下进行 seek，是不会触发 seeked 事件的。
        // 通过此方法和 videoOnPlay 形成的一个闭环，反复 play / pause，来让 seeked 事件显示出来
        const videoOnPause = (): void => {
            this.video.play();
        };

        const videoOnPlay = (): void => {
            this.video.pause();
        };

        const videoOnSeeking = (): void => {
            this.stateMachine.setStatus(AtomPlayerSource.Video, AtomPlayerStatus.PauseSeeking);

            videoIsCanplayIntervalID = window.setInterval(() => {
                if (this.video.readyState() >= VideoReadyState.HAVE_CURRENT_DATA) {
                    clearInterval(videoIsCanplayIntervalID);

                    this.video.one("playing", () => {
                        this.video.pause();
                    });
                    this.video.play();
                }
            }, 500);
        };

        const combinePlayerStatusWhenPause = this.stateMachine.one(
            CombinePlayerStatus.Pause,
            async () => {
                clearInterval(videoIsCanplayIntervalID);
                this.whiteboardEmitter.removeListener("buffering", whiteboardOnBuffering);
                this.whiteboardEmitter.removeListener("playing", whiteboardOnPlaying);
                this.whiteboardEmitter.removeListener("pause", whiteboardOnPause);
                this.video.off("seeking", videoOnSeeking);
                this.video.off("seeked", videoOnSeeked);
                this.video.off("play", videoOnPlay);
                this.video.off("pause", videoOnPause);
                await this.playWhenPause();
            },
        );

        this.whiteboardEmitter.one("buffering", whiteboardOnBuffering);
        this.whiteboardEmitter.one("pause", whiteboardOnPause);
        this.whiteboardEmitter.one("playing", whiteboardOnPlaying);

        this.video.one("seeking", videoOnSeeking);
        this.video.one("seeked", videoOnSeeked);
        this.video.on("play", videoOnPlay);
        this.video.on("pause", videoOnPause);

        this.whiteboard.seekToProgressTime(0);
        this.video.currentTime(0);

        await combinePlayerStatusWhenPause;
    }

    /**
     * 在 playing 状态下，用户调用暂停时的处理
     * @private
     */
    private async pauseWhenPlaying(): Promise<void> {
        this.stateMachine.lockCombineStatus(
            [CombinePlayerStatus.Pause],
            [CombinePlayerStatus.Pause],
        );

        const whiteboardOnPause = (): void => {
            this.stateMachine.setStatus(AtomPlayerSource.Whiteboard, AtomPlayerStatus.Pause);
        };

        const videoOnPause = (): void => {
            this.stateMachine.setStatus(AtomPlayerSource.Video, AtomPlayerStatus.Pause);
        };

        const combinePlayerStatusWhenPause = this.stateMachine.one(
            CombinePlayerStatus.Pause,
            async () => {
                this.onStatusUpdate(PublicCombinedStatus.Pause);
            },
        );

        this.whiteboardEmitter.one("pause", whiteboardOnPause);

        this.video.one("pause", videoOnPause);

        this.whiteboard.pause();
        this.video.pause();

        await combinePlayerStatusWhenPause;
    }

    /**
     * 当在 playing 阶段时，用户调用 seek 时的处理
     * @param {number} ms - 将要 seek 到的时间点
     * @private
     */
    private async seekWhenPlaying(ms: number): Promise<void> {
        this.onStatusUpdate(PublicCombinedStatus.PlayingSeeking);

        let videoIsCanplayIntervalID = NaN;

        const playerDuration = this.getPlayerDuration();

        this.stateMachine.lockCombineStatus(
            [
                CombinePlayerStatus.Pause,
                CombinePlayerStatus.Ended,
                CombinePlayerStatus.PlayingSeeking,
            ],
            [CombinePlayerStatus.Pause, CombinePlayerStatus.Ended],
        );

        const whiteboardOnBuffering = (): void => {
            this.stateMachine.setStatus(
                AtomPlayerSource.Whiteboard,
                AtomPlayerStatus.PlayingSeeking,
            );
        };

        const whiteboardOnPause = (): void => {
            if (ms < playerDuration.whiteboard) {
                this.stateMachine.setStatus(AtomPlayerSource.Whiteboard, AtomPlayerStatus.Pause);
            }
        };

        const whiteboardOnPlaying = (): void => {
            this.whiteboard.pause();
        };

        const whiteboardOnEnded = (): void => {
            this.stateMachine.setStatus(AtomPlayerSource.Whiteboard, AtomPlayerStatus.Ended);
        };

        const videoOnSeeking = (): void => {
            this.stateMachine.setStatus(AtomPlayerSource.Video, AtomPlayerStatus.PlayingSeeking);

            // 这里使用 轮询的方式去检测当前是否处于 seeked 状态，因为在 iOS webview 容器内，当在 playing 状态进行 seek 时，是不会触发 seeked 事件的
            videoIsCanplayIntervalID = window.setInterval(() => {
                if (this.video.readyState() >= VideoReadyState.HAVE_CURRENT_DATA) {
                    clearInterval(videoIsCanplayIntervalID);
                    if (ms < playerDuration.video) {
                        this.video.pause();
                        this.stateMachine.setStatus(AtomPlayerSource.Video, AtomPlayerStatus.Pause);
                    } else {
                        this.stateMachine.setStatus(AtomPlayerSource.Video, AtomPlayerStatus.Ended);
                    }
                }
            }, 500);
        };

        const clearVideoAndWhiteboardEvents = (): void => {
            clearInterval(videoIsCanplayIntervalID);
            this.whiteboardEmitter.removeListener("buffering", whiteboardOnBuffering);
            this.whiteboardEmitter.removeListener("pause", whiteboardOnPause);
            this.whiteboardEmitter.removeListener("playing", whiteboardOnPlaying);
            this.whiteboardEmitter.removeListener("ended", whiteboardOnEnded);
            this.video.off("seeking", videoOnSeeking);
        };

        const combinePlayerStatusWhenPlayingSeeking = this.stateMachine.one(
            CombinePlayerStatus.PlayingSeeking,
            async ({ current }) => {
                const { video, whiteboard } = current;

                // 如果当前 seek 的时间没有超过 whiteboard，并且 当前 video 状态为 ended 时，才对 whiteboard 调用暂停。否则不需要
                if (video === AtomPlayerStatus.Ended && ms < playerDuration.whiteboard) {
                    this.whiteboard.pause();
                } else if (whiteboard === AtomPlayerStatus.Ended && ms < playerDuration.video) {
                    this.video.pause();
                }
            },
        );

        const combinePlayerStatusWhenPause = this.stateMachine.one(
            CombinePlayerStatus.Pause,
            async () => {
                this.stateMachine.off([CombinePlayerStatus.Ended]);
                clearVideoAndWhiteboardEvents();
                await this.playWhenPause();
            },
        );

        const combinePlayerStatusWhenEnded = this.stateMachine.one(
            CombinePlayerStatus.Ended,
            async () => {
                this.onStatusUpdate(PublicCombinedStatus.Ended);
                this.stateMachine.off([CombinePlayerStatus.Pause]);
                clearVideoAndWhiteboardEvents();
            },
        );

        this.video.one("seeking", videoOnSeeking);

        this.whiteboardEmitter.one("buffering", whiteboardOnBuffering);

        this.whiteboardEmitter.one("pause", whiteboardOnPause);

        this.whiteboardEmitter.one("playing", whiteboardOnPlaying);

        this.whiteboardEmitter.one("ended", whiteboardOnEnded);

        this.whiteboard.seekToProgressTime(ms);
        this.video.currentTime(ms / 1000);

        await Promise.all([
            combinePlayerStatusWhenPlayingSeeking,
            Promise.race([combinePlayerStatusWhenPause, combinePlayerStatusWhenEnded]),
        ]);
    }

    /**
     * 当在 pause 阶段时，用户调用 seek 时的处理
     * @param {number} ms - 将要 seek 到的时间点
     * @private
     */
    private async seekWhenPause(ms: number): Promise<void> {
        this.onStatusUpdate(PublicCombinedStatus.PauseSeeking);
        let videoIsCanplayIntervalID = NaN;

        this.stateMachine.lockCombineStatus(
            [CombinePlayerStatus.Disabled, CombinePlayerStatus.Pause],
            [CombinePlayerStatus.Pause],
        );

        const videoOnSeeking = (): void => {
            this.stateMachine.setStatus(AtomPlayerSource.Video, AtomPlayerStatus.PauseSeeking);

            // 这里使用 轮询的方式去检测当前是否处于 seeked 状态，因为在 iOS webview 容器内，当在 pause 状态进行 seek 时，是不会触发 seeked 事件的
            videoIsCanplayIntervalID = window.setInterval(() => {
                if (this.video.readyState() >= VideoReadyState.HAVE_CURRENT_DATA) {
                    clearInterval(videoIsCanplayIntervalID);
                    this.stateMachine.setStatus(AtomPlayerSource.Video, AtomPlayerStatus.Pause);
                }
            }, 500);
        };

        const whiteboardOnBuffering = (): void => {
            this.stateMachine.setStatus(AtomPlayerSource.Whiteboard, AtomPlayerStatus.PauseSeeking);
        };

        const whiteboardOnPause = (): void => {
            this.stateMachine.setStatus(AtomPlayerSource.Whiteboard, AtomPlayerStatus.Pause);
        };

        const whiteboardOnPlaying = (): void => {
            this.whiteboard.pause();
        };

        const clearVideoAndWhiteboardEvents = (): void => {
            clearInterval(videoIsCanplayIntervalID);
            this.video.off("seeking", videoOnSeeking);
            this.whiteboardEmitter.removeListener("buffering", whiteboardOnBuffering);
            this.whiteboardEmitter.removeListener("pause", whiteboardOnPause);
        };

        this.stateMachine
            .oneButNotCrashByDisabled([
                {
                    video: AtomPlayerStatus.PauseSeeking,
                    whiteboard: AtomPlayerStatus.PauseSeeking,
                },
            ])
            .catch(e => {
                throw Error(e);
            });

        const combinePlayerStatusWhenPause = this.stateMachine.one(
            CombinePlayerStatus.Pause,
            async (): Promise<void> => {
                this.onStatusUpdate(PublicCombinedStatus.Pause);
                this.stateMachine.cancelOneButNotCrashByDisabled();
                this.stateMachine.off(CombinePlayerStatus.Ended);
                this.whiteboardEmitter.removeListener("playing", whiteboardOnPlaying);
                clearVideoAndWhiteboardEvents();
            },
        );

        this.video.one("seeking", videoOnSeeking);

        this.whiteboardEmitter.one("buffering", whiteboardOnBuffering);

        // 如果 whiteboard 处于 Ended 状态时，进行 seek，seek 完成后会到达 playing 状态，所以这里需要对其做出额外判断
        this.whiteboardEmitter.one("playing", whiteboardOnPlaying);

        this.whiteboardEmitter.one("pause", whiteboardOnPause);

        this.whiteboard.seekToProgressTime(ms);
        this.video.currentTime(ms / 1000);

        await combinePlayerStatusWhenPause;
    }

    private async seekWhenPauseFinallyIsEnded(
        ms: number,
        playerDuration: PlayerDuration,
    ): Promise<void> {
        this.onStatusUpdate(PublicCombinedStatus.PauseSeeking);

        let videoIsCanplayIntervalID = NaN;
        this.stateMachine.lockCombineStatus(
            [CombinePlayerStatus.Disabled, CombinePlayerStatus.Ended],
            [CombinePlayerStatus.Ended],
        );

        const videoOnSeeking = (): void => {
            this.stateMachine.setStatus(AtomPlayerSource.Video, AtomPlayerStatus.PauseSeeking);

            // 这里使用 轮询的方式去检测当前是否处于 seeked 状态，因为在 iOS webview 容器内，当在 pause 状态进行 seek 时，是不会触发 seeked 事件的
            videoIsCanplayIntervalID = window.setInterval(() => {
                if (this.video.readyState() >= VideoReadyState.HAVE_CURRENT_DATA) {
                    clearInterval(videoIsCanplayIntervalID);
                    this.stateMachine.setStatus(AtomPlayerSource.Video, AtomPlayerStatus.Pause);

                    if (ms >= playerDuration.video) {
                        this.stateMachine.setStatus(AtomPlayerSource.Video, AtomPlayerStatus.Ended);
                    }
                }
            }, 500);
        };

        const whiteboardOnPause = (): void => {
            if (ms < playerDuration.whiteboard) {
                this.stateMachine.setStatus(AtomPlayerSource.Whiteboard, AtomPlayerStatus.Pause);
            }
        };

        const whiteboardOnBuffering = (): void => {
            this.stateMachine.setStatus(AtomPlayerSource.Whiteboard, AtomPlayerStatus.PauseSeeking);
        };

        const whiteboardOnEnded = (): void => {
            this.stateMachine.setStatus(AtomPlayerSource.Whiteboard, AtomPlayerStatus.Ended);
        };

        const clearVideoAndWhiteboardEvents = (): void => {
            clearInterval(videoIsCanplayIntervalID);
            this.video.off("seeking", videoOnSeeking);
            this.whiteboardEmitter.removeListener("buffering", whiteboardOnBuffering);
            this.whiteboardEmitter.removeListener("pause", whiteboardOnPause);
            this.whiteboardEmitter.removeListener("ended", whiteboardOnEnded);
        };

        this.stateMachine
            .oneButNotCrashByDisabled([
                {
                    video: AtomPlayerStatus.PauseSeeking,
                    whiteboard: AtomPlayerStatus.PauseSeeking,
                },
            ])
            .catch(e => {
                throw Error(e);
            });

        const combinePlayerStatusWhenEnded = this.stateMachine.on(
            CombinePlayerStatus.Ended,
            async (): Promise<void> => {
                this.onStatusUpdate(PublicCombinedStatus.Ended);
                this.stateMachine.cancelOneButNotCrashByDisabled();
                this.stateMachine.off([CombinePlayerStatus.Pause, CombinePlayerStatus.Ended]);
                clearVideoAndWhiteboardEvents();
            },
        );

        this.video.one("seeking", videoOnSeeking);

        this.whiteboardEmitter.one("buffering", whiteboardOnBuffering);

        this.whiteboardEmitter.one("pause", whiteboardOnPause);

        this.whiteboardEmitter.one("ended", whiteboardOnEnded);

        this.whiteboard.seekToProgressTime(ms);
        this.video.currentTime(ms / 1000);

        await combinePlayerStatusWhenEnded;
    }

    /**
     * 当 video 处于 waiting 状态，插件自动暂停白板的处理
     * @private
     */
    private async pauseWhiteboardWhenVideoWaiting(): Promise<void> {
        // 因为当 video 丢帧时，会触发多次的 waiting，而后面的 waiting 也会到达这里
        if (this.whiteboard.phase === "pause") {
            return;
        }

        const combinePlayerStatusWhenPlayingBuffering = this.stateMachine.one(
            CombinePlayerStatus.PlayingBuffering,
        );

        this.whiteboardEmitter.one("pause", (): void => {
            this.stateMachine.setStatus(AtomPlayerSource.Whiteboard, AtomPlayerStatus.Pause);
        });

        this.whiteboard.pause();

        this.stateMachine.setStatus(AtomPlayerSource.Video, AtomPlayerStatus.PlayingBuffering);

        await combinePlayerStatusWhenPlayingBuffering;
    }

    /**
     * 当 video 处于 playing 状态时，并且出现了丢帧。
     * @private
     */
    private playingWhiteboardWhenVideoPlayingDropFrame(): Promise<AtomPlayerStatusCompose> {
        // video 丢帧时的处理
        // 我们会先把 video 进行暂停，然后对 whiteboard 进行 seek 校准
        // 而 whiteboard seek 校准时，会触发: buffering -> pause(因为在调用此函数之前，我们是能够保证 whiteboard 一定是暂停状态，所以 whiteboard seek 完成后，就一定会回到 pause 状态)
        // 当 whiteboard 到达 pause 时(此时 video 也是处于 pause 状态)，我们就可以使用插件的 play 方法，来间接调用 playWhenPauseBuffering 方法，让其播放
        this.whiteboardEmitter.one("pause", (): void => {
            // 因为当我们对 whiteboard 进行 seek 后，如果后面调用播放，会先进入 buffering 阶段。所以这里设置 whiteboard 状态 为 pause-buffering 状态
            this.stateMachine.setStatus(
                AtomPlayerSource.Whiteboard,
                AtomPlayerStatus.PauseBuffering,
            );
        });

        const combinePlayerStatusWhenPauseBuffering = this.stateMachine.one(
            CombinePlayerStatus.PauseBuffering,
            async () => {
                // 往后的步骤交付给正常流程来执行，从现在起往后的操作不在属于 Video 名下
                this.triggerSource = TriggerSource.Plugin;
                return this.playWhenVideoIsPauseAndWhiteboardIsPauseBuffering();
            },
        );

        this.video.one("pause", (): void => {
            this.stateMachine.setStatus(AtomPlayerSource.Video, AtomPlayerStatus.Pause);
            this.whiteboard.seekToProgressTime(this.video.currentTime() * 1000);
        });

        this.video.pause();

        return combinePlayerStatusWhenPauseBuffering;
    }

    /**
     * 当 video 处于 playing 状态时，插件自动调用 video 的播放方法
     * @private
     */
    private async playingWhiteboardWhenVideoPlaying(): Promise<void> {
        // video 在播放状态时，由于网络问题，导致 video 需要缓冲。现缓存完毕，开始让 whiteboard 播放
        this.stateMachine.setStatus(AtomPlayerSource.Video, AtomPlayerStatus.Playing);

        const CombinePlayerStatusWhenPlaying = this.stateMachine.one(
            CombinePlayerStatus.Playing,
            async () => {
                this.onStatusUpdate(PublicCombinedStatus.Playing);
            },
        );

        this.whiteboardEmitter.one("playing", (): void => {
            this.stateMachine.setStatus(AtomPlayerSource.Whiteboard, AtomPlayerStatus.Playing);
        });

        this.whiteboard.play();

        await CombinePlayerStatusWhenPlaying;
    }

    /**
     * 当 whiteboard 为 buffering 时，插件自动调用 video 的 暂停方法
     * @private
     */
    private async pauseVideoWhenWhiteboardBuffering(): Promise<void> {
        this.stateMachine.setStatus(AtomPlayerSource.Whiteboard, AtomPlayerStatus.PlayingBuffering);
        this.onStatusUpdate(PublicCombinedStatus.PlayingBuffering);

        // 当 video 处于 pause 状态时，再次调用 pause 方法时，是不会触发 pause 事件的。所以需要提前进行判断。
        if (this.video.paused()) {
            this.stateMachine.setStatus(AtomPlayerSource.Video, AtomPlayerStatus.Pause);
            return;
        }

        this.video.one("pause", (): void => {
            this.stateMachine.setStatus(AtomPlayerSource.Video, AtomPlayerStatus.Pause);
        });

        const combinePlayerStatusWhenPlayingBuffering = this.stateMachine.one(
            CombinePlayerStatus.PlayingBuffering,
        );

        this.video.pause();

        this.stateMachine.setStatus(AtomPlayerSource.Whiteboard, AtomPlayerStatus.PlayingBuffering);

        await combinePlayerStatusWhenPlayingBuffering;
    }

    /**
     * 当 whiteboard 为 playing 时，插件自动调用 video 的播放方法
     * @private
     */
    private async playingVideoWhenWhiteboardPlaying(): Promise<void> {
        const combinePlayerStatusWhenToPlay = this.stateMachine.one(
            CombinePlayerStatus.ToPlay,
            async () => {
                this.video.play();
            },
        );

        const combinePlayerStatusWhenPlaying = this.stateMachine.one(
            CombinePlayerStatus.Playing,
            async () => {
                this.onStatusUpdate(PublicCombinedStatus.Playing);
            },
        );

        this.video.one("playing", (): void => {
            this.stateMachine.setStatus(AtomPlayerSource.Video, AtomPlayerStatus.Playing);
        });

        this.stateMachine.setStatus(AtomPlayerSource.Whiteboard, AtomPlayerStatus.Playing);

        await Promise.all([combinePlayerStatusWhenToPlay, combinePlayerStatusWhenPlaying]);
    }

    /**
     * 当 whiteboard 处于 ended 状态时，插件自动调用 video 的暂停方法
     * @private
     */
    private async pauseVideoWhenWhiteboardEnded(): Promise<void> {
        this.stateMachine.setStatus(AtomPlayerSource.Whiteboard, AtomPlayerStatus.Ended);
        const videoStatus = this.stateMachine.getStatus(AtomPlayerSource.Video).current;

        // 如果 video 已经是 ended 或者 pause 状态则不需要再进行暂停
        if (videoStatus === AtomPlayerStatus.Ended || videoStatus === AtomPlayerStatus.Pause) {
            return;
        }

        const combinePlayerStatusWhenEnded = this.stateMachine.one(
            CombinePlayerStatus.Ended,
            async () => {
                this.onStatusUpdate(PublicCombinedStatus.Ended);
            },
        );

        this.video.one("pause", (): void => {
            this.stateMachine.setStatus(AtomPlayerSource.Video, AtomPlayerStatus.Pause);
        });

        this.video.pause();

        await combinePlayerStatusWhenEnded;
    }

    /**
     * 当 video 处于 ended 状态时，插件自动调用 whiteboard 的 暂停方法
     * @private
     */
    private async pauseWhiteboardWhenVideoEnded(): Promise<void> {
        this.stateMachine.setStatus(AtomPlayerSource.Video, AtomPlayerStatus.Ended);
        const whiteboardStatus = this.stateMachine.getStatus(AtomPlayerSource.Whiteboard).current;

        // 如果 whiteboard 已经是 ended 或者 pause 状态则不需要再进行暂停
        if (
            whiteboardStatus === AtomPlayerStatus.Ended ||
            whiteboardStatus === AtomPlayerStatus.Pause
        ) {
            return;
        }

        const combinePlayerStatusWhenEnded = this.stateMachine.one(
            CombinePlayerStatus.Ended,
            async () => {
                this.onStatusUpdate(PublicCombinedStatus.Ended);
            },
        );

        this.whiteboardEmitter.one("pause", (): void => {
            this.stateMachine.setStatus(AtomPlayerSource.Whiteboard, AtomPlayerStatus.Pause);
        });

        this.whiteboard.pause();

        await combinePlayerStatusWhenEnded;
    }

    private releaseEvents(): void {
        this.taskQueue.destroy();
        this.stateMachine.destroy();
        this.whiteboardEmitter.destroy();
        this.whiteboard.stop();
        this.video.off();
    }

    /**
     * 意外进入 Disabled 状态处理
     * 在程序正常运行期间，是不应该走到 Disable 状态的，一旦走到说明程序出现了问题，需要对其做出 crash 的响应
     * @private
     */
    private async initOnCrashByDisabledStatusCallback(): Promise<void> {
        await this.stateMachine.setOnCrashByDisabledStatus(() => {
            this.releaseEvents();
            this.onStatusUpdate(PublicCombinedStatus.Disabled, ACCIDENT_ENTERED_DISABLED);
        });
    }

    /**
     * 状态通知更新
     * @param {PublicCombinedStatus} status - 要通知的状态
     * @param {string} [message] - 额外信息
     * @private
     */
    private onStatusUpdate(status: PublicCombinedStatus, message?: string): void {
        if (this.isNotResponse()) {
            return;
        }

        if (this.currentCombineStatus !== status) {
            this.currentCombineStatus = status;

            // 使用 Promise 封装一层，转为异步，以保证用户传入的参数不会影响到插件本身。
            // 因为如果用户的回调里存在着阻塞代码，也会影响到插件本身
            Promise.resolve().then((): void => {
                this.onStatusChangeHandleList.forEach(cb => {
                    if ({}.toString.call(cb) === "[object AsyncFunction]") {
                        cb(status, message).catch((e: string) => {
                            throw Error(e);
                        });
                    } else {
                        cb(status, message);
                    }
                });
            });
        }
    }

    private getPlayerDuration(): PlayerDuration {
        return {
            whiteboard: this.whiteboard.timeDuration,
            video: this.video.duration() * 1000,
        };
    }

    private isNotResponse(): boolean {
        const result =
            this.currentCombineStatus === PublicCombinedStatus.Stopped ||
            this.currentCombineStatus === PublicCombinedStatus.Disabled;

        if (result) {
            console.warn(
                `Currently in the ${this.currentCombineStatus} stage, the program will not respond to the current behavior`,
            );
        }
        return result;
    }

    private async checkVideoAutoPlay(): Promise<boolean> {
        if (this.whiteboard.progressTime !== 0 || this.video.currentTime() !== 0) {
            return true;
        }

        const videoStatus = this.stateMachine.getStatus(AtomPlayerSource.Video).current;
        const whiteboardStatus = this.stateMachine.getStatus(AtomPlayerSource.Whiteboard).current;

        const allowStatus = [AtomPlayerStatus.Pause, AtomPlayerStatus.PauseBuffering];

        if (!allowStatus.includes(videoStatus) || !allowStatus.includes(whiteboardStatus)) {
            return true;
        }

        this.stateMachine
            .oneButNotCrashByDisabled([
                {
                    video: AtomPlayerStatus.Playing,
                    whiteboard: AtomPlayerStatus.PauseBuffering,
                },
            ])
            .catch(e => {
                throw new Error(e);
            });

        const videoOnPlay = (): void => {
            this.stateMachine.setStatus(AtomPlayerSource.Video, AtomPlayerStatus.Playing);
        };

        const videoOnPause = (): void => {
            this.stateMachine.setStatus(AtomPlayerSource.Video, AtomPlayerStatus.Pause);
        };

        const combinePlayerStatusWhenToPlay = this.stateMachine.one(
            CombinePlayerStatus.ToPlay,
            async () => {
                this.video.pause();
            },
        );

        const combinePlayerStatusWhenToPause = this.stateMachine.one(CombinePlayerStatus.Pause);
        const combinePlayerStatusWhenToPauseBuffering = this.stateMachine.one(
            CombinePlayerStatus.PauseBuffering,
        );

        this.video.one("play", videoOnPlay);
        this.video.one("pause", videoOnPause);

        const clearVideoAndWhiteboardEvents = (): void => {
            this.stateMachine.cancelOneButNotCrashByDisabled();
            this.video.off("play", videoOnPlay);
            this.video.off("pause", videoOnPause);
            this.stateMachine.off([
                CombinePlayerStatus.ToPlay,
                CombinePlayerStatus.Pause,
                CombinePlayerStatus.PauseBuffering,
            ]);
        };

        try {
            await this.video.play();
        } catch (e) {
            clearVideoAndWhiteboardEvents();
            return false;
        }

        await Promise.all([
            combinePlayerStatusWhenToPlay,
            Promise.race([combinePlayerStatusWhenToPause, combinePlayerStatusWhenToPauseBuffering]),
        ]);

        clearVideoAndWhiteboardEvents();

        return true;
    }
}

type Config = {
    videoConfig: {
        videoOptions: VideoOptions;
        video: VideoJsPlayer;
        isCanplay: boolean;
    };
    whiteboard: Player;
    whiteboardEmitter: EventEmitter;
    debug: boolean;
};

type PlayerDuration = {
    whiteboard: number;
    video: number;
};
