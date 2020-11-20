# @netless/combine-player

同步 白板回放 和 video 的项目

此项目用于代替 `white-web-sdk` 中的同步功能，`white-web-sdk@2.11.2` 版本后将取消同步功能，并有此项目接手。

## 由来

因 `white-web-sdk` 在同步过程中，没有很好的适配 `video` 丢帧的问题。如果在 `white-web-sdk` 里修复丢帧，将会增加代码的复杂度，所以把同步功能单独抽成一个 `project` 来进行维护。

## 安装

### yarn

```shell
yarn add @netless/combine-player
```

### npm

```shell
npm install @netless/combine-player
```

## 快速上手

```typescript
const CombinePlayerFactory = require("@netless/combine-player");

whiteWebSdk.replayRoom({room: "$UUID", roomToken: "$ROOM_TOKEN"})
    .then(async (player) => {
        const factoryParams = {
            url: "https://my-domain/assets/rtc-record.mp4",
            videoDOM: videoDom, // 用于存放视频播放器的 div 节点
        };

        const combinePlayer = new CombinePlayerFactory(player, factoryParams).create(); 
    });

// 用户点击播放时触发函数
const playButton = () => {
  combinePlayer.play();
}
```

## 兼容

如果您的项目之前使用了 `white-web-sdk@2.11.2` 之前的版本来做同步，并因为业务需求想进行升级时，则需要参考下面的说明，来替换您的项目代码

在使用此项目后，您不应该在直接操作 `white-web-sdk` 里的 `player` 对象，而应该操作 `combinePlayer` 对象。

### 初始化

在 `white-web-sdk@2.11.2` 之前的版本中，我们一直推荐您在页面加载完成的时候，去调用: `player.seekToProgressTime(0)`，来进行初始化回放数据。

而现在这一步操作已经被集成到 `@netless/combine-player` 里了，您不需要在去调用 `player.seekToProgressTime(0)`，如果因为历史问题，必须要调用的话，也请调用 `combinePlayer.seek(0)`。

### 成员属性

#### [playbackSpeed](https://developer.netless.link/javascript-zh/home/player-methods#playbackspeed)

此方法目前由 `@netless/combine-player` 的 `playbackRate` 属性代替。

其用法为:

```typescript
combinePlayer.playbackRate;
```

#### [timeDuration](https://developer.netless.link/javascript-zh/home/player-methods#timeduration)

此方法目前由 `@netless/combine-player` 的 `timeDuration` 属性代替。

其用法为:

```typescript
combinePlayer.timeDuration.duration;
```

其返回值和之前的不一致，详情请参考: [timeDuration](#timeDuration)

### 成员方法

#### [player.play()](https://developer.netless.link/javascript-zh/home/player-methods#play)

此方法目前由 `@netless/combine-player` 的 `play` 方法代替。

其用法为:

```typescript
combinePlayer.play();
```

#### [player.pause()](https://developer.netless.link/javascript-zh/home/player-methods#pause)

此方法目前由 `@netless/combine-player` 的 `pause` 方法代替。

其用法为:

```typescript
combinePlayer.pause();
```

#### [player.seekToProgressTime(progressTime)](https://developer.netless.link/javascript-zh/home/player-methods#seektoprogresstime)

此方法目前由 `@netless/combine-player` 的 `seek` 方法代替。

其用法为:

```typescript
combinePlayer.seek(ms);
```

#### [player.stop()](https://developer.netless.link/javascript-zh/home/player-methods#stop)

此方法目前由 `@netless/combine-player` 的 `stop` 方法代替。

其用法为:

```typescript
combinePlayer.stop();
```

#### 注意事项

##### 进度

如果您想获取整体的回放进度，可继续使用 `player.progressTime` 来进行获取，因 `@netless/combine-player` 本身就是负责同步的，所以 `回放` 和 `video` 的进度是一致的。

##### 状态

如果您想获取当前回放的进度，您可以继续使用 `player.phase` 来获取，当然最好(**十分推荐**)是使用 `@netless/combine-player` 的成员方法来进行获取。

关于 `@netless/combine-player` 的状态获取，可参考: [combinedStatus](#combinedStatus)、[setOnStatusChange](#setOnStatusChange)

如果想保留之前的状态判断，可以通过以下代码进行转换:

```typescript
switch (combinedStatus) {
    case PublicCombinedStatus.PauseBuffering:
    case PublicCombinedStatus.PlayingBuffering:
    case PublicCombinedStatus.PauseSeeking:
    case PublicCombinedStatus.PlayingSeeking: {
        return PlayerPhase.Buffering;
    }
    case PublicCombinedStatus.Playing: {
        return PlayerPhase.Playing;
    }
    case PublicCombinedStatus.Pause: {
        return PlayerPhase.Pause;
    }
    case PublicCombinedStatus.Stopped: {
        return PlayerPhase.Stopped;
    }
    case PublicCombinedStatus.Disabled: {
        throw new Error("...");
    }
}
```

## 接口

### 实例

```typescript
const combinePlayerFactory = new CombinePlayerFactory(player, videoOptions, debug);
```

#### 参数

**player**

其中 `player` 为 `replayRoom` 方法创建，具体可见: [ 构造 Player 对象](https://developer.netless.link/javascript-zh/home/construct-room-and-player#%E6%9E%84%E9%80%A0-player-%E5%AF%B9%E8%B1%A1)

**videoOptions**

```typescript
interface VideoOptions {
    readonly url: string;
    readonly videoElementID?: string;
    readonly videoDOM?: HTMLVideoElement;
    readonly videoJsOptions?: VideoJsPlayerOptions;
}
```

**url(required)**

选择要回放视频的 video 地址，以便进行同步

**videoElementID(optional)**

表明要选择哪一个 `video DOM` 元素的 `id`

如果此 `id` 的元素不是 `video` 将会报错

> 如果同时传入 `videoElementID` 和 `videoDOM` 程序将会报错

**videoDOM(optional)**

表明要选择哪一个 `video DOM` 元素

如果元素不是 `video` 将会报错

> 如果 `videoElementID` 和 `videoDOM` 都没传入，程序将自动创建一个 `video` 元素。您可以通过: `getVideoDOM` 方法来获取此元素，详情可参考: [getVideoDOM](#getVideoDOM)

**videoJsOptions(optional)**

video.js 实例化时的参数，详情可见: [Video.js Options](https://docs.videojs.com/tutorial-options.html)

默认情况下 `@netless/combine-player` 将会传入:

```typescript
{
    preload: "auto"
}
```

**debug(optional)**

是否开启 `debug` 模式，此模式将会把 `@netless/combine-player` 运行时的日志打印到 `console` 里

其默认值为: `false`

#### 成员方法

##### getVideoDOM

获取 `video` 的 `DOM` 元素

```typescript
const combinePlayerFactory = new CombinePlayerFactory(player, videoOptions, debug);
combinePlayerFactory.getVideoDOM();
```

##### create

创建 `combinePlayer` 对象

```typescript
const combinePlayerFactory = new CombinePlayerFactory(player, videoOptions, debug);
combinePlayerFactory.create();
```

其成员方法参考: [combinePlayer](#combinePlayer)

### combinePlayer

```typescript
const combinePlayerFactory = new CombinePlayerFactory(player, videoOptions, debug);
const combinePlayer = combinePlayerFactory.create();
```

#### 成员属性

##### playbackRate

获取/修改播放倍率，其默认值为: `1`

```typescript
// 获取当前播放速率
combinePlayer.playbackRate;

// 改变播放速率
combinePlayer.playbackRate = 2
```

##### timeDuration

获得回放总时长，其返回类型为:

```typescript
interface TimeDuration {
    readonly duration: number;
    readonly video: number;
    readonly whiteboard: number;
}
```

**duration**

取 `video` 和 `whiteboard` 最小值

**video**

`video` 的总时长

**whiteboard**

白板回放的总时长

##### combinedStatus

当前回放的组合状态。默认状态为: `PauseBuffering`

其返回值类型为:

```typescript
enum PublicCombinedStatus {
    PauseSeeking = "PauseSeeking",
    PlayingSeeking = "PlayingSeeking",
    Pause = "Pause",
    PauseBuffering = "PauseBuffering",
    PlayingBuffering = "PlayingBuffering",
    Playing = "Playing",
    Ended = "Ended",
    Disabled = "Disabled",
    Stopped = "Stopped",
}
```

**PauseSeeking**

当在暂停状态时，用户进行 [seek](#seek)，会到达此状态

详情可参考: [seek](#seek)

**PlayingSeeking**

当在播放状态时，用户进行 [seek](#seek)，会到达此状态

详情可参考: [seek](#seek)

**Pause**

当用户调用了 [pause](#pause) 方法时，会到达此状态

**PauseBuffering**

当当前是暂停状态，并且视频后面没有可播放的帧数据时，会到达此状态

**PlayingBuffering**

当当前正在播放时，下一帧没有可播放的帧数据时，会到达此状态

**Playing**

用户调用了 [play](#play) 方法时，或用户调用了 `seek`，并 `seek` 结束后，会到达此状态

**Ended**

`白板回放` 和 `video` 中有一端播放完毕，会到达此状态

**Disabled**

当出现意外时(有可能是`@netless/combine-player` 出现了 bug)，会到达此状态。

**Stopped**

用户调用了 [stop](#stop) 方法时，会到达此状态

#### 成员方法

##### play

开始播放及同步

```typescript
combinePlayer.play();
```

##### pause

暂停播放

```typescript
combinePlayer.pause();
```

##### seek

切换进度。该值会改变当前状态。

由于该方法需要发起网络请求，因此改变不会立即生效。

在等待过程中，当前状态会变为: `PauseSeeking` 或 `PlayingSeeking`

当 `seek` 结束后，状态会变为: `Playing` 或 `Ended`

```typescript
combinePlayer.seek(ms);
```

##### stop

停止。当前状态会变为 `Stopped`，此后 `@netless/combine-player` 实例将拒绝一切业务操作。

```typescript
combinePlayer.stop();
```

##### setOnStatusChange

添加状态改变监听器，当状态发生改成时，会触发此方法

```typescript
combinePlayer.setOnStatusChange((status, message) => {
  console.log("[combinePlayer] 状态发生改变: ", status, message);
});
```

##### removeStatusChange

移除指定的状态改变监听器

```typescript
const combinePlayerStatusChanged = (status: PublicCombinedStatus, message?: string) => {
 console.log("[combinePlayer] 状态发生改变: ", status, message);
}
combinePlayer.setOnStatusChange(combinePlayerStatusChanged);

combinePlayer.removeStatusChange(combinePlayerStatusChanged);
```

##### removeAllStatusChange

移除所有的状态改变监听器

```typescript
combinePlayer.removeAllStatusChange();
```

## 调用流程

`@netless/combine-player` 内部有一个队列，只有上一个完成，才会执行下一个。例如:

```typescript
combinePlayer.play();
combinePlayer.seek(1000 * 10);
combinePlayer.pause();
```

上面代码的实际执行流程为: 

等待回放到达 `Playing` 后，再去 `seek` 到 `10` 秒钟，等 `seek` 结束后，再去让回放暂停。
