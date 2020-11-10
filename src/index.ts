import { CombinePlayer, VideoDefaultOptions, VideoOptions } from "./Types";
import { verifyInstanceParams } from "./Verification";
import { Player, PlayerPhase } from "white-web-sdk";
import { EventEmitter } from "./EventEmitter";
import { CombinePlayerImplement } from "./CombinePlayerImplement";
import videojs from "video.js";

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

        const _videoDefaultOptions = CombinePlayerFactory.videoDefaultOptions();
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

        const video = videojs(this.videoOptions.videoDOM, this.videoOptions.videoJsOptions);
        video.src(this.videoOptions.url);

        return new CombinePlayerImplement({
            videoConfig: {
                videoOptions: this.videoOptions,
                video,
                isCanplay: video.readyState() > 2,
            },
            whiteboard: this.whiteboard,
            whiteboardEmitter,
            debug: this.debug,
        });
    }

    public getVideoDOM(): HTMLVideoElement {
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
    private static videoDefaultOptions(): VideoDefaultOptions {
        return {
            videoDOM: document.createElement("video"),
            videoJsOptions: {
                preload: "auto",
            },
        };
    }
}

export * from "./Types";
