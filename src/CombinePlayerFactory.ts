import { CombinePlayer, VideoDefaultOptions, VideoOptions } from "./Types";
import { verifyInstanceParams } from "./Verification";
import { Player, PlayerPhase } from "white-web-sdk";
import { EventEmitter } from "./EventEmitter";
import CombinePlayerImplement from "./index";

export class CombinePlayerFactory {
    private readonly videoOptions: VideoOptions;
    private whiteboard?: Player = undefined;
    private readonly whiteboardEmitter: EventEmitter = new EventEmitter();

    /**
     * 为 Combine-Player 类服务的对象
     * @param {VideoOptions} [videoOptions=DefaultOptions] - video 配置项
     */
    public constructor(videoOptions: VideoOptions) {
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
    }

    /**
     * 设置白板的 Player 实例
     * @param {Player} whiteboard - 白板实例
     */
    public setWhiteboard(whiteboard: Player): void {
        this.whiteboard = whiteboard;
        this.handleWhiteboardCallback();
    }

    /**
     * 创建 CombinePlayer 对象
     * @param {boolean} [debug=false] - 是否开启 debug 日志
     */
    public create(debug: boolean = false): CombinePlayer {
        if (!this.whiteboard) {
            throw Error(
                "Before creating, you must first use setWhiteboard to pass in whiteboard object",
            );
        }

        return new CombinePlayerImplement(
            this.videoOptions,
            this.whiteboard,
            this.whiteboardEmitter,
            debug,
        );
    }

    private handleWhiteboardCallback(): void {
        // 设置 whiteboard 的事件回调
        this.whiteboard!.callbacks.on("onPhaseChanged", (phase: PlayerPhase): void => {
            this.whiteboardEmitter.emit(phase);
        });

        // 设置 whiteboard 的 isPlayable 事件
        this.whiteboard!.callbacks.on("onIsPlayableChanged", (isPlayable: boolean): void => {
            this.whiteboardEmitter.emit("playableChange", isPlayable);
        });
    }

    /**
     * 实例化时默认的 video 传参
     */
    public static videoDefaultOptions(): VideoDefaultOptions {
        return {
            videoDOM: document.createElement("video"),
            videoJsOptions: {
                preload: "auto",
            },
        };
    }
}
