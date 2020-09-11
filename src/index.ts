import { Player } from "white-web-sdk";
import { VideoJsPlayer } from "video.js";

export enum ControlStatus {
    READY = "READY",
    NO_READY = "NO_READY",
    BUFFERING = "BUFFERING",
    PLAYING = "PLAYING",
    PAUSE = "PAUSE",
    FAILED = "FAILED",
}

/**
 * 白板音视频同步插件
 * 在实例化的过程中，需要传入 白板、video 的实例对象
 *
 * 在理解过程中，可以把白板回放当做是一个视频流。
 * 其白板是挂载到 video.js 上，换句话说: 白板的播放、暂停是受 video 影响的，由 video 来进行控制
 *
 * 其核心思想为:
 * videoder:
 *      canplay:
 *          - 设置白板回放的进度为 video 的时间(进行同步)
 *      play:
 *          - 设置 videoderLastPlayStatus 的状态为 play
 *            播放 白板回放
 *            # 需要注意的是，此时并不会真正的播放，因为让白板可能也需要缓存，所以当触发了白板回放时，会先暂停 videoder, 等待白板缓存完毕再由白板进行播放
 *      pause:
 *          - 设置 videoderLastPlayStatus 的状态为 pause
 *            暂停 白板回放
 * whiteboarder:
 *      canplay - false:
 *          - 暂停 videoder, 因为此时白板正在缓存
 *      canplay - true:
 *          - 如果 videoderLastPlayStatus 是暂停，则全部暂停
 *          - 如果 videoderLastPlayStatus 是播放，则播放 videoder
 */
export class CombinePlayer {
    private videoder: VideoJsPlayer = {} as VideoJsPlayer; // video.js 的实例对象
    private whiteboarder: Player = {} as Player; // 白板回放的实例对象
    private firstVideoderPlay = true; // video 中的 play 事件是否为第一次触发
    private isFirstCallCanplay = true; // 判断是否是整个生命周期内第一次触发 canplay
    private videoderLastPlayStatus: "pause" | "play" = "pause"; // videoder 最后一次的播放状态
    private dontSetVideoderStatusPause = false; // 是否 不要设置 videoderLastPlayStatus 为 pause
    private readonly statusCallBack: (data: {
        status: ControlStatus;
        reason: string;
    }) => any = () => {};

    public constructor(
        statusCallBack: (data: { status: ControlStatus; reason: string }) => any
    ) {
        this.statusCallBack = (data) => statusCallBack(data);
    }

    // 设置 video.js 实例
    public setVideoder(videoder: VideoJsPlayer) {
        this.videoder = videoder;
        this.checkder();
    }

    // 设置 白板回放实例
    public setWhiteboarder(whiteboarder: Player) {
        this.whiteboarder = whiteboarder;
        this.checkder();
    }

    // 监听白板的 canplay 事件
    public onIsPlayable(isPlayable = false) {
        if (Object.keys(this.whiteboarder).length === 0) {
            return;
        }

        if (isPlayable) {
            this.whiteboarder.pause();

            if (this.videoderLastPlayStatus === "pause") {
                this.statusCallBack({
                    status: ControlStatus.PAUSE,
                    reason: "videoder and whiteboarder pause",
                });
            } else {
                this.videoder
                    .play()
                    ?.then((): void => {
                        this.whiteboarder.play();

                        this.statusCallBack({
                            status: ControlStatus.PLAYING,
                            reason: "videoder and whiteboarder playing",
                        });
                    })
                    .catch((e) => {
                        this.statusCallBack({
                            status: ControlStatus.FAILED,
                            reason: `videoder play fail. message: ${e.message}, stack: ${e.stack}`,
                        });
                    });
            }
            return;
        }

        this.dontSetVideoderStatusPause = true;
        this.videoder.pause();

        this.statusCallBack({
            status: ControlStatus.BUFFERING,
            reason: "whiteboarder caching",
        });
    }

    // 监听 video 的各个事件
    private onVideoderEvent() {
        // 这里之所以在 canplay 时进行白板回放同步，而不是 seeked 事件做。是因为 videoder 丢帧的时候，我们也需要将其时间对齐
        // videoder 出现丢帧时会触发的事件为: waiting -> waiting -> canplay。
        // 而进行 seek 时触发的事件为: seeked -> canplay
        // 取其交集，即: canplay
        this.videoder.on("canplay", () => {
            // 如果是第一次触发 canplay，则跳过时间对齐。因为第一次的 canplay 是页面刚加载，videoder 刚自动缓存完毕
            // TODO: 这里用户不一定是第一次给我
            if (!this.isFirstCallCanplay) {
                this.whiteboarder.seekToProgressTime(
                    this.videoder.currentTime() * 1000
                );
            }
            this.isFirstCallCanplay = false;
        });

        this.videoder.on("play", () => {
            this.videoderLastPlayStatus = "play";

            // 首次触发时先暂停 videoder，等待白板加载完毕，再由白板进行播放
            if (this.firstVideoderPlay) {
                this.dontSetVideoderStatusPause = true;
                this.videoder.pause();
                this.firstVideoderPlay = false;
            }
            this.whiteboarder.play();
        });

        this.videoder.on("pause", () => {
            if (!this.dontSetVideoderStatusPause) {
                this.videoderLastPlayStatus = "pause";
                this.whiteboarder.pause();
            }
            this.dontSetVideoderStatusPause = false;
        });

        // 当 video 在加载时，暂停白板
        this.videoder.on("waiting", () => {
            this.whiteboarder.pause();
        });
    }

    // 检查 videoder 和 whiteboarder 实例是否注入完成
    private checkder(): void {
        if (Object.keys(this.videoder).length === 0) {
            this.statusCallBack({
                status: ControlStatus.NO_READY,
                reason: "videoder don't set",
            });

            return;
        }

        if (Object.keys(this.whiteboarder).length === 0) {
            this.statusCallBack({
                status: ControlStatus.NO_READY,
                reason: "whiteboarder don't set",
            });

            return;
        }

        this.statusCallBack({
            status: ControlStatus.READY,
            reason: "videoder and whiteboarder instance is ready",
        });

        this.onVideoderEvent();

        return;
    }
}
