import videojs, { VideoJsPlayer } from "video.js";
import { Player, PlayerPhase } from "white-web-sdk";
import {
    AnyFunction,
    VideoOptions,
    DefaultOptions,
    PublicCombinedStatus,
    TriggerSource,
} from "./Types";
import { StateMachine } from "./StateMachine";
import { verifyInstanceParams } from "./Verification";
import { CombineStatus, Status } from "./StatusContant";
import { EventEmitter } from "./EventEmitter";
import { TaskQueue } from "./TaskQueue";
import {
    ACCIDENT_ENTERED_DISABLED_BY_ALL_IS_PAUSE,
    ACCIDENT_ENTERED_DISABLED_BY_ALL_IS_PAUSE_BUFFERING,
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

export default class CombinePlayer {
    private videoJS: VideoJsPlayer | undefined = undefined;
    private whiteboarder: undefined | Player = undefined;
    private readonly videoOptions: VideoOptions | undefined = undefined;
    private readonly stateMachine: StateMachine;

    private statusCallBack: (status: PublicCombinedStatus, message?: string) => any = () => {};

    private triggerSource: TriggerSource = "none";

    private readonly whiteboarderEventEmitter = new EventEmitter();
    private readonly taskQueue = new TaskQueue();

    /**
     * 实例化 Combine-Player 插件
     * @param {VideoOptions} [videoOptions=DefaultOptions] - video 配置项
     * @param {boolean} [debug=false] - 是否开启 debug 日志
     */
    public constructor(videoOptions: VideoOptions, debug = false) {
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
     * @param {Player} whiteboarder - 白板实例
     */
    public setWhiteboarder(whiteboarder: Player): void {
        this.whiteboarder = whiteboarder;

        // 这里 提前进行了状态机改变，因为回放在 seek 时，不会触发 Buffering 事件，所以在这里需要提前设置。以保证状态正确
        this.stateMachine.emit("whiteboarder", Status.PauseBuffering);
        // 先seek到第一帧，以拿到 whiteboarder 的状态。否则 whiteboarder 会永远在 waitingFirstFrame 状态，isPlayable 也会一直是 false
        this.whiteboarder.seekToProgressTime(0);
        this.initWhiteboarderEvents();
    }

    /**
     * 设置白板的事件回调
     * @param {PlayerPhase} phase - 事件名称
     */
    public setWhiteboarderEvents(phase: PlayerPhase): void {
        this.whiteboarderEventEmitter.emit(phase);
    }

    /**
     * 设置 回放 的 isPlayable 事件
     * @param {boolean} isPlayable - 是否可播放
     */
    public setWhiteboarderIsPlayable(isPlayable: boolean): void {
        const status = this.stateMachine.getStatus("whiteboarder").current;

        // 当 当前回放确认已经加载好了，并且当前 回放 的状态为 PauseBuffering 时，就可以把 回放 的状态修改为 Pause 状态了
        if (isPlayable && status === Status.PauseBuffering) {
            this.stateMachine.emit("whiteboarder", Status.Pause);
        }
    }

    /**
     * 状态通知监听
     * @param {(status: PublicCombinedStatus) => any} cb - 状态发生回调
     */
    public on(cb: (status: PublicCombinedStatus, message?: string) => any): void {
        // 使用 Promise 封装一层，转为异步，以保证用户传入的参数不会影响到插件本身。
        this.statusCallBack = (status, message?) => {
            Promise.resolve().then(() => {
                cb(status, message);
            });
        };
    }

    /**
     * 插件的播放处理
     */
    public play(): void {
        this.taskQueue.add(done => this.$setTriggerSource(done, "manual"));

        const currentCombinedStatus = this.stateMachine.getCombinationStatus().current;

        if (currentCombinedStatus === CombineStatus.Pause) {
            this.taskQueue.add(next => this.$playByPause(next));
        } else if (currentCombinedStatus === CombineStatus.PauseBuffering) {
            this.taskQueue.add(next => this.$playByPauseBuffering(next));
        }

        this.taskQueue.add(done => this.$setTriggerSource(done, "none"));
    }

    /**
     * 插件的暂停处理
     */
    public pause(): void {
        this.taskQueue.add(done => this.$setTriggerSource(done, "manual"));

        const currentCombinedStatus = this.stateMachine.getCombinationStatus().current;

        if (currentCombinedStatus === CombineStatus.Playing) {
            this.taskQueue.add(next => this.$pauseByPlaying(next));
        }

        this.taskQueue.add(done => this.$setTriggerSource(done, "none"));
    }

    // 初始化 video.js
    private initVideoJS(): void {
        const videoJS = videojs(this.videoOptions!.videoDOM, this.videoOptions!.videoJsOptions);
        videoJS.src(this.videoOptions!.url);

        this.videoJS = videoJS;

        const videoIsCanplay = this.videoIsCanplay();
        this.stateMachine.emit("video", videoIsCanplay ? Status.Pause : Status.PauseBuffering);

        this.initVideoJSEvents();
    }

    /**
     * 初始化 video.js 的监听事件
     * @private
     */
    private initVideoJSEvents(): void {
        /**
         * 中间处理件，判断当前回调是否应该调用真正的回调
         * @param cb
         */
        const warp = (cb: AnyFunction): AnyFunction => {
            return (): void => {
                // 如果当前是事件是由用户手动触发，则跳过。不做处理
                if (this.triggerSource === "none" || this.triggerSource === "video") {
                    this.taskQueue.add(done => this.$setTriggerSource(done, "video"));
                    cb();
                }
            };
        };

        this.videoJS!.on("canplay", () => {
            // 如果当前 video 处于 PauseBuffering 状态，则通知状态机，加载完成。改为 Pause 状态
            if (this.stateMachine.getStatus("video").current === Status.PauseBuffering) {
                this.stateMachine.emit("video", Status.Pause);
            }
        });

        this.videoJS!.on(
            "waiting",
            warp(() => {
                this.stateMachine.emit("video", Status.PlayingBuffering);
                // 这里进行提前通知，因为如果放在 taskQueue 里时，无法保证用户能第一时间感知到当前视频处于 playing-buffering 状态
                this.statusCallBack(CombineStatus.PlayingBuffering);
                this.taskQueue.add(next => this.$pauseWhiteboarderByVideoWaiting(next));
                this.taskQueue.add(done => this.$setTriggerSource(done, "none"));
            }),
        );

        this.videoJS!.on(
            "playing",
            warp(() => {
                this.taskQueue.add(next => this.$playingWhiteboarderByVideoPlaying(next));
                this.taskQueue.add(next => this.$setTriggerSource(next, "none"));
            }),
        );
    }

    private initWhiteboarderEvents(): void {
        /**
         * 中间处理件，判断当前回调是否应该调用真正的回调
         * @param cb
         */
        const warp = (cb: AnyFunction): AnyFunction => {
            return (): void => {
                // 如果当前是事件是由用户手动触发，则跳过。不做处理
                if (this.triggerSource === "none" || this.triggerSource === "whiteboarder") {
                    this.taskQueue.add(done => this.$setTriggerSource(done, "whiteboarder"));
                    cb();
                }
            };
        };

        this.whiteboarderEventEmitter.addListener(
            "buffering",
            warp(() => {
                this.stateMachine.emit("whiteboarder", Status.PlayingBuffering);
                this.statusCallBack(CombineStatus.PlayingBuffering);
                this.taskQueue.add(next => this.$pauseVideoByWhiteboarderBuffering(next));
                this.taskQueue.add(next => this.$setTriggerSource(next, "none"));
            }),
        );

        this.whiteboarderEventEmitter.addListener(
            "playing",
            warp(() => {
                this.taskQueue.add(next => this.$playingVideoByWhiteboarderPlaying(next));
                this.taskQueue.add(next => this.$setTriggerSource(next, "none"));
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
            [CombineStatus.Playing],
        );

        this.stateMachine.on(CombineStatus.Disabled, (_last, _current, done) => {
            this.taskQueue.clear();
            this.statusCallBack(CombineStatus.Disabled, ACCIDENT_ENTERED_DISABLED_BY_ALL_IS_PAUSE);
            done();
        });

        this.stateMachine.on(CombineStatus.Playing, (_last, _current, done) => {
            this.statusCallBack(CombineStatus.Playing);
            this.stateMachine.un(CombineStatus.Disabled);
            done();
            next();
        });

        this.whiteboarderEventEmitter.one("playing", () => {
            this.stateMachine.emit("whiteboarder", Status.Playing);
        });

        this.stateMachine.one(CombineStatus.ToPlay, (_last, _current, done) => {
            this.whiteboarder!.play();
            done();
        });

        this.videoJS!.one("playing", () => {
            this.stateMachine.emit("video", Status.Playing);
        });

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
        const whiteboarderStatus = this.stateMachine.getStatus("whiteboarder").current;

        if (videoStatus === Status.PauseBuffering && whiteboarderStatus === Status.Pause) {
            this.stateMachine.lockStatus(
                [
                    CombineStatus.Disabled,
                    CombineStatus.PlayingBuffering,
                    CombineStatus.ToPlay,
                    CombineStatus.Playing,
                ],
                [CombineStatus.Playing],
            );

            this.stateMachine.on(CombineStatus.Disabled, (_last, _current, done) => {
                this.taskQueue.clear();
                this.statusCallBack(
                    CombineStatus.Disabled,
                    ACCIDENT_ENTERED_DISABLED_BY_VIDEO_IS_PAUSE_BUFFERING,
                );
                done();
            });

            this.whiteboarderEventEmitter.one("playing", () => {
                this.stateMachine.emit("whiteboarder", Status.Playing);
            });

            this.stateMachine.one(CombineStatus.ToPlay, (_last, _current, done) => {
                this.whiteboarder!.play();
                done();
            });

            this.stateMachine.one(CombineStatus.Playing, (_last, _current, done) => {
                this.statusCallBack(CombineStatus.Playing);
                this.stateMachine.un(CombineStatus.Disabled);
                done();
                next();
            });

            this.videoJS!.one("play", () => {
                this.stateMachine.emit("video", Status.PlayingBuffering);
            });

            this.videoJS!.one("playing", () => {
                this.stateMachine.emit("video", Status.Playing);
            });

            this.videoJS!.play();
        } else if (videoStatus === Status.Pause && whiteboarderStatus === Status.PauseBuffering) {
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

            this.stateMachine.on(CombineStatus.Disabled, (_last, current, done) => {
                // 当前路径下，是允许进入 Disable 区域的(video 为 playing，whiteboarder 为 pauseBuffering)
                if (
                    current.videoStatus === Status.Playing &&
                    current.whiteboarderStatus === Status.PauseBuffering
                ) {
                    this.videoJS!.pause();
                } else {
                    this.taskQueue.clear();
                    this.statusCallBack(
                        CombineStatus.Disabled,
                        ACCIDENT_ENTERED_DISABLED_BY_WHITEBOARDER_IS_PAUSE_BUFFERING,
                    );
                }

                done();
            });

            this.stateMachine.one(CombineStatus.PauseBuffering, (_last, _current, done) => {
                this.whiteboarder!.play();
                done();
            });

            this.stateMachine.one(CombineStatus.Pause, (_last, _current, done) => {
                this.whiteboarder!.play();
                done();
            });

            this.stateMachine.one(CombineStatus.PlayingBuffering, (_last, _current, done) => {
                this.statusCallBack(CombineStatus.PlayingBuffering);
                done();
            });

            this.stateMachine.one(CombineStatus.ToPlay, (_last, _current, done) => {
                this.videoJS!.play();
                done();
            });

            this.stateMachine.one(CombineStatus.Playing, (_last, _current, done) => {
                this.statusCallBack(CombineStatus.Playing);
                this.videoJS!.off("playing");
                this.stateMachine.un(CombineStatus.Disabled);
                done();
                next();
            });

            this.whiteboarderEventEmitter.one("buffering", () => {
                this.stateMachine.emit("whiteboarder", Status.PlayingBuffering);
            });

            this.whiteboarderEventEmitter.one("playing", () => {
                this.stateMachine.emit("whiteboarder", Status.Playing);
            });

            this.videoJS!.on("playing", () => {
                this.stateMachine.emit("video", Status.Playing);
            });

            this.videoJS!.one("pause", () => {
                this.stateMachine.emit("video", Status.Pause);
            });

            this.videoJS!.play();
        } else {
            this.stateMachine.lockStatus(
                [
                    CombineStatus.Disabled,
                    CombineStatus.PlayingBuffering,
                    CombineStatus.ToPause,
                    CombineStatus.ToPlay,
                    CombineStatus.Playing,
                ],
                [CombineStatus.Playing],
            );

            this.stateMachine.on(CombineStatus.Disabled, (_last, current, done) => {
                const { videoStatus, whiteboarderStatus } = current;

                // 当前路径下，某些情况下是允许进入 Disable 区域的
                if (
                    (videoStatus === Status.PlayingBuffering &&
                        whiteboarderStatus === Status.PauseBuffering) ||
                    (videoStatus === Status.PauseBuffering &&
                        whiteboarderStatus === Status.PlayingBuffering)
                ) {
                    //  nothing
                } else if (
                    (videoStatus === Status.Playing &&
                        whiteboarderStatus === Status.PauseBuffering) ||
                    (videoStatus === Status.PauseBuffering && whiteboarderStatus === Status.Playing)
                ) {
                    // 这里是因为有可能存在，有一端已经开始播放了，但是另一端还在 pauseBuffering 状态。所以需要把播放的一端进行暂停
                    if (videoStatus === Status.Playing) {
                        this.videoJS!.pause();
                    } else {
                        this.whiteboarder!.pause();
                    }
                } else {
                    this.taskQueue.clear();
                    this.statusCallBack(
                        CombineStatus.Disabled,
                        ACCIDENT_ENTERED_DISABLED_BY_ALL_IS_PAUSE_BUFFERING,
                    );
                }

                done();
            });

            this.stateMachine.one(CombineStatus.PlayingBuffering, (_last, _current, done) => {
                this.statusCallBack(CombineStatus.PlayingBuffering);
                done();
            });

            this.stateMachine.one(CombineStatus.ToPause, (_last, current, done) => {
                if (current.videoStatus === Status.Playing) {
                    this.videoJS!.pause();
                } else {
                    this.whiteboarder!.pause();
                }

                done();
            });

            this.stateMachine.one(CombineStatus.ToPlay, (_last, current, done) => {
                if (current.videoStatus === Status.Playing) {
                    this.whiteboarder!.play();
                } else {
                    this.videoJS!.play();
                }

                done();
            });

            this.stateMachine.one(CombineStatus.Playing, (_last, _current, done) => {
                this.statusCallBack(CombineStatus.Playing);
                this.videoJS!.off("playing");
                this.stateMachine.un(CombineStatus.Disabled);
                this.whiteboarderEventEmitter.removeAllListener("playing");
                done();
                next();
            });

            this.whiteboarderEventEmitter.one("buffering", () => {
                this.stateMachine.emit("whiteboarder", Status.PlayingBuffering);
            });

            this.whiteboarderEventEmitter.addListener("playing", () => {
                this.stateMachine.emit("whiteboarder", Status.Playing);
            });

            this.whiteboarderEventEmitter.one("pause", () => {
                this.stateMachine.emit("whiteboarder", Status.Pause);
            });

            this.videoJS!.on("playing", () => {
                this.stateMachine.emit("video", Status.Playing);
            });

            this.videoJS!.one("play", () => {
                this.stateMachine.emit("video", Status.PlayingBuffering);
            });

            this.videoJS!.one("pause", () => {
                this.stateMachine.emit("video", Status.Pause);
            });

            this.videoJS!.play();
            this.whiteboarder!.play();
        }
    }

    /**
     * 在 playing 状态下，用户调用暂停时的处理
     * @param {AnyFunction} next - 完成，开始下一个
     * @private
     */
    private $pauseByPlaying(next: AnyFunction): void {
        this.stateMachine.lockStatus(
            [CombineStatus.Disabled, CombineStatus.Pause],
            [CombineStatus.Pause],
        );

        this.stateMachine.one(CombineStatus.Pause, (_last, _current, done) => {
            this.statusCallBack(CombineStatus.Pause);
            done();
            next();
        });

        this.whiteboarderEventEmitter.one("pause", () => {
            this.stateMachine.emit("whiteboarder", Status.Pause);
        });

        this.videoJS!.one("pause", () => {
            this.stateMachine.emit("video", Status.Pause);
        });

        this.whiteboarder!.pause();
        this.videoJS!.pause();
    }

    /**
     * 当 video 处于 waiting 状态，插件自动暂停白板的处理
     * @param {AnyFunction} next - 完成，开始下一个
     * @private
     */
    private $pauseWhiteboarderByVideoWaiting(next: AnyFunction): void {
        // 因为当 video 丢帧时，会触发多次的 waiting，而后面的 waiting 也会到达这里
        // 当 whiteboarder 处于 pause 状态时，再次调用 pause 方法时，是不会触发 pause 事件的。所以需要提前进行判断。
        if (this.whiteboarder!.phase === "pause") {
            return next();
        }

        this.whiteboarderEventEmitter.one("pause", () => {
            next();
        });

        this.whiteboarder!.pause();
    }

    /**
     * 当 video 处于 playing 状态时，插件自动调用 video 的 暂停方法，并且校准 whiteboarder 时间戳，最后开始播放
     * 需要注意的是，这里也会有对 video 丢帧时的处理
     *
     * 能够触发此函数一共两种情况:
     *     1. video 在播放状态时，由于网络问题，导致 video 需要缓冲
     *     2. video 丢帧时
     * 而因为此方法是注册到了 taskQueue 里的，所以我们无法保证此方法是会被立刻调用
     * 所以无论是哪种情况，我们都会先把 video 进行暂停，然后对 whiteboarder 进行 seek 校准
     * 而 whiteboarder seek 校准时，会触发: buffering -> pause(因为在调用此函数之前，我们是能够保证 whiteboarder 一定是暂停状态，所以 whiteboarder seek 完成后，就一定会回到 pause 状态)
     * 当 whiteboarder 到达 pause 时，当前的状态都将是 pause，所以我们就可以使用 $pauseByPlaying 方法，让其播放
     * @param {AnyFunction} next - 完成，开始下一个
     * @private
     */
    private $playingWhiteboarderByVideoPlaying(next: AnyFunction): void {
        this.stateMachine.one(CombineStatus.Pause, (_last, _current, done) => {
            this.play();
            done();
            next();
        });

        this.whiteboarderEventEmitter.one("pause", () => {
            this.stateMachine.emit("whiteboarder", Status.Pause);
        });

        this.videoJS!.one("pause", () => {
            this.stateMachine.emit("video", Status.Pause);
            this.whiteboarder!.seekToProgressTime(this.videoJS!.currentTime() * 1000);
        });

        this.videoJS!.pause();
    }

    /**
     * 当 whiteboarder 为 buffering 时，插件自动调用 video 的 暂停方法
     * @param next
     * @private
     */
    private $pauseVideoByWhiteboarderBuffering(next: AnyFunction): void {
        // 当 video 处于 pause 状态时，再次调用 pause 方法时，是不会触发 pause 事件的。所以需要提前进行判断。
        if (this.videoJS!.paused()) {
            this.stateMachine.emit("video", Status.Pause);
            return next();
        }

        this.videoJS!.one("pause", () => {
            this.stateMachine.emit("video", Status.Pause);
            next();
        });

        this.videoJS!.pause();
    }

    /**
     * 当 whiteboarder 为 playing 时，插件自动调用 video 的播放方法
     * @param {AnyFunction} next - 完成，开始下一个
     * @private
     */
    private $playingVideoByWhiteboarderPlaying(next: AnyFunction): void {
        this.stateMachine.one(CombineStatus.ToPlay, (_last, _current, done) => {
            this.videoJS!.play();
            done();
        });

        this.stateMachine.one(CombineStatus.Playing, (_last, _current, done) => {
            this.statusCallBack(CombineStatus.Playing);
            done();
            next();
        });

        this.videoJS!.one("playing", () => {
            this.stateMachine.emit("video", Status.Playing);
        });

        this.stateMachine.emit("whiteboarder", Status.Playing);
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

    // 获取 video 是否处于可播放状态
    private videoIsCanplay(): boolean {
        // 此状态见: https://developer.mozilla.org/zh-CN/docs/Web/API/HTMLMediaElement/readyState
        return this.videoJS!.readyState() > 2;
    }
}
