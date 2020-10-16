import { VideoDefaultOptions, VideoOptions } from "./Types";
import { verifyInstanceParams } from "./Verification";
import { Player, PlayerPhase } from "white-web-sdk";
import { EventEmitter } from "./EventEmitter";

/**
 * 实例化时默认传参
 * @private
 * @return DefaultOptions
 */
const videoDefaultOptions = (): VideoDefaultOptions => {
    return {
        videoDOM: document.createElement("video"),
        videoJsOptions: {
            preload: "auto",
        },
    };
};

export class CombinePlayerFactory {
    private readonly videoOptions: VideoOptions;
    private whiteboard: Player | undefined = undefined;
    private readonly whiteboardEmitter: EventEmitter = new EventEmitter();

    /**
     * 为 Combine-Player 类服务的对象
     * @param {VideoOptions} [videoOptions=DefaultOptions] - video 配置项
     */
    public constructor(videoOptions: VideoOptions) {
        verifyInstanceParams(videoOptions);

        const _videoDefaultOptions = videoDefaultOptions();
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
    }

    /**
     * 获取 whiteboard 的 Player 对象
     */
    public getWhiteboard(): Player {
        return this.whiteboard as Player;
    }

    /**
     * 获取 video 配置项
     */
    public getVideo(): VideoOptions {
        return this.videoOptions;
    }

    /**
     *  获取 whiteboard 的 EventEmitter 对象
     */
    public getWhiteboardEmitter(): EventEmitter {
        return this.whiteboardEmitter;
    }

    /**
     * 设置白板的事件回调
     * @param {PlayerPhase} phase - 事件名称
     */
    public setWhiteboardEvents(phase: PlayerPhase): void {
        this.whiteboardEmitter.emit(phase);
    }

    /**
     * 设置 回放 的 isPlayable 事件
     * @param {boolean} isPlayable - 是否可播放
     */
    public setWhiteboardIsPlayable(isPlayable: boolean): void {
        this.whiteboardEmitter.emit("playableChange", isPlayable);
    }
}
