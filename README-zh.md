# netless-combine-player

同步 video 和 白板回放 的项目

[English Document](https://github.com/netless-io/netless-combine-player/blob/master/README-zh.md)

## 使用

```typescript
import CombinePlayerFactory from "netless-combine-player";

whiteWebSdk.replayRoom({ room, roomToken })
    .then(async (player) => {
        const combinePlayerFactory = new CombinePlayerFactory(player, {
            url: "video url",
            videoDOM: videoEle.current as HTMLVideoElement,
        });
        
        const combinePlayer = combinePlayerFactory.create();
        
        combinePlayer.setOnStatusChange((status, message) => {
            console.log("status change:", status, message);
        });


        await combinePlayer.play();
        await combinePlayer.seek(1000 * 60);
        await combinePlayer.pause();
    });
```

## API

### [CombinePlayerFactory](https://github.com/netless-io/netless-combine-player/blob/27c3593dbf/src/index.ts#L8)

```typescript
new CombinePlayerFactory(whiteboard, videoOptions, debug);
```

#### [whiteboard](https://github.com/netless-io/netless-combine-player/blob/27c3593dbf/src/index.ts#L10)

由 `replayRoom` 函数生成

类型: [Player](https://developer.netless.link/javascript-zh/home/player-methods#player-%E7%9A%84%E5%AE%9A%E4%B9%89)

#### [videoOptions](https://github.com/netless-io/netless-combine-player/blob/27c3593dbf/src/index.ts#L9)

video 的配置项

类型: [VideoOptions](https://github.com/netless-io/netless-combine-player/blob/27c3593dbfa244cb8f9c5ab8570726bf33852c45/src/Types.ts#L4-L11)

**类型详情:**

```typescript
videoOptions: {
    url: string; // video 的 url 地址
    videoDOM?: HTMLVideoElement // video 标签元素(如未传入，将自动生成)
    videoJsOptions?: import("video.js").VideoJsPlayerOptions // video.js的配置项(见: https://docs.videojs.com/tutorial-options.html)
}
```

`videoJsOptions` 默认值是:

```typescript
{
    preload: "auto"
}
```

#### [debug](https://github.com/netless-io/netless-combine-player/blob/27c3593dbf/src/index.ts#L11)

是否开启 debug 日志

类型: `boolean`

默认值是: false

#### **例子:**

```typescript
whiteWebSdk.replayRoom({ room, roomToken })
    .then(player => {
        const combinePlayerFactory = new CombinePlayerFactory(player, {
            url: "video url",
            videoDOM: videoEle.current as HTMLVideoElement,
        });
    });
```

### [combinePlayerFactory.create](https://github.com/netless-io/netless-combine-player/blob/27c3593dbf/src/index.ts#L39-L56)

创建 `CombinePlayer` 实例，并返回

```typescript
const combinePlayer: CombinePlayer = combinePlayerFactory.create();
```

返回类型: [CombinePlayer](https://github.com/netless-io/netless-combine-player/blob/27c3593dbf/src/Types.ts#L54-L60)

### [combinePlayerFactory.getVideoDOM](https://github.com/netless-io/netless-combine-player/blob/75593a6a19/src/index.ts#L58-L60)

获取 video 的元素

当使用 `CombinePlayerFactory` 方法，并且未传递 `videoDOM` 时，此方法会派上用场

```typescript
const videoDOM: HTMLVideoElement = combinePlayerFactory.getVideoDOM();
```

返回类型: `HTMLVideoElement`

### [combinePlayer.setOnStatusChange](https://github.com/netless-io/netless-combine-player/blob/27c3593dbf/src/CombinePlayerImplement.ts#L55-L61)

注册一个回调函数，当状态发生改成时进行通知

```typescript
combinePlayer.setOnStatusChange(statusOnChange);
```

#### [cb](https://github.com/netless-io/netless-combine-player/blob/27c3593dbf/src/CombinePlayerImplement.ts#L59)

类型: [StatusChangeHandle](https://github.com/netless-io/netless-combine-player/blob/27c3593dbf/src/Types.ts#L52)

#### **例子:**

```typescript
const statusOnChange = (status: PublicCombinedStatus, message: string): void => {
   console.log("状态改变:", status, message);
}
combinePlayer.setOnStatusChange(statusOnChange);
```

### [combinePlayer.removeStatusChange](https://github.com/netless-io/netless-combine-player/blob/27c3593dbf/src/CombinePlayerImplement.ts#L63-L71)

移除指定的状态通知回调

```typescript
combinePlayer.removeStatusChange(statusOnChange);
```

#### [cb](https://github.com/netless-io/netless-combine-player/blob/27c3593dbf/src/CombinePlayerImplement.ts#L67)

类型: [StatusChangeHandle](https://github.com/netless-io/netless-combine-player/blob/27c3593dbf/src/Types.ts#L52)

#### **例子:**

```typescript
const statusOnChange = (status: PublicCombinedStatus, message: string): void => {
   console.log("状态改变:", status, message);
}
combinePlayer.setOnStatusChange(statusOnChange);

combinePlayer.removeStatusChange(statusOnChange);
```

### [combinePlayer.removeAllStatusChange](https://github.com/netless-io/netless-combine-player/blob/27c3593dbf/src/CombinePlayerImplement.ts#L73-L78)

删除所有的状态通知回调

```typescript
combinePlayer.removeAllStatusChange();
```

### [combinePlayer.getStatus](https://github.com/netless-io/netless-combine-player/blob/27c3593dbf/src/CombinePlayerImplement.ts#L80-L85)

主动获取当前的状态

```typescript
combinePlayer.getStatus()
```

返回类型: [PublicCombinedStatus](https://github.com/netless-io/netless-combine-player/blob/27c3593dbf/src/Types.ts#L26-L34)

### [combinePlayer.play](https://github.com/netless-io/netless-combine-player/blob/27c3593dbf/src/CombinePlayerImplement.ts#L90)

开始同步播放

返回类型: `Promise<void>`

#### **例子:**

```typescript
combinePlayer.play();
// 或
await combinePlayer.play();
```

### [combinePlayer.pause](https://github.com/netless-io/netless-combine-player/blob/27c3593dbf/src/CombinePlayerImplement.ts#L140)

暂停 `video` 和 `whiteboard`

返回类型: `Promise<void>`

#### **例子:**

```typescript
combinePlayer.pause();
// 或
await combinePlayer.pasue();
```

### [combinePlayer.seek](https://github.com/netless-io/netless-combine-player/blob/27c3593dbf/src/CombinePlayerImplement.ts#L158)

同步跳转到指定的毫秒时间戳

```typescript
combinePlayer.seek(ms)
```

返回类型: `Promise<void>`

#### **例子:**

```typescript
combinePlayer.seek(1000);
// 或
await combinePlayer.seek(1000);
```
