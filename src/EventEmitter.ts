import { AnyFunction } from "./Types";

const toType = (val: any): string => {
    return {}.toString.call(val);
};

const isNotFn = (fn: AnyFunction): boolean => {
    return !["[object Function]", "[object AsyncFunction]"].includes(toType(fn));
};

export class EventEmitter {
    private readonly listeners: Record<string, AnyFunction[]>;

    public constructor() {
        this.listeners = Object.create(null);
    }

    public addListener(eventName: string, cb: AnyFunction): void {
        if (isNotFn(cb)) {
            return;
        }

        const currentListener = this.getEvent(eventName);

        if (currentListener) {
            currentListener.push(cb);
        } else {
            this.listeners[eventName] = [cb];
        }
    }

    public removeListener(eventName: string, cb: AnyFunction): void {
        const currentListener = this.getEvent(eventName);
        if (!currentListener) {
            return;
        }

        this.listeners[eventName] = currentListener.filter(listener => {
            // realCallbackFn 的作用是，once 还没有运行时如果取消了，则要做出相应的处理
            // @ts-ignore
            return listener !== cb && listener !== listener.realCallbackFn;
        });
    }

    public removeAllListener(eventName: string): void {
        const currentListener = this.getEvent(eventName);
        if (!currentListener) {
            return;
        }

        delete this.listeners[eventName];
    }

    public one(eventName: string, cb: AnyFunction): void {
        if (isNotFn(cb)) {
            return;
        }

        const wrap = (...arg: any[]) => {
            cb(...arg);
            this.removeListener(eventName, wrap);
        };

        wrap.realCallbackFn = cb;

        this.addListener(eventName, wrap);
    }

    public emit(eventName: string, ...arg: any[]): void {
        const currentListener = this.getEvent(eventName);
        if (!currentListener) {
            return;
        }

        currentListener.forEach(listener => listener(...arg));
    }

    private getEvent(eventName: string): AnyFunction[] | null {
        return this.listeners[eventName] || null;
    }
}
