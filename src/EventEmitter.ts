import { AnyFunction } from "./Types";

const isNotFn = (fn: AnyFunction): boolean => {
    return typeof fn !== "function";
};

export class EventEmitter {
    private readonly listeners: Record<string, AnyFunction[]>;

    public constructor() {
        this.listeners = Object.create(null);
    }

    public addListener(eventName: string, cb: AnyFunction): void {
        if (isNotFn(cb)) {
            throw Error("callback is not a function");
        }

        const currentListeners = this.getEvent(eventName);

        if (currentListeners) {
            currentListeners.push(cb);
        } else {
            this.listeners[eventName] = [cb];
        }
    }

    public removeListener(eventName: string, cb: AnyFunction): void {
        const currentListeners = this.getEvent(eventName);
        if (!currentListeners) {
            return;
        }

        for (let i = 0; i < currentListeners.length; i++) {
            const listener = currentListeners[i];
            // realCallbackFn 的作用是，once 还没有运行时如果取消了，则要做出相应的处理
            // @ts-ignore
            if (listener === cb || listener.realCallbackFn === cb) {
                this.listeners[eventName].splice(i, 1);
                i--;
            }
        }
    }

    public removeAllListener(eventName: string): void {
        const currentListeners = this.getEvent(eventName);
        if (!currentListeners) {
            return;
        }

        delete this.listeners[eventName];
    }

    public destroy(): void {
        Object.keys(this.listeners).forEach(eventName => {
            this.removeAllListener(eventName);
        });
    }

    public one(eventName: string, cb: AnyFunction): void {
        if (isNotFn(cb)) {
            throw Error("callback is not a function");
        }

        const wrap = (...arg: any[]): void => {
            if ({}.toString.call(cb) === "[object AsyncFunction]") {
                cb(...arg).catch((e: any) => {
                    throw Error(e);
                });
            } else {
                cb(...arg);
            }
            this.removeListener(eventName, wrap);
        };

        wrap.realCallbackFn = cb;

        this.addListener(eventName, wrap);
    }

    public emit(eventName: string, ...arg: any[]): void {
        const currentListeners = this.getEvent(eventName);
        if (!currentListeners) {
            return;
        }

        currentListeners.forEach(listener => listener(...arg));
    }

    private getEvent(eventName: string): AnyFunction[] | null {
        return this.listeners[eventName] || null;
    }
}
