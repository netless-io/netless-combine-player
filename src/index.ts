import { CombinePlayer, VideoDefaultOptions, VideoOptions } from "./Types";
import { verifyInstanceParams } from "./Verification";
import { Player, PlayerPhase } from "white-web-sdk";
import { EventEmitter } from "./EventEmitter";
import { CombinePlayerImplement } from "./CombinePlayerImplement";
import videojs from "video.js";
import { VideoReadyState } from "./StatusContant";

export default class CombinePlayerFactory {
    private readonly videoOptions: VideoOptions;
    private readonly whiteboard: Player;
    private readonly debug: boolean;

    /**
     * 为 Combine-Player 类服务的对象
     * @param {Player} whiteboard - 白板实例
     * @param {VideoOptions} [videoOptions=DefaultOptions] - video 配置项
     * @param {boolean} [debug=false] - 是否开启 debug 日志
     */
    public constructor(whiteboard: Player, videoOptions: VideoOptions, debug: boolean = false) {
        verifyInstanceParams(videoOptions);

        const _videoDefaultOptions = CombinePlayerFactory.videoDefaultOptions(videoOptions);
        this.videoOptions = {
            ..._videoDefaultOptions,
            ...videoOptions,
            videoJsOptions: {
                ..._videoDefaultOptions.videoJsOptions,
                ...videoOptions.videoJsOptions,
            },
        };

        this.whiteboard = whiteboard;
        this.debug = debug;
    }

    /**
     * 创建 CombinePlayer 对象
     */
    public create(): CombinePlayer {
        const whiteboardEmitter: EventEmitter = new EventEmitter();
        this.handleWhiteboardCallback(whiteboardEmitter);

        const videoDOM = this.getVideoDOM();
        CombinePlayerFactory.setAdditionalVideoAttr(videoDOM);

        const video = videojs(videoDOM, this.videoOptions.videoJsOptions);
        video.src(this.videoOptions.url);

        return new CombinePlayerImplement({
            videoConfig: {
                videoOptions: this.videoOptions,
                video,
                isCanplay: video.readyState() > VideoReadyState.HAVE_CURRENT_DATA,
            },
            whiteboard: this.whiteboard,
            whiteboardEmitter,
            debug: this.debug,
        });
    }

    public getVideoDOM(): HTMLVideoElement {
        if (typeof this.videoOptions.videoElementID !== "undefined") {
            return document.getElementById(this.videoOptions.videoElementID) as HTMLVideoElement;
        }

        return this.videoOptions.videoDOM as HTMLVideoElement;
    }

    /**
     * 设置 whiteboard 的相关回调
     * @param {EventEmitter} whiteboardEmitter - whiteboard 的 EventEmitter 对象
     * @private
     */
    private handleWhiteboardCallback(whiteboardEmitter: EventEmitter): void {
        // 设置 whiteboard 的事件回调
        this.whiteboard.callbacks.on("onPhaseChanged", (phase: PlayerPhase): void => {
            whiteboardEmitter.emit(phase);
        });

        // 设置 whiteboard 的 isPlayable 事件
        this.whiteboard.callbacks.on("onIsPlayableChanged", (isPlayable: boolean): void => {
            whiteboardEmitter.emit("playableChange", isPlayable);
        });
    }

    /**
     * 实例化时默认的 video 传参
     */
    private static videoDefaultOptions(videoOptions: VideoOptions): VideoDefaultOptions {
        const result: Writeable<VideoDefaultOptions> = {
            videoJsOptions: {
                preload: "auto",
            },
        };

        if (!videoOptions.videoDOM && !videoOptions.videoElementID) {
            result.videoDOM = document.createElement("video");
        }

        return result;
    }

    private static setAdditionalVideoAttr(video: HTMLVideoElement): void {
        video.setAttribute("playsInline", "true");
        video.setAttribute("webkit-playsinline", "true");
    }
}

type Writeable<T> = {
    -readonly [P in keyof T]: T[P];
};

export * from "./Types";

export * from "./StatusContant";
