import videojs, { VideoJsPlayer } from "video.js";
import { Player, PlayerPhase } from "white-web-sdk";
import {
    AnyFunction,
    DefaultOptions,
    PublicCombinedStatus,
    TriggerSource,
    VideoOptions,
} from "./Types";
import { StateMachine } from "./StateMachine";
import { verifyInstanceParams } from "./Verification";
import { CombineStatus, Status } from "./StatusContant";
import { EventEmitter } from "./EventEmitter";
import { TaskQueue } from "./TaskQueue";
import {
    ACCIDENT_ENTERED_DISABLED_BY_ALL_IS_PAUSE,
    ACCIDENT_ENTERED_DISABLED_BY_ALL_IS_PAUSE_BUFFERING,
    ACCIDENT_ENTERED_DISABLED_BY_ENDED,
    ACCIDENT_ENTERED_DISABLED_BY_PLAYING,
    ACCIDENT_ENTERED_DISABLED_BY_SEEKING_PAUSE,
    ACCIDENT_ENTERED_DISABLED_BY_SEEKING_PLAYING,
    ACCIDENT_ENTERED_DISABLED_BY_VIDEO_IS_PAUSE_BUFFERING,
    ACCIDENT_ENTERED_DISABLED_BY_WHITEBOARDER_IS_PAUSE_BUFFERING,
} from "./ErrorConstant";

/**
 * 实例化时默认传参
 * @private
 * @return DefaultOptions
 */
const defaultOptions = (): DefaultOptions => {
    return {
        videoDOM: document.createElement("video"),
        videoJsOptions: {
            preload: "auto",
        },
    };
};

// 记录最后一次的公开状态，防止多发
let lastPublicCombinedStatus: PublicCombinedStatus = CombineStatus.PauseBuffering;

export default class CombinePlayer {
    private videoJS: VideoJsPlayer | undefined = undefined;
    private whiteboard: undefined | Player = undefined;
    private readonly videoOptions: VideoOptions | undefined = undefined;
    private readonly stateMachine: StateMachine;

    private statusCallBack: (status: PublicCombinedStatus, message?: string) => any = () => {};

    private triggerSource: TriggerSource = "none";

    private readonly whiteboardEventEmitter: EventEmitter = new EventEmitter();
    private readonly taskQueue: TaskQueue = new TaskQueue();

    /**
     * 实例化 Combine-Player 插件
     * @param {VideoOptions} [videoOptions=DefaultOptions] - video 配置项
     * @param {boolean} [debug=false] - 是否开启 debug 日志
     */
    public constructor(videoOptions: VideoOptions, debug: boolean = false) {
        verifyInstanceParams(videoOptions);

        const _defaultOptions = defaultOptions();
        this.videoOptions = {
            ..._defaultOptions,
            ...videoOptions,
            videoJsOptions: {
                ..._defaultOptions.videoJsOptions,
                ...videoOptions.videoJsOptions,
            },
        };

        this.stateMachine = new StateMachine(debug);
        this.initVideoJS();
    }

    /**
     * 设置白板的 Player 实例
     * @param {Player} whiteboard - 白板实例
     */
    public setWhiteboard(whiteboard: Player): void {
        this.whiteboard = whiteboard;

        // 这里 提前进行了状态机改变，因为回放在 seek 时，不会触发 Buffering 事件，所以在这里需要提前设置。以保证状态正确
        this.stateMachine.emit("whiteboard", Status.PauseBuffering);
        this.statusCallBack(CombineStatus.PauseBuffering);
        // 先seek到第一帧，以拿到 whiteboard 的状态。否则 whiteboard 会永远在 waitingFirstFrame 状态，isPlayable 也会一直是 false
        this.whiteboard.seekToProgressTime(0);
        this.initWhiteboardEvents();
    }

    /**
     * 设置白板的事件回调
     * @param {PlayerPhase} phase - 事件名称
     */
    public setWhiteboardEvents(phase: PlayerPhase): void {
        this.whiteboardEventEmitter.emit(phase);
    }

    /**
     * 设置 回放 的 isPlayable 事件
     * @param {boolean} isPlayable - 是否可播放
     */
    public setWhiteboardIsPlayable(isPlayable: boolean): void {
        const whiteboardStatus = this.stateMachine.getStatus("whiteboard").current;
        const videoStatus = this.stateMachine.getStatus("video").current;

        // 当 当前回放确认已经加载好了，并且当前 回放 的状态为 PauseBuffering 时，就可以把 回放 的状态修改为 Pause 状态了
        if (isPlayable && whiteboardStatus === Status.PauseBuffering) {
            this.stateMachine.emit("whiteboard", Status.Pause);
            if (videoStatus === Status.Pause) {
                this.statusCallBack(CombineStatus.Pause);
            }
        }
    }

    /**
     * 状态通知监听
     * @param {(status: PublicCombinedStatus) => any} cb - 状态发生回调
     */
    public on(cb: (status: PublicCombinedStatus, message?: string) => any): void {
        // 使用 Promise 封装一层，转为异步，以保证用户传入的参数不会影响到插件本身。
        this.statusCallBack = (status, message?): void => {
            if (lastPublicCombinedStatus !== status) {
                lastPublicCombinedStatus = status;
                Promise.resolve().then((): void => {
                    cb(status, message);
                });
            }
        };
    }

    /**
     * 方便用户主动获取当前的状态
     */
    public getStatus(): PublicCombinedStatus {
        return lastPublicCombinedStatus;
    }

    /**
     * 插件的播放处理
     */
    public play(): void {
        this.taskQueue.add((next: AnyFunction): void => this.$setTriggerSource(next, "plugin"));

        this.taskQueue.add((next: AnyFunction): void => {
            const currentCombinedStatus = this.stateMachine.getCombinationStatus().current;

            if (currentCombinedStatus === CombineStatus.Pause) {
                this.$playByPause(next);
            } else if (currentCombinedStatus === CombineStatus.PauseBuffering) {
                this.$playByPauseBuffering(next);
            } else if (currentCombinedStatus === CombineStatus.Ended) {
                this.$playByEnded(next);
            } else {
                next();
            }
        });

        this.taskQueue.add((next: AnyFunction): void => this.$setTriggerSource(next, "none"));
    }

    /**
     * 插件的暂停处理
     */
    public pause(): void {
        this.taskQueue.add((next: AnyFunction): void => this.$setTriggerSource(next, "plugin"));

        this.taskQueue.add((next: AnyFunction): void => {
            const currentCombinedStatus = this.stateMachine.getCombinationStatus().current;
            if (currentCombinedStatus === CombineStatus.Playing) {
                this.$pauseByPlaying(next);
            } else {
                next();
            }
        });

        this.taskQueue.add((next: AnyFunction): void => this.$setTriggerSource(next, "none"));
    }

    /**
     * 用户调用 seek 时的处理
     */
    public seek(ms: number): void {
        this.taskQueue.add((next: AnyFunction): void => this.$setTriggerSource(next, "plugin"));

        this.taskQueue.add((next: AnyFunction): void => {
            const currentCombinedStatus = this.stateMachine.getCombinationStatus()
                .current as CombineStatus;

            if (currentCombinedStatus === CombineStatus.Playing) {
                this.$seekByPlaying(next, ms);
            } else if (
                [CombineStatus.Pause, CombineStatus.PauseBuffering, CombineStatus.Ended].includes(
                    currentCombinedStatus,
                )
            ) {
                this.$seekByPause(next, ms);
            } else {
                next();
            }
        });

        this.taskQueue.add((next: AnyFunction): void => this.$setTriggerSource(next, "none"));
    }

    // 初始化 video.js
    private initVideoJS(): void {
        const videoJS = videojs(this.videoOptions!.videoDOM, this.videoOptions!.videoJsOptions);
        videoJS.src(this.videoOptions!.url);

        this.videoJS = videoJS;

        const videoIsCanplay = this.videoIsCanplay();
        this.stateMachine.emit("video", videoIsCanplay ? Status.Pause : Status.PauseBuffering);

        if (!videoIsCanplay) {
            this.statusCallBack(CombineStatus.PauseBuffering);
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
            return (): void => {
                // 如果当前是事件是由用户手动触发，则跳过。不做处理
                if (this.triggerSource === "none" || this.triggerSource === "video") {
                    this.taskQueue.add((next: AnyFunction): void =>
                        this.$setTriggerSource(next, "video"),
                    );
                    cb();
                }
            };
        };

        this.videoJS!.on("canplay", (): void => {
            const whiteboardStatus = this.stateMachine.getStatus("whiteboard").current;
            const videoStatus = this.stateMachine.getStatus("video").current;

            // 如果当前 video 处于 PauseBuffering 状态，则通知状态机，加载完成。改为 Pause 状态
            if (videoStatus === Status.PauseBuffering) {
                this.stateMachine.emit("video", Status.Pause);

                if (whiteboardStatus === Status.Pause) {
                    this.statusCallBack(CombineStatus.Pause);
                }
            }
        });

        // 能触发此事件的，只有 video 丢帧时，会被触发。
        this.videoJS!.on(
            "seeking",
            warp((): void => {
                isDropFrame = true;
            }),
        );

        this.videoJS!.on(
            "waiting",
            warp((): void => {
                this.stateMachine.emit("video", Status.PlayingBuffering);
                // 这里进行提前通知，因为如果放在 taskQueue 里时，无法保证用户能第一时间感知到当前视频处于 playing-buffering 状态
                this.statusCallBack(CombineStatus.PlayingBuffering);
                this.taskQueue.add((next: AnyFunction): void =>
                    this.$pauseWhiteboardByVideoWaiting(next),
                );
                this.taskQueue.add((next: AnyFunction): void =>
                    this.$setTriggerSource(next, "none"),
                );
            }),
        );

        this.videoJS!.on(
            "playing",
            warp((): void => {
                this.taskQueue.add((next: AnyFunction): void =>
                    this.$playingWhiteboardByVideoPlaying(next, isDropFrame),
                );
                this.taskQueue.add((next: AnyFunction): void =>
                    this.$setTriggerSource(next, "none"),
                );
                isDropFrame = false;
            }),
        );

        this.videoJS!.on(
            "ended",
            warp((): void => {
                this.taskQueue.add((next: AnyFunction): void =>
                    this.$pauseWhiteboardByVideoEnded(next),
                );
                this.taskQueue.add((next: AnyFunction): void =>
                    this.$setTriggerSource(next, "none"),
                );
            }),
        );
    }

    private initWhiteboardEvents(): void {
        /**
         * 中间处理件，判断当前回调是否应该调用真正的回调
         * @param cb
         */
        const warp = (cb: AnyFunction): AnyFunction => {
            return (): void => {
                // 如果当前是事件是由用户手动触发，则跳过。不做处理
                if (this.triggerSource === "none" || this.triggerSource === "whiteboard") {
                    this.taskQueue.add((next: AnyFunction): void =>
                        this.$setTriggerSource(next, "whiteboard"),
                    );
                    cb();
                }
            };
        };

        this.whiteboardEventEmitter.addListener(
            "buffering",
            warp((): void => {
                this.stateMachine.emit("whiteboard", Status.PlayingBuffering);
                this.statusCallBack(CombineStatus.PlayingBuffering);
                this.taskQueue.add((next: AnyFunction): void =>
                    this.$pauseVideoByWhiteboardBuffering(next),
                );
                this.taskQueue.add((next: AnyFunction): void =>
                    this.$setTriggerSource(next, "none"),
                );
            }),
        );

        this.whiteboardEventEmitter.addListener(
            "playing",
            warp((): void => {
                this.taskQueue.add((next: AnyFunction): void =>
                    this.$playingVideoByWhiteboardPlaying(next),
                );
                this.taskQueue.add((next: AnyFunction): void =>
                    this.$setTriggerSource(next, "none"),
                );
            }),
        );

        this.whiteboardEventEmitter.addListener(
            "ended",
            warp((): void => {
                this.taskQueue.add((next: AnyFunction): void =>
                    this.$pauseVideoByWhiteboardEnded(next),
                );
                this.taskQueue.add((next: AnyFunction): void =>
                    this.$setTriggerSource(next, "none"),
                );
            }),
        );
    }

    /**
     * 在暂停状态下，用户调用播放时的处理
     * @param {AnyFunction} next - 完成，开始下一个
     * @private
     */
    private $playByPause(next: AnyFunction): void {
        this.stateMachine.lockStatus(
            [CombineStatus.Disabled, CombineStatus.ToPlay, CombineStatus.Playing],
            [CombineStatus.Playing, CombineStatus.Disabled],
        );

        const videoOnPlaying = (): void => {
            this.stateMachine.emit("video", Status.Playing);
        };

        const whiteboardOnPlaying = (): void => {
            this.stateMachine.emit("whiteboard", Status.Playing);
        };

        this.stateMachine.one(CombineStatus.Disabled, (_last, _current, done): void => {
            this.statusCallBack(CombineStatus.Disabled, ACCIDENT_ENTERED_DISABLED_BY_ALL_IS_PAUSE);

            this.taskQueue.clear();
            this.videoJS!.off("playing", videoOnPlaying);
            this.whiteboardEventEmitter.removeListener("playing", whiteboardOnPlaying);
            this.stateMachine.off([CombineStatus.ToPlay, CombineStatus.Playing]);

            done();
            next();
        });

        this.stateMachine.one(CombineStatus.Playing, (_last, _current, done): void => {
            this.statusCallBack(CombineStatus.Playing);
            this.stateMachine.off(CombineStatus.Disabled);
            done();
            next();
        });

        this.whiteboardEventEmitter.one("playing", whiteboardOnPlaying);

        this.stateMachine.one(CombineStatus.ToPlay, (_last, _current, done): void => {
            this.whiteboard!.play();
            done();
        });

        this.videoJS!.one("playing", videoOnPlaying);

        this.videoJS!.play();
    }

    /**
     * 在 pause-buffering 状态下，用户调用播放时的处理
     * 需要主要的是，当在 pause-buffering 状态下，一共有三种情况路径
     * @param {AnyFunction} next - 完成，开始下一个
     * @private
     */
    private $playByPauseBuffering(next: AnyFunction): void {
        const videoStatus = this.stateMachine.getStatus("video").current;
        const whiteboardStatus = this.stateMachine.getStatus("whiteboard").current;

        this.statusCallBack(CombineStatus.PlayingBuffering);

        if (videoStatus === Status.PauseBuffering && whiteboardStatus === Status.Pause) {
            this.stateMachine.lockStatus(
                [CombineStatus.Disabled, CombineStatus.ToPlay, CombineStatus.Playing],
                [CombineStatus.Playing, CombineStatus.Disabled],
            );

            const videoOnPlay = (): void => {
                this.stateMachine.emit("video", Status.PlayingBuffering);
            };

            const videoOnPlaying = (): void => {
                this.stateMachine.emit("video", Status.Playing);
            };

            const whiteboardOnPlaying = (): void => {
                this.stateMachine.emit("whiteboard", Status.Playing);
            };

            this.stateMachine.one(CombineStatus.Disabled, (_last, _current, done): void => {
                this.taskQueue.clear();
                this.statusCallBack(
                    CombineStatus.Disabled,
                    ACCIDENT_ENTERED_DISABLED_BY_VIDEO_IS_PAUSE_BUFFERING,
                );
                this.whiteboardEventEmitter.removeListener("playing", whiteboardOnPlaying);
                this.stateMachine.off([CombineStatus.ToPlay, CombineStatus.Playing]);
                this.videoJS!.off("play", videoOnPlay);
                this.videoJS!.off("playing", videoOnPlaying);
                done();
                next();
            });

            this.whiteboardEventEmitter.one("playing", whiteboardOnPlaying);

            this.stateMachine.one(CombineStatus.ToPlay, (_last, _current, done): void => {
                this.whiteboard!.play();
                done();
            });

            this.stateMachine.one(CombineStatus.Playing, (_last, _current, done): void => {
                this.statusCallBack(CombineStatus.Playing);
                this.stateMachine.off(CombineStatus.Disabled);
                done();
                next();
            });

            this.videoJS!.one("play", videoOnPlay);

            this.videoJS!.one("playing", videoOnPlaying);

            this.videoJS!.play();
        } else if (videoStatus === Status.Pause && whiteboardStatus === Status.PauseBuffering) {
            this.stateMachine.lockStatus(
                [
                    CombineStatus.Disabled,
                    CombineStatus.Pause,
                    CombineStatus.PauseBuffering,
                    CombineStatus.ToPlay,
                    CombineStatus.Playing,
                ],
                [CombineStatus.Playing],
            );

            const videoOnPlaying = (): void => {
                this.stateMachine.emit("video", Status.Playing);
            };

            const videoOnPause = (): void => {
                this.stateMachine.emit("video", Status.Pause);
            };

            const whiteboardOnBuffering = (): void => {
                this.stateMachine.emit("whiteboard", Status.PlayingBuffering);
            };

            const whiteboardOnPlaying = (): void => {
                this.stateMachine.emit("whiteboard", Status.Playing);
            };

            const clearVideoAndWhiteboardEvents = (): void => {
                this.whiteboardEventEmitter.removeListener("playing", whiteboardOnPlaying);
                this.whiteboardEventEmitter.removeListener("buffering", whiteboardOnBuffering);
                this.videoJS!.off("playing", videoOnPlaying);
                this.videoJS!.off("pause", videoOnPause);
            };

            this.stateMachine.on(CombineStatus.Disabled, (_last, current, done): void => {
                // 当前路径下，是允许进入 Disable 区域的(video 为 playing，whiteboard 为 pauseBuffering)
                if (
                    current.videoStatus === Status.Playing &&
                    current.whiteboardStatus === Status.PauseBuffering
                ) {
                    this.videoJS!.pause();
                } else {
                    this.taskQueue.clear();
                    this.statusCallBack(
                        CombineStatus.Disabled,
                        ACCIDENT_ENTERED_DISABLED_BY_WHITEBOARDER_IS_PAUSE_BUFFERING,
                    );
                    this.stateMachine.unLockStatus();
                    this.stateMachine.off([
                        CombineStatus.PauseBuffering,
                        CombineStatus.Pause,
                        CombineStatus.ToPause,
                        CombineStatus.Playing,
                    ]);
                    clearVideoAndWhiteboardEvents();

                    done();
                    next();
                    return;
                }

                done();
            });

            this.stateMachine.one(CombineStatus.PauseBuffering, (_last, _current, done): void => {
                this.whiteboard!.play();
                done();
            });

            this.stateMachine.one(CombineStatus.Pause, (_last, _current, done): void => {
                this.whiteboard!.play();
                done();
            });

            this.stateMachine.one(CombineStatus.ToPlay, (_last, _current, done): void => {
                this.videoJS!.play();
                done();
            });

            this.stateMachine.one(CombineStatus.Playing, (_last, _current, done): void => {
                this.statusCallBack(CombineStatus.Playing);
                this.stateMachine.off([
                    CombineStatus.PauseBuffering,
                    CombineStatus.Pause,
                    CombineStatus.ToPause,
                    CombineStatus.Disabled,
                ]);
                clearVideoAndWhiteboardEvents();
                done();
                next();
            });

            this.whiteboardEventEmitter.one("buffering", whiteboardOnBuffering);

            this.whiteboardEventEmitter.one("playing", whiteboardOnPlaying);

            this.videoJS!.on("playing", videoOnPlaying);

            this.videoJS!.one("pause", videoOnPause);

            this.videoJS!.play();
        } else {
            this.stateMachine.lockStatus(
                [
                    CombineStatus.Disabled,
                    CombineStatus.ToPause,
                    CombineStatus.ToPlay,
                    CombineStatus.Playing,
                ],
                [CombineStatus.Playing],
            );

            const whiteboardOnBuffering = (): void => {
                this.stateMachine.emit("whiteboard", Status.PlayingBuffering);
            };

            const whiteboardOnPlaying = (): void => {
                this.stateMachine.emit("whiteboard", Status.Playing);
            };

            const whiteboardOnPause = (): void => {
                this.stateMachine.emit("whiteboard", Status.Pause);
            };

            const videoOnPlaying = (): void => {
                this.stateMachine.emit("video", Status.Playing);
            };

            const videoOnPlay = (): void => {
                this.stateMachine.emit("video", Status.PlayingBuffering);
            };

            const videoOnPause = (): void => {
                this.stateMachine.emit("video", Status.Pause);
            };

            this.stateMachine.on(CombineStatus.Disabled, (_last, current, done): void => {
                const { videoStatus, whiteboardStatus } = current;

                // 当前路径下，某些情况下是允许进入 Disable 区域的
                if (
                    (videoStatus === Status.PlayingBuffering &&
                        whiteboardStatus === Status.PauseBuffering) ||
                    (videoStatus === Status.PauseBuffering &&
                        whiteboardStatus === Status.PlayingBuffering)
                ) {
                    //  nothing
                } else if (
                    (videoStatus === Status.Playing &&
                        whiteboardStatus === Status.PauseBuffering) ||
                    (videoStatus === Status.PauseBuffering && whiteboardStatus === Status.Playing)
                ) {
                    // 这里是因为有可能存在，有一端已经开始播放了，但是另一端还在 pauseBuffering 状态。所以需要把播放的一端进行暂停
                    if (videoStatus === Status.Playing) {
                        this.videoJS!.pause();
                    } else {
                        this.whiteboard!.pause();
                    }
                } else {
                    this.taskQueue.clear();
                    this.statusCallBack(
                        CombineStatus.Disabled,
                        ACCIDENT_ENTERED_DISABLED_BY_ALL_IS_PAUSE_BUFFERING,
                    );
                    this.stateMachine.unLockStatus();
                    this.stateMachine.off([
                        CombineStatus.ToPause,
                        CombineStatus.ToPlay,
                        CombineStatus.Playing,
                    ]);
                    this.whiteboardEventEmitter.removeListener("buffering", whiteboardOnBuffering);
                    this.whiteboardEventEmitter.removeListener("playing", whiteboardOnPlaying);
                    this.whiteboardEventEmitter.removeListener("pause", whiteboardOnPause);
                    this.videoJS!.off("playing", videoOnPlaying);
                    this.videoJS!.off("play", videoOnPlay);
                    this.videoJS!.off("pause", videoOnPause);

                    done();
                    next();
                    return;
                }

                done();
            });

            this.stateMachine.one(CombineStatus.ToPause, (_last, current, done): void => {
                if (current.videoStatus === Status.Playing) {
                    this.videoJS!.pause();
                } else {
                    this.whiteboard!.pause();
                }

                done();
            });

            this.stateMachine.one(CombineStatus.ToPlay, (_last, current, done): void => {
                if (current.videoStatus === Status.Playing) {
                    this.whiteboard!.play();
                } else {
                    this.videoJS!.play();
                }

                done();
            });

            this.stateMachine.one(CombineStatus.Playing, (_last, _current, done): void => {
                this.statusCallBack(CombineStatus.Playing);
                this.videoJS!.off("playing", videoOnPlaying);
                this.stateMachine.off(CombineStatus.Disabled);
                this.whiteboardEventEmitter.removeListener("playing", whiteboardOnPlaying);
                done();
                next();
            });

            this.whiteboardEventEmitter.one("buffering", whiteboardOnBuffering);

            this.whiteboardEventEmitter.addListener("playing", whiteboardOnPlaying);

            this.whiteboardEventEmitter.one("pause", whiteboardOnPause);

            this.videoJS!.on("playing", videoOnPlaying);

            this.videoJS!.one("play", videoOnPlay);

            this.videoJS!.one("pause", videoOnPause);

            this.videoJS!.play();
            this.whiteboard!.play();
        }
    }

    /**
     * 在 ended 状态下，用户调用播放时的处理
     * @param {AnyFunction} next - 完成，开始下一个
     * @private
     */
    private $playByEnded(next: AnyFunction): void {
        this.statusCallBack(CombineStatus.PlayingBuffering);
        this.stateMachine.lockStatus(
            [CombineStatus.Disabled, CombineStatus.Pause],
            [CombineStatus.Pause, CombineStatus.Disabled],
        );

        const whiteboardOnPause = (): void => {
            this.stateMachine.emit("whiteboard", Status.Pause);
        };

        const videoOnCanplay = (): void => {
            this.stateMachine.emit("video", Status.Pause);
        };

        this.stateMachine.one(CombineStatus.Disabled, (_last, _current, done): void => {
            this.taskQueue.clear();
            this.statusCallBack(CombineStatus.Disabled, ACCIDENT_ENTERED_DISABLED_BY_ENDED);
            this.whiteboardEventEmitter.removeListener("pause", whiteboardOnPause);
            this.stateMachine.off(CombineStatus.Pause);
            this.videoJS!.off("canplay", videoOnCanplay);
            done();
            next();
        });

        this.stateMachine.one(CombineStatus.Pause, (_last, _current, done): void => {
            this.play();
            done();
            next();
        });

        this.whiteboardEventEmitter.one("pause", whiteboardOnPause);

        this.videoJS!.one("canplay", videoOnCanplay);

        this.whiteboard!.seekToProgressTime(0);
        this.videoJS!.currentTime(0);
    }

    /**
     * 在 playing 状态下，用户调用暂停时的处理
     * @param {AnyFunction} next - 完成，开始下一个
     * @private
     */
    private $pauseByPlaying(next: AnyFunction): void {
        this.stateMachine.lockStatus(
            [CombineStatus.Disabled, CombineStatus.Pause],
            [CombineStatus.Pause, CombineStatus.Disabled],
        );

        const whiteboardOnPause = (): void => {
            this.stateMachine.emit("whiteboard", Status.Pause);
        };

        const videoOnPause = (): void => {
            this.stateMachine.emit("video", Status.Pause);
        };

        this.stateMachine.one(CombineStatus.Disabled, (_last, _current, done): void => {
            this.taskQueue.clear();
            this.statusCallBack(CombineStatus.Disabled, ACCIDENT_ENTERED_DISABLED_BY_PLAYING);
            this.stateMachine.off(CombineStatus.Pause);
            this.whiteboardEventEmitter.removeListener("pause", whiteboardOnPause);
            this.videoJS!.off("pause", videoOnPause);
            done();
        });

        this.stateMachine.one(CombineStatus.Pause, (_last, _current, done): void => {
            this.statusCallBack(CombineStatus.Pause);
            done();
            next();
        });

        this.whiteboardEventEmitter.one("pause", whiteboardOnPause);

        this.videoJS!.one("pause", videoOnPause);

        this.whiteboard!.pause();
        this.videoJS!.pause();
    }

    /**
     * 当在 playing 阶段时，用户调用 seek 时的处理
     * @param {AnyFunction} next - 完成，开始下一个
     * @param {number} ms - 将要 seek 到的时间点
     * @private
     */
    private $seekByPlaying(next: AnyFunction, ms: number): void {
        this.statusCallBack(CombineStatus.PlayingSeeking);

        const whiteboardDuration = this.whiteboard!.timeDuration;
        const videoDuration = this.videoJS!.duration() * 1000;

        this.stateMachine.lockStatus(
            [
                CombineStatus.Disabled,
                CombineStatus.Pause,
                CombineStatus.Ended,
                CombineStatus.PlayingSeeking,
            ],
            [CombineStatus.Pause, CombineStatus.Ended, CombineStatus.Disabled],
        );

        const whiteboardOnBuffering = (): void => {
            this.stateMachine.emit("whiteboard", Status.PlayingSeeking);
        };

        const whiteboardOnPause = (): void => {
            if (ms < whiteboardDuration) {
                this.stateMachine.emit("whiteboard", Status.Pause);
            }
        };

        const whiteboardOnPlaying = (): void => {
            this.whiteboard!.pause();
        };

        const whiteboardOnEnded = (): void => {
            this.stateMachine.emit("whiteboard", Status.Ended);
        };

        const videoOnSeeking = (): void => {
            this.stateMachine.emit("video", Status.PlayingSeeking);
        };

        const videoOnPause = (): void => {
            if (ms < videoDuration) {
                this.stateMachine.emit("video", Status.Pause);
            }
        };

        const videoOnPlaying = (): void => {
            this.videoJS!.pause();
        };

        const videoOnEnded = (): void => {
            this.stateMachine.emit("video", Status.Ended);
        };

        const clearVideoAndWhiteboardEvents = (): void => {
            this.whiteboardEventEmitter.removeListener("buffering", whiteboardOnBuffering);
            this.whiteboardEventEmitter.removeListener("pause", whiteboardOnPause);
            this.whiteboardEventEmitter.removeListener("playing", whiteboardOnPlaying);
            this.whiteboardEventEmitter.removeListener("ended", whiteboardOnEnded);
            this.videoJS!.off("seeking", videoOnSeeking);
            this.videoJS!.off("pause", videoOnPause);
            this.videoJS!.off("playing", videoOnPlaying);
            this.videoJS!.off("ended", videoOnEnded);
        };

        this.stateMachine.one(CombineStatus.Disabled, (_last, _current, done): void => {
            this.taskQueue.clear();
            this.statusCallBack(
                CombineStatus.Disabled,
                ACCIDENT_ENTERED_DISABLED_BY_SEEKING_PLAYING,
            );
            this.stateMachine.off([
                CombineStatus.Pause,
                CombineStatus.Ended,
                CombineStatus.PlayingSeeking,
            ]);
            clearVideoAndWhiteboardEvents();
            done();
        });

        this.stateMachine.one(CombineStatus.Pause, (_last, _current, done): void => {
            this.stateMachine.off([CombineStatus.Ended, CombineStatus.Disabled]);
            clearVideoAndWhiteboardEvents();
            this.play();
            done();
            next();
        });

        this.stateMachine.one(CombineStatus.Ended, (_last, _current, done): void => {
            this.statusCallBack(CombineStatus.Ended);
            this.stateMachine.off([CombineStatus.Pause, CombineStatus.Disabled]);
            clearVideoAndWhiteboardEvents();
            done();
            next();
        });

        this.stateMachine.one(CombineStatus.PlayingSeeking, (_last, current, done): void => {
            const { videoStatus, whiteboardStatus } = current;

            // 如果当前 seek 的时间没有超过 whiteboard，并且 当前 video 状态为 ended 时，才对 whiteboard 调用暂停。否则不需要
            if (videoStatus === Status.Ended && ms < whiteboardDuration) {
                this.whiteboard!.pause();
            } else if (whiteboardStatus === Status.Ended && ms < videoDuration) {
                this.videoJS!.pause();
            }

            done();
        });

        this.videoJS!.one("seeking", videoOnSeeking);

        this.videoJS!.one("pause", videoOnPause);

        this.videoJS!.one("playing", videoOnPlaying);

        this.videoJS!.one("ended", videoOnEnded);

        this.whiteboardEventEmitter.one("buffering", whiteboardOnBuffering);

        this.whiteboardEventEmitter.one("pause", whiteboardOnPause);

        this.whiteboardEventEmitter.one("playing", whiteboardOnPlaying);

        this.whiteboardEventEmitter.one("ended", whiteboardOnEnded);

        this.whiteboard!.seekToProgressTime(ms);
        this.videoJS!.currentTime(ms / 1000);
    }

    /**
     * 当在 pause 阶段时，用户调用 seek 时的处理
     * @param {AnyFunction} next - 完成，开始下一个
     * @param {number} ms - 将要 seek 到的时间点
     * @private
     */
    private $seekByPause(next: AnyFunction, ms: number): void {
        this.statusCallBack(CombineStatus.PauseSeeking);

        this.stateMachine.lockStatus(
            [CombineStatus.Disabled, CombineStatus.Pause, CombineStatus.Ended],
            [CombineStatus.Pause, CombineStatus.Ended],
        );

        const whiteboardDuration = this.whiteboard!.timeDuration;
        const videoDuration = this.videoJS!.duration() * 1000;

        const videoOnSeeking = (): void => {
            this.stateMachine.emit("video", Status.PauseSeeking);
        };

        const videoOnCanplay = (): void => {
            this.stateMachine.emit("video", Status.Pause);
        };

        const videoOnEnded = (): void => {
            this.stateMachine.emit("video", Status.Ended);
        };

        const whiteboardOnBuffering = (): void => {
            this.stateMachine.emit("whiteboard", Status.PauseSeeking);
        };

        const whiteboardOnPause = (): void => {
            this.stateMachine.emit("whiteboard", Status.Pause);
        };

        const whiteboardOnEnded = (): void => {
            this.stateMachine.emit("whiteboard", Status.Ended);
        };

        const clearVideoAndWhiteboardEvents = (): void => {
            this.videoJS!.off("seeking", videoOnSeeking);
            this.videoJS!.off("canplay", videoOnCanplay);
            this.videoJS!.off("ended", videoOnEnded);
            this.whiteboardEventEmitter.removeListener("buffering", whiteboardOnBuffering);
            this.whiteboardEventEmitter.removeListener("pause", whiteboardOnPause);
            this.whiteboardEventEmitter.removeListener("ended", whiteboardOnEnded);
        };

        this.stateMachine.one(CombineStatus.Disabled, (_last, _current, done): void => {
            const { current: videoStatus } = this.stateMachine.getStatus("video");
            const { current: whiteboardStatus } = this.stateMachine.getStatus("whiteboard");

            if (videoStatus === Status.PauseSeeking || whiteboardStatus === Status.PauseSeeking) {
                return done();
            }

            this.taskQueue.clear();
            this.statusCallBack(CombineStatus.Disabled, ACCIDENT_ENTERED_DISABLED_BY_SEEKING_PAUSE);
            this.stateMachine.unLockStatus();
            clearVideoAndWhiteboardEvents();
            this.stateMachine.off([CombineStatus.Ended, CombineStatus.Pause]);
            done();
            next();
        });

        this.stateMachine.one(CombineStatus.Pause, (_last, _current, done): void => {
            // 当 ms 超过 video 视频的持续时间时，说明最终的状态是 Ended，而非 Pause，所以这里需要跳过
            if (ms >= videoDuration) {
                return done();
            }

            this.statusCallBack(CombineStatus.Pause);
            this.stateMachine.off(CombineStatus.Ended);
            clearVideoAndWhiteboardEvents();
            done();
            next();
        });

        this.stateMachine.on(CombineStatus.Ended, (_last, current, done): void => {
            // 如果要 seek 的时间超过了视频本身的持续时间，并且为 Pause，则跳过。因为它迟早会跳到 Ended 状态
            if (ms >= whiteboardDuration && current.whiteboardStatus === Status.Pause) {
                return done();
            } else if (ms >= videoDuration && current.videoStatus === Status.Pause) {
                return done();
            }

            this.statusCallBack(CombineStatus.Ended);
            this.stateMachine.off([CombineStatus.Pause, CombineStatus.Ended]);
            clearVideoAndWhiteboardEvents();
            done();
            next();
        });

        this.videoJS!.one("seeking", videoOnSeeking);

        // 在 pause 状态时，如果 video seek 完成，最终的事件是 canplay 事件，而非 pause 事件
        this.videoJS!.one("canplay", videoOnCanplay);

        this.videoJS!.one("ended", videoOnEnded);

        this.whiteboardEventEmitter.one("buffering", whiteboardOnBuffering);

        this.whiteboardEventEmitter.one("pause", whiteboardOnPause);

        this.whiteboardEventEmitter.one("ended", whiteboardOnEnded);

        this.whiteboard!.seekToProgressTime(ms);
        this.videoJS!.currentTime(ms / 1000);

        // 这是一个 video 的 bug
        // 当 video 处于 pause 状态时，我们 seek 到视频的终点时间戳时或者超过终点时间戳时，并不会去触发 Ended，需要等 seek 结束后，再进行一次 seek，才能正确触发 Ended 事件
        if (ms >= videoDuration) {
            this.videoJS!.one("seeked", () => {
                this.videoJS!.currentTime(ms / 1000);
            });
        }
    }

    /**
     * 当 video 处于 waiting 状态，插件自动暂停白板的处理
     * @param {AnyFunction} next - 完成，开始下一个
     * @private
     */
    private $pauseWhiteboardByVideoWaiting(next: AnyFunction): void {
        // 因为当 video 丢帧时，会触发多次的 waiting，而后面的 waiting 也会到达这里
        // 当 whiteboard 处于 pause 状态时，再次调用 pause 方法时，是不会触发 pause 事件的。所以需要提前进行判断。
        if (this.whiteboard!.phase === "pause") {
            this.stateMachine.emit("whiteboard", Status.Pause);
            return next();
        }

        this.whiteboardEventEmitter.one("pause", (): void => {
            this.stateMachine.emit("whiteboard", Status.Pause);
            next();
        });

        this.whiteboard!.pause();
    }

    /**
     * 当 video 处于 playing 状态时，插件自动调用 video 的播放方法
     * @param {AnyFunction} next - 完成，开始下一个
     * @param {boolean} isDropFrame - 是否丢帧
     * @private
     */
    private $playingWhiteboardByVideoPlaying(next: AnyFunction, isDropFrame: boolean): void {
        // video 丢帧时的处理
        // 我们会先把 video 进行暂停，然后对 whiteboard 进行 seek 校准
        // 而 whiteboard seek 校准时，会触发: buffering -> pause(因为在调用此函数之前，我们是能够保证 whiteboard 一定是暂停状态，所以 whiteboard seek 完成后，就一定会回到 pause 状态)
        // 当 whiteboard 到达 pause 时(此时 video 也是处于 pause 状态)，我们就可以使用插件的 play 方法，来间接调用 $playByPauseBuffering 方法，让其播放
        if (isDropFrame) {
            this.whiteboardEventEmitter.one("pause", (): void => {
                // 因为当我们对 whiteboard 进行 seek 后，如果后面调用播放，会先进入 buffering 阶段。所以这里设置 whiteboard 状态 为 pause-buffering 状态
                this.stateMachine.emit("whiteboard", Status.PauseBuffering);
                this.play();
                next();
            });

            this.videoJS!.one("pause", (): void => {
                this.stateMachine.emit("video", Status.Pause);
                this.whiteboard!.seekToProgressTime(this.videoJS!.currentTime() * 1000);
            });

            this.videoJS!.pause();
        } else {
            // video 在播放状态时，由于网络问题，导致 video 需要缓冲。现缓存完毕，开始让 whiteboard 播放
            this.stateMachine.emit("video", Status.Playing);

            this.stateMachine.one(CombineStatus.Playing, (_last, _current, done): void => {
                this.statusCallBack(CombineStatus.Playing);
                done();
                next();
            });

            this.whiteboardEventEmitter.one("playing", (): void => {
                this.stateMachine.emit("whiteboard", Status.Playing);
            });

            this.whiteboard!.play();
        }
    }

    /**
     * 当 whiteboard 为 buffering 时，插件自动调用 video 的 暂停方法
     * @param next
     * @private
     */
    private $pauseVideoByWhiteboardBuffering(next: AnyFunction): void {
        // 当 video 处于 pause 状态时，再次调用 pause 方法时，是不会触发 pause 事件的。所以需要提前进行判断。
        if (this.videoJS!.paused()) {
            this.stateMachine.emit("video", Status.Pause);
            return next();
        }

        this.videoJS!.one("pause", (): void => {
            this.stateMachine.emit("video", Status.Pause);
            next();
        });

        this.videoJS!.pause();
    }

    /**
     * 当 whiteboard 为 playing 时，插件自动调用 video 的播放方法
     * @param {AnyFunction} next - 完成，开始下一个
     * @private
     */
    private $playingVideoByWhiteboardPlaying(next: AnyFunction): void {
        this.stateMachine.one(CombineStatus.ToPlay, (_last, _current, done): void => {
            this.videoJS!.play();
            done();
        });

        this.stateMachine.one(CombineStatus.Playing, (_last, _current, done): void => {
            this.statusCallBack(CombineStatus.Playing);
            done();
            next();
        });

        this.videoJS!.one("playing", (): void => {
            this.stateMachine.emit("video", Status.Playing);
        });

        this.stateMachine.emit("whiteboard", Status.Playing);
    }

    /**
     * 当 whiteboard 处于 ended 状态时，插件自动调用 video 的暂停方法
     * @param {AnyFunction} next - 完成，开始下一个
     * @private
     */
    private $pauseVideoByWhiteboardEnded(next: AnyFunction): void {
        this.stateMachine.one(CombineStatus.Ended, (_last, _current, done): void => {
            this.statusCallBack(CombineStatus.Ended);
            done();
            next();
        });

        this.videoJS!.one("pause", (): void => {
            this.stateMachine.emit("video", Status.Pause);
        });

        this.videoJS!.pause();
    }

    /**
     * 当 video 处于 ended 状态时，插件自动调用 whiteboard 的 暂停方法
     * @param next
     * @private
     */
    private $pauseWhiteboardByVideoEnded(next: AnyFunction): void {
        this.stateMachine.one(CombineStatus.Ended, (_last, _current, done): void => {
            this.statusCallBack(CombineStatus.Ended);
            done();
            next();
        });

        this.whiteboardEventEmitter.one("pause", (): void => {
            this.stateMachine.emit("whiteboard", Status.Pause);
        });

        this.whiteboard!.pause();
    }

    /**
     * 改变 修改源
     * @param {AnyFunction} next - 完成，开始下一个
     * @param {TriggerSource} source - 修改源
     * @private
     */
    private $setTriggerSource(next: AnyFunction, source: TriggerSource): void {
        this.triggerSource = source;
        next();
    }

    /**
     * 获取 video 是否处于可播放状态
     * @private
     */
    private videoIsCanplay(): boolean {
        // 此状态见: https://developer.mozilla.org/zh-CN/docs/Web/API/HTMLMediaElement/readyState
        return this.videoJS!.readyState() > 2;
    }
}
