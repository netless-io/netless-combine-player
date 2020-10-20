import { VideoJsPlayer } from "video.js";
import { Player } from "white-web-sdk";
import {
    AnyFunction,
    CombinePlayer,
    PublicCombinedStatus,
    StatusChangeHandle,
    VideoOptions,
} from "./Types";
import { StateMachine } from "./StateMachine";
import {
    AtomPlayerSource,
    AtomPlayerStatus,
    CombinePlayerStatus,
    TriggerSource,
} from "./StatusContant";
import { EventEmitter } from "./EventEmitter";
import { TaskQueue } from "./TaskQueue";
import { ACCIDENT_ENTERED_DISABLED } from "./ErrorConstant";

export class CombinePlayerImplement implements CombinePlayer {
    private readonly video: VideoJsPlayer;
    private readonly whiteboard: Player;
    private readonly videoOptions: VideoOptions;
    private readonly stateMachine: StateMachine;

    private triggerSource: TriggerSource = TriggerSource.None;

    private currentCombineStatus: PublicCombinedStatus = CombinePlayerStatus.PauseBuffering;

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

        this.initDisabledStatusHandler();
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
     */
    public getStatus(): PublicCombinedStatus {
        return this.currentCombineStatus;
    }

    /**
     * 插件的播放处理
     */
    public play(): void {
        this.taskQueue.append(
            async (): Promise<void> => {
                this.setTriggerSource(TriggerSource.Plugin);

                const currentCombinedStatus = this.stateMachine.getCombinationStatus().current;

                if (currentCombinedStatus === CombinePlayerStatus.Pause) {
                    await this.playWhenPause();
                } else if (currentCombinedStatus === CombinePlayerStatus.PauseBuffering) {
                    await this.playWhenPauseBuffering();
                } else if (currentCombinedStatus === CombinePlayerStatus.Ended) {
                    await this.playWhenEnded();
                }

                this.setTriggerSource(TriggerSource.None);
            },
        );
    }

    /**
     * 插件的暂停处理
     */
    public pause(): void {
        this.taskQueue.append(
            async (): Promise<void> => {
                this.setTriggerSource(TriggerSource.Plugin);

                const currentCombinedStatus = this.stateMachine.getCombinationStatus().current;
                if (currentCombinedStatus === CombinePlayerStatus.Playing) {
                    await this.pauseWhenPlaying();
                }

                this.setTriggerSource(TriggerSource.None);
            },
        );
    }

    /**
     * 用户调用 seek 时的处理
     */
    public seek(ms: number): void {
        this.taskQueue.append(
            async (): Promise<void> => {
                this.setTriggerSource(TriggerSource.Plugin);

                const currentCombinedStatus = this.stateMachine.getCombinationStatus().current;

                if (currentCombinedStatus === CombinePlayerStatus.Playing) {
                    await this.seekWhenPlaying(ms);
                } else if (
                    [
                        CombinePlayerStatus.Pause,
                        CombinePlayerStatus.PauseBuffering,
                        CombinePlayerStatus.Ended,
                    ].includes(currentCombinedStatus)
                ) {
                    await this.seekWhenPause(ms);
                }

                this.setTriggerSource(TriggerSource.None);
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
            this.currentCombineStatus = CombinePlayerStatus.PauseBuffering;
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
                    await this.taskQueue.append((): void => {
                        this.setTriggerSource(TriggerSource.Video);
                    });
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
                    this.onStatusUpdate(CombinePlayerStatus.Pause);
                }
            }
        });

        // 能触发此事件的，只有 video 丢帧时，会被触发。
        this.video.on(
            "seeking",
            warp((): void => {
                isDropFrame = true;
            }),
        );

        this.video.on(
            "waiting",
            warp(
                async (): Promise<void> => {
                    this.stateMachine.setStatus(
                        AtomPlayerSource.Video,
                        AtomPlayerStatus.PlayingBuffering,
                    );
                    // 这里进行提前通知，因为如果放在 taskQueue 里时，无法保证用户能第一时间感知到当前视频处于 playing-buffering 状态
                    this.onStatusUpdate(CombinePlayerStatus.PlayingBuffering);
                    await this.taskQueue.append(
                        (): Promise<void> => {
                            return this.pauseWhiteboardWhenVideoWaiting();
                        },
                    );
                    await this.taskQueue.append((): void => {
                        this.setTriggerSource(TriggerSource.None);
                    });
                },
            ),
        );

        this.video.on(
            "playing",
            warp(
                async (): Promise<void> => {
                    await this.taskQueue.append(
                        (): Promise<void> => {
                            return this.playingWhiteboardWhenVideoPlaying(isDropFrame);
                        },
                    );
                    await this.taskQueue.append((): void => {
                        this.setTriggerSource(TriggerSource.None);
                    });
                    isDropFrame = false;
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
                    await this.taskQueue.append((): void => {
                        this.setTriggerSource(TriggerSource.None);
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
        this.currentCombineStatus = CombinePlayerStatus.PauseBuffering;
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
                    this.onStatusUpdate(CombinePlayerStatus.Pause);
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
                    await this.taskQueue.append((): void => {
                        this.setTriggerSource(TriggerSource.Whiteboard);
                    });
                    await cb();
                }
            };
        };

        this.whiteboardEmitter.addListener(
            "buffering",
            warp(
                async (): Promise<void> => {
                    this.stateMachine.setStatus(
                        AtomPlayerSource.Whiteboard,
                        AtomPlayerStatus.PlayingBuffering,
                    );
                    this.onStatusUpdate(CombinePlayerStatus.PlayingBuffering);
                    await this.taskQueue.append(
                        (): Promise<void> => {
                            return this.pauseVideoWhenWhiteboardBuffering();
                        },
                    );
                    await this.taskQueue.append((): void => {
                        this.setTriggerSource(TriggerSource.None);
                    });
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
                    await this.taskQueue.append((): void => {
                        this.setTriggerSource(TriggerSource.None);
                    });
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
                    await this.taskQueue.append((): void => {
                        this.setTriggerSource(TriggerSource.None);
                    });
                },
            ),
        );
    }

    /**
     * 在暂停状态下，用户调用播放时的处理
     * @private
     */
    private playWhenPause(): Promise<void> {
        return new Promise(resolve => {
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

            this.stateMachine.one(CombinePlayerStatus.Playing).then(({ done }): void => {
                this.onStatusUpdate(CombinePlayerStatus.Playing);

                done();
                resolve();
            });

            this.whiteboardEmitter.one("playing", whiteboardOnPlaying);

            this.stateMachine.one(CombinePlayerStatus.ToPlay).then(({ done }): void => {
                this.whiteboard.play();

                done();
            });

            this.video.one("playing", videoOnPlaying);

            this.video.play();
        });
    }

    /**
     * 在 pause-buffering 状态下，用户调用播放时的处理
     * 需要主要的是，当在 pause-buffering 状态下，一共有三种情况路径
     * @private
     */
    private playWhenPauseBuffering(): Promise<void> {
        return new Promise(resolve => {
            const videoStatus = this.stateMachine.getStatus(AtomPlayerSource.Video).current;
            const whiteboardStatus = this.stateMachine.getStatus(AtomPlayerSource.Whiteboard)
                .current;

            this.onStatusUpdate(CombinePlayerStatus.PlayingBuffering);

            if (
                videoStatus === AtomPlayerStatus.PauseBuffering &&
                whiteboardStatus === AtomPlayerStatus.Pause
            ) {
                this.stateMachine.lockCombineStatus(
                    [CombinePlayerStatus.ToPlay, CombinePlayerStatus.Playing],
                    [CombinePlayerStatus.Playing],
                );

                const videoOnPlay = (): void => {
                    this.stateMachine.setStatus(
                        AtomPlayerSource.Video,
                        AtomPlayerStatus.PlayingBuffering,
                    );
                };

                const videoOnPlaying = (): void => {
                    this.stateMachine.setStatus(AtomPlayerSource.Video, AtomPlayerStatus.Playing);
                };

                const whiteboardOnPlaying = (): void => {
                    this.stateMachine.setStatus(
                        AtomPlayerSource.Whiteboard,
                        AtomPlayerStatus.Playing,
                    );
                };

                this.whiteboardEmitter.one("playing", whiteboardOnPlaying);

                this.stateMachine.one(CombinePlayerStatus.ToPlay).then(({ done }): void => {
                    this.whiteboard.play();
                    done();
                });

                this.stateMachine.one(CombinePlayerStatus.Playing).then(({ done }): void => {
                    this.onStatusUpdate(CombinePlayerStatus.Playing);
                    done();
                    resolve();
                });

                this.video.one("play", videoOnPlay);

                this.video.one("playing", videoOnPlaying);

                this.video.play();
            } else if (
                videoStatus === AtomPlayerStatus.Pause &&
                whiteboardStatus === AtomPlayerStatus.PauseBuffering
            ) {
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
                    this.stateMachine.setStatus(
                        AtomPlayerSource.Whiteboard,
                        AtomPlayerStatus.Playing,
                    );
                };

                const clearVideoAndWhiteboardEvents = (): void => {
                    this.whiteboardEmitter.removeListener("playing", whiteboardOnPlaying);
                    this.whiteboardEmitter.removeListener("buffering", whiteboardOnBuffering);
                    this.video.off("playing", videoOnPlaying);
                    this.video.off("pause", videoOnPause);
                };

                this.stateMachine
                    .oneDisabled([
                        {
                            video: AtomPlayerStatus.Playing,
                            whiteboard: AtomPlayerStatus.PauseBuffering,
                        },
                    ])
                    .then(() => {
                        this.video.pause();
                    });

                this.stateMachine.one(CombinePlayerStatus.PauseBuffering).then(({ done }): void => {
                    this.whiteboard.play();
                    done();
                });

                this.stateMachine.one(CombinePlayerStatus.Pause).then(({ done }): void => {
                    this.whiteboard.play();
                    done();
                });

                this.stateMachine.one(CombinePlayerStatus.ToPlay).then(({ done }): void => {
                    this.video.play();
                    done();
                });

                this.stateMachine.one(CombinePlayerStatus.Playing).then(({ done }): void => {
                    this.onStatusUpdate(CombinePlayerStatus.Playing);
                    this.stateMachine.off([
                        CombinePlayerStatus.PauseBuffering,
                        CombinePlayerStatus.Pause,
                        CombinePlayerStatus.ToPause,
                    ]);
                    clearVideoAndWhiteboardEvents();
                    done();
                    resolve();
                });

                this.whiteboardEmitter.one("buffering", whiteboardOnBuffering);

                this.whiteboardEmitter.one("playing", whiteboardOnPlaying);

                this.video.on("playing", videoOnPlaying);

                this.video.one("pause", videoOnPause);

                this.video.play();
            } else {
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
                    this.stateMachine.setStatus(
                        AtomPlayerSource.Whiteboard,
                        AtomPlayerStatus.Playing,
                    );
                };

                const whiteboardOnPause = (): void => {
                    this.stateMachine.setStatus(
                        AtomPlayerSource.Whiteboard,
                        AtomPlayerStatus.Pause,
                    );
                };

                const videoOnPlaying = (): void => {
                    this.stateMachine.setStatus(AtomPlayerSource.Video, AtomPlayerStatus.Playing);
                };

                const videoOnPlay = (): void => {
                    this.stateMachine.setStatus(
                        AtomPlayerSource.Video,
                        AtomPlayerStatus.PlayingBuffering,
                    );
                };

                const videoOnPause = (): void => {
                    this.stateMachine.setStatus(AtomPlayerSource.Video, AtomPlayerStatus.Pause);
                };

                this.stateMachine.oneDisabled([
                    {
                        video: AtomPlayerStatus.PlayingBuffering,
                        whiteboard: AtomPlayerStatus.PauseBuffering,
                    },
                    {
                        video: AtomPlayerStatus.PauseBuffering,
                        whiteboard: AtomPlayerStatus.PlayingBuffering,
                    },
                ]);

                this.stateMachine
                    .oneDisabled([
                        {
                            video: AtomPlayerStatus.Playing,
                            whiteboard: AtomPlayerStatus.PauseBuffering,
                        },
                        {
                            video: AtomPlayerStatus.PauseBuffering,
                            whiteboard: AtomPlayerStatus.Playing,
                        },
                    ])
                    .then(({ current }): void => {
                        // 这里是因为有可能存在，有一端已经开始播放了，但是另一端还在 pauseBuffering 状态。所以需要把播放的一端进行暂停
                        if (current.video === AtomPlayerStatus.Playing) {
                            this.video.pause();
                        } else {
                            this.whiteboard.pause();
                        }
                    });

                this.stateMachine.one(CombinePlayerStatus.ToPause).then(({ current, done }) => {
                    if (current.video === AtomPlayerStatus.Playing) {
                        this.video.pause();
                    } else {
                        this.whiteboard.pause();
                    }
                    done();
                });

                this.stateMachine.one(CombinePlayerStatus.ToPlay).then(({ current, done }) => {
                    if (current.video === AtomPlayerStatus.Playing) {
                        this.whiteboard.play();
                    } else {
                        this.video.play();
                    }
                    done();
                });

                this.stateMachine.one(CombinePlayerStatus.Playing).then(({ done }): void => {
                    this.onStatusUpdate(CombinePlayerStatus.Playing);
                    this.video.off("playing", videoOnPlaying);
                    this.whiteboardEmitter.removeListener("playing", whiteboardOnPlaying);
                    done();
                    resolve();
                });

                this.whiteboardEmitter.one("buffering", whiteboardOnBuffering);

                this.whiteboardEmitter.addListener("playing", whiteboardOnPlaying);

                this.whiteboardEmitter.one("pause", whiteboardOnPause);

                this.video.on("playing", videoOnPlaying);

                this.video.one("play", videoOnPlay);

                this.video.one("pause", videoOnPause);

                this.video.play();
                this.whiteboard.play();
            }
        });
    }

    /**
     * 在 ended 状态下，用户调用播放时的处理
     * @private
     */
    private playWhenEnded(): Promise<void> {
        return new Promise(resolve => {
            this.onStatusUpdate(CombinePlayerStatus.PlayingBuffering);
            this.stateMachine.lockCombineStatus(
                [CombinePlayerStatus.Pause],
                [CombinePlayerStatus.Pause],
            );

            const whiteboardOnPause = (): void => {
                this.stateMachine.setStatus(AtomPlayerSource.Whiteboard, AtomPlayerStatus.Pause);
            };

            const whiteboardOnPlaying = (): void => {
                this.whiteboard.pause();
            };

            const videoOnCanplay = (): void => {
                this.stateMachine.setStatus(AtomPlayerSource.Video, AtomPlayerStatus.Pause);
            };

            this.stateMachine.one(CombinePlayerStatus.Pause).then(
                async ({ done }): Promise<void> => {
                    await this.playWhenPause();
                    done();
                    resolve();
                },
            );

            this.whiteboardEmitter.one("pause", whiteboardOnPause);
            this.whiteboardEmitter.one("playing", whiteboardOnPlaying);

            this.video.one("canplay", videoOnCanplay);

            this.whiteboard.seekToProgressTime(0);
            this.video.currentTime(0);
        });
    }

    /**
     * 在 playing 状态下，用户调用暂停时的处理
     * @private
     */
    private pauseWhenPlaying(): Promise<void> {
        return new Promise(resolve => {
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

            this.stateMachine.one(CombinePlayerStatus.Pause).then(({ done }): void => {
                this.onStatusUpdate(CombinePlayerStatus.Pause);
                done();
                resolve();
            });

            this.whiteboardEmitter.one("pause", whiteboardOnPause);

            this.video.one("pause", videoOnPause);

            this.whiteboard.pause();
            this.video.pause();
        });
    }

    /**
     * 当在 playing 阶段时，用户调用 seek 时的处理
     * @param {number} ms - 将要 seek 到的时间点
     * @private
     */
    private seekWhenPlaying(ms: number): Promise<void> {
        return new Promise(resolve => {
            this.onStatusUpdate(CombinePlayerStatus.PlayingSeeking);

            const whiteboardDuration = this.whiteboard.timeDuration;
            const videoDuration = this.video.duration() * 1000;

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
                if (ms < whiteboardDuration) {
                    this.stateMachine.setStatus(
                        AtomPlayerSource.Whiteboard,
                        AtomPlayerStatus.Pause,
                    );
                }
            };

            const whiteboardOnPlaying = (): void => {
                this.whiteboard.pause();
            };

            const whiteboardOnEnded = (): void => {
                this.stateMachine.setStatus(AtomPlayerSource.Whiteboard, AtomPlayerStatus.Ended);
            };

            const videoOnSeeking = (): void => {
                this.stateMachine.setStatus(
                    AtomPlayerSource.Video,
                    AtomPlayerStatus.PlayingSeeking,
                );
            };

            const videoOnSeeked = (): void => {
                if (ms < videoDuration) {
                    this.video.pause();
                    this.stateMachine.setStatus(AtomPlayerSource.Video, AtomPlayerStatus.Pause);
                }
            };

            const videoOnEnded = (): void => {
                this.stateMachine.setStatus(AtomPlayerSource.Video, AtomPlayerStatus.Ended);
            };

            const clearVideoAndWhiteboardEvents = (): void => {
                this.whiteboardEmitter.removeListener("buffering", whiteboardOnBuffering);
                this.whiteboardEmitter.removeListener("pause", whiteboardOnPause);
                this.whiteboardEmitter.removeListener("playing", whiteboardOnPlaying);
                this.whiteboardEmitter.removeListener("ended", whiteboardOnEnded);
                this.video.off("seeking", videoOnSeeking);
                this.video.off("seeked", videoOnSeeked);
                this.video.off("ended", videoOnEnded);
            };

            this.stateMachine.one(CombinePlayerStatus.Pause).then(
                async ({ done }): Promise<void> => {
                    this.stateMachine.off([CombinePlayerStatus.Ended]);
                    clearVideoAndWhiteboardEvents();
                    await this.playWhenPause();
                    done();
                    resolve();
                },
            );

            this.stateMachine.one(CombinePlayerStatus.Ended).then(({ done }): void => {
                this.onStatusUpdate(CombinePlayerStatus.Ended);
                this.stateMachine.off([CombinePlayerStatus.Pause]);
                clearVideoAndWhiteboardEvents();
                done();
                resolve();
            });

            this.stateMachine.one(CombinePlayerStatus.PlayingSeeking).then(({ current, done }) => {
                const { video, whiteboard } = current;

                // 如果当前 seek 的时间没有超过 whiteboard，并且 当前 video 状态为 ended 时，才对 whiteboard 调用暂停。否则不需要
                if (video === AtomPlayerStatus.Ended && ms < whiteboardDuration) {
                    this.whiteboard.pause();
                } else if (whiteboard === AtomPlayerStatus.Ended && ms < videoDuration) {
                    this.video.pause();
                }

                done();
            });

            this.video.one("seeking", videoOnSeeking);

            this.video.one("seeked", videoOnSeeked);

            this.video.one("ended", videoOnEnded);

            this.whiteboardEmitter.one("buffering", whiteboardOnBuffering);

            this.whiteboardEmitter.one("pause", whiteboardOnPause);

            this.whiteboardEmitter.one("playing", whiteboardOnPlaying);

            this.whiteboardEmitter.one("ended", whiteboardOnEnded);

            this.whiteboard.seekToProgressTime(ms);
            this.video.currentTime(ms / 1000);
        });
    }

    /**
     * 当在 pause 阶段时，用户调用 seek 时的处理
     * @param {number} ms - 将要 seek 到的时间点
     * @private
     */
    private seekWhenPause(ms: number): Promise<void> {
        return new Promise(resolve => {
            this.onStatusUpdate(CombinePlayerStatus.PauseSeeking);

            this.stateMachine.lockCombineStatus(
                [
                    CombinePlayerStatus.Disabled,
                    CombinePlayerStatus.Pause,
                    CombinePlayerStatus.Ended,
                ],
                [CombinePlayerStatus.Pause, CombinePlayerStatus.Ended],
            );

            const whiteboardDuration = this.whiteboard.timeDuration;
            const videoDuration = this.video.duration() * 1000;

            const videoOnSeeking = (): void => {
                this.stateMachine.setStatus(AtomPlayerSource.Video, AtomPlayerStatus.PauseSeeking);
            };

            const videoOnCanplay = (): void => {
                this.stateMachine.setStatus(AtomPlayerSource.Video, AtomPlayerStatus.Pause);
            };

            const videoOnEnded = (): void => {
                this.stateMachine.setStatus(AtomPlayerSource.Video, AtomPlayerStatus.Ended);
            };

            const whiteboardOnBuffering = (): void => {
                this.stateMachine.setStatus(
                    AtomPlayerSource.Whiteboard,
                    AtomPlayerStatus.PauseSeeking,
                );
            };

            const whiteboardOnPause = (): void => {
                this.stateMachine.setStatus(AtomPlayerSource.Whiteboard, AtomPlayerStatus.Pause);
            };

            const whiteboardOnEnded = (): void => {
                this.stateMachine.setStatus(AtomPlayerSource.Whiteboard, AtomPlayerStatus.Ended);
            };

            const clearVideoAndWhiteboardEvents = (): void => {
                this.video.off("seeking", videoOnSeeking);
                this.video.off("canplay", videoOnCanplay);
                this.video.off("ended", videoOnEnded);
                this.whiteboardEmitter.removeListener("buffering", whiteboardOnBuffering);
                this.whiteboardEmitter.removeListener("pause", whiteboardOnPause);
                this.whiteboardEmitter.removeListener("ended", whiteboardOnEnded);
            };

            this.stateMachine.oneDisabled([
                {
                    video: AtomPlayerStatus.PauseSeeking,
                    whiteboard: AtomPlayerStatus.PauseSeeking,
                },
            ]);

            this.stateMachine.one(CombinePlayerStatus.Pause).then(({ done }): void => {
                // 当 ms 超过 video 视频的持续时间时，说明最终的状态是 Ended，而非 Pause，所以这里需要跳过
                if (ms >= videoDuration) {
                    return;
                }

                this.onStatusUpdate(CombinePlayerStatus.Pause);
                this.stateMachine.off(CombinePlayerStatus.Ended);
                clearVideoAndWhiteboardEvents();
                done();
                resolve();
            });

            this.stateMachine.on(CombinePlayerStatus.Ended, (_previous, current, done): void => {
                // 如果要 seek 的时间超过了视频本身的持续时间，并且为 Pause，则跳过。因为它迟早会跳到 Ended 状态
                if (ms >= whiteboardDuration && current.whiteboard === AtomPlayerStatus.Pause) {
                    return done();
                } else if (ms >= videoDuration && current.video === AtomPlayerStatus.Pause) {
                    return done();
                }

                this.onStatusUpdate(CombinePlayerStatus.Ended);
                this.stateMachine.off([CombinePlayerStatus.Pause, CombinePlayerStatus.Ended]);
                clearVideoAndWhiteboardEvents();
                done();
                resolve();
            });

            this.video.one("seeking", videoOnSeeking);

            // 在 pause 状态时，如果 video seek 完成，最终的事件是 canplay 事件，而非 pause 事件
            this.video.one("canplay", videoOnCanplay);

            this.video.one("ended", videoOnEnded);

            this.whiteboardEmitter.one("buffering", whiteboardOnBuffering);

            this.whiteboardEmitter.one("pause", whiteboardOnPause);

            this.whiteboardEmitter.one("ended", whiteboardOnEnded);

            this.whiteboard.seekToProgressTime(ms);
            this.video.currentTime(ms / 1000);

            // 这是一个 video 的 bug
            // 当 video 处于 pause 状态时，我们 seek 到视频的终点时间戳时或者超过终点时间戳时，并不会去触发 Ended，需要等 seek 结束后，再进行一次 seek，才能正确触发 Ended 事件
            if (ms >= videoDuration) {
                this.video.one("seeked", (): void => {
                    this.video.currentTime(ms / 1000);
                });
            }
        });
    }

    /**
     * 当 video 处于 waiting 状态，插件自动暂停白板的处理
     * @private
     */
    private pauseWhiteboardWhenVideoWaiting(): Promise<void> {
        return new Promise(resolve => {
            // 因为当 video 丢帧时，会触发多次的 waiting，而后面的 waiting 也会到达这里
            // 当 whiteboard 处于 pause 状态时，再次调用 pause 方法时，是不会触发 pause 事件的。所以需要提前进行判断。
            if (this.whiteboard.phase === "pause") {
                this.stateMachine.setStatus(AtomPlayerSource.Whiteboard, AtomPlayerStatus.Pause);
                return resolve();
            }

            this.whiteboardEmitter.one("pause", (): void => {
                this.stateMachine.setStatus(AtomPlayerSource.Whiteboard, AtomPlayerStatus.Pause);
                resolve();
            });

            this.whiteboard.pause();
        });
    }

    /**
     * 当 video 处于 playing 状态时，插件自动调用 video 的播放方法
     * @param {boolean} isDropFrame - 是否丢帧
     * @private
     */
    private playingWhiteboardWhenVideoPlaying(isDropFrame: boolean): Promise<void> {
        return new Promise(resolve => {
            // video 丢帧时的处理
            // 我们会先把 video 进行暂停，然后对 whiteboard 进行 seek 校准
            // 而 whiteboard seek 校准时，会触发: buffering -> pause(因为在调用此函数之前，我们是能够保证 whiteboard 一定是暂停状态，所以 whiteboard seek 完成后，就一定会回到 pause 状态)
            // 当 whiteboard 到达 pause 时(此时 video 也是处于 pause 状态)，我们就可以使用插件的 play 方法，来间接调用 playWhenPauseBuffering 方法，让其播放
            if (isDropFrame) {
                this.whiteboardEmitter.one("pause", (): void => {
                    // 因为当我们对 whiteboard 进行 seek 后，如果后面调用播放，会先进入 buffering 阶段。所以这里设置 whiteboard 状态 为 pause-buffering 状态
                    this.stateMachine.setStatus(
                        AtomPlayerSource.Whiteboard,
                        AtomPlayerStatus.PauseBuffering,
                    );
                    this.playWhenPauseBuffering().then(resolve);
                });

                this.video.one("pause", (): void => {
                    this.stateMachine.setStatus(AtomPlayerSource.Video, AtomPlayerStatus.Pause);
                    this.whiteboard.seekToProgressTime(this.video.currentTime() * 1000);
                });

                this.video.pause();
            } else {
                // video 在播放状态时，由于网络问题，导致 video 需要缓冲。现缓存完毕，开始让 whiteboard 播放
                this.stateMachine.setStatus(AtomPlayerSource.Video, AtomPlayerStatus.Playing);

                this.stateMachine.one(CombinePlayerStatus.Playing).then(({ done }): void => {
                    this.onStatusUpdate(CombinePlayerStatus.Playing);
                    done();
                    resolve();
                });

                this.whiteboardEmitter.one("playing", (): void => {
                    this.stateMachine.setStatus(
                        AtomPlayerSource.Whiteboard,
                        AtomPlayerStatus.Playing,
                    );
                });

                this.whiteboard.play();
            }
        });
    }

    /**
     * 当 whiteboard 为 buffering 时，插件自动调用 video 的 暂停方法
     * @private
     */
    private pauseVideoWhenWhiteboardBuffering(): Promise<void> {
        return new Promise(resolve => {
            // 当 video 处于 pause 状态时，再次调用 pause 方法时，是不会触发 pause 事件的。所以需要提前进行判断。
            if (this.video.paused()) {
                this.stateMachine.setStatus(AtomPlayerSource.Video, AtomPlayerStatus.Pause);
                return resolve();
            }

            this.video.one("pause", (): void => {
                this.stateMachine.setStatus(AtomPlayerSource.Video, AtomPlayerStatus.Pause);
                resolve();
            });

            this.video.pause();
        });
    }

    /**
     * 当 whiteboard 为 playing 时，插件自动调用 video 的播放方法
     * @private
     */
    private playingVideoWhenWhiteboardPlaying(): Promise<void> {
        return new Promise(resolve => {
            this.stateMachine.one(CombinePlayerStatus.ToPlay).then(({ done }): void => {
                this.video.play();
                done();
            });

            this.stateMachine.one(CombinePlayerStatus.Playing).then(({ done }): void => {
                this.onStatusUpdate(CombinePlayerStatus.Playing);
                done();
                resolve();
            });

            this.video.one("playing", (): void => {
                this.stateMachine.setStatus(AtomPlayerSource.Video, AtomPlayerStatus.Playing);
            });

            this.stateMachine.setStatus(AtomPlayerSource.Whiteboard, AtomPlayerStatus.Playing);
        });
    }

    /**
     * 当 whiteboard 处于 ended 状态时，插件自动调用 video 的暂停方法
     * @private
     */
    private pauseVideoWhenWhiteboardEnded(): Promise<void> {
        return new Promise(resolve => {
            this.stateMachine.one(CombinePlayerStatus.Ended).then(({ done }): void => {
                this.onStatusUpdate(CombinePlayerStatus.Ended);
                done();
                resolve();
            });

            this.video.one("pause", (): void => {
                this.stateMachine.setStatus(AtomPlayerSource.Video, AtomPlayerStatus.Pause);
            });

            this.video.pause();
        });
    }

    /**
     * 当 video 处于 ended 状态时，插件自动调用 whiteboard 的 暂停方法
     * @private
     */
    private pauseWhiteboardWhenVideoEnded(): Promise<void> {
        return new Promise(resolve => {
            this.stateMachine.one(CombinePlayerStatus.Ended).then(({ done }): void => {
                this.onStatusUpdate(CombinePlayerStatus.Ended);
                done();
                resolve();
            });

            this.whiteboardEmitter.one("pause", (): void => {
                this.stateMachine.setStatus(AtomPlayerSource.Whiteboard, AtomPlayerStatus.Pause);
            });

            this.whiteboard.pause();
        });
    }

    /**
     * 改变 修改源
     * @param {TriggerSource} source - 修改源
     * @private
     */
    private setTriggerSource(source: TriggerSource): void {
        this.triggerSource = source;
    }

    /**
     * 意外进入 Disabled 状态处理
     * @private
     */
    private initDisabledStatusHandler(): void {
        this.stateMachine.on(CombinePlayerStatus.Disabled, (_previous, current, done) => {
            const { video: videoStatus, whiteboard: whiteboardStatus } = current;

            let reportErrorFlag = true;
            this.stateMachine.allowStatusListWhenDisabled.forEach(value => {
                value.forEach(({ whiteboard, video }) => {
                    if (whiteboard === whiteboardStatus && video === videoStatus) {
                        reportErrorFlag = false;
                    }
                });
            });

            if (reportErrorFlag) {
                this.taskQueue.destroy();
                this.stateMachine.destroy();
                this.whiteboardEmitter.destroy();
                this.setTriggerSource(TriggerSource.None);
                this.video.off();
                this.onStatusUpdate(CombinePlayerStatus.Disabled, ACCIDENT_ENTERED_DISABLED);
            }

            done();
        });
    }

    /**
     * 状态通知更新
     * @param {PublicCombinedStatus} status - 要通知的状态
     * @param {string} [message] - 额外信息
     * @private
     */
    private onStatusUpdate(status: PublicCombinedStatus, message?: string): void {
        if (this.currentCombineStatus !== status) {
            this.currentCombineStatus = status;

            // 使用 Promise 封装一层，转为异步，以保证用户传入的参数不会影响到插件本身。
            // 因为如果用户的回调里存在着阻塞代码，也会影响到插件本身
            Promise.resolve().then((): void => {
                this.onStatusChangeHandleList.forEach(cb => {
                    cb(status, message);
                });
            });
        }
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
