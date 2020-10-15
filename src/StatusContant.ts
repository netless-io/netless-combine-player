export enum Status {
    PauseSeeking = "PauseSeeking",
    Pause = "Pause",
    PauseBuffering = "PauseBuffering",
    PlayingBuffering = "PlayingBuffering",
    Playing = "Playing",
    PlayingSeeking = "PlayingSeeking",
    Ended = "Ended",
}

export enum StatusIndex {
    PauseSeeking,
    Pause,
    PauseBuffering,
    PlayingBuffering,
    Playing,
    PlayingSeeking,
    Ended,
}

export enum CombineStatus {
    PauseSeeking = "PauseSeeking",
    PlayingSeeking = "PlayingSeeking",
    PauseBuffering = "PauseBuffering",
    PlayingBuffering = "PlayingBuffering",
    ToPlay = "ToPlay",
    ToPause = "ToPause",
    Pause = "Pause",
    Playing = "Playing",
    Disabled = "Disabled",
    Ended = "Ended",
}

export enum Source {
    Video = "Video",
    Whiteboard = "Whiteboard",
}

export enum TriggerSource {
    None = "None",
    Video = "Video",
    Whiteboard = "Whiteboard",
    Plugin = "Plugin",
}
