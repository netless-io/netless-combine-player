import { AnyFunction } from "./Types";

/**
 * 这并不是一个真正的队列，只是实现了函数的顺序执行
 */
export class TaskQueue {
    private arr: AnyFunction[];

    public constructor() {
        this.arr = [];
    }

    public add(cb: AnyFunction): void {
        this.arr.push(cb);

        // 如果队列中只有一个元素，则立刻运行
        if (this.arr.length === 1) {
            this.runFirst();
        }
    }

    public clear(): void {
        this.arr = [];
    }

    private dequeue(): void {
        this.arr.splice(0, 1);
    }

    private runFirst(): void {
        this.arr[0](() => this.next());
    }

    private next(): void {
        this.dequeue();

        // 当上一次执行完毕后，立刻执行下一个
        if (this.arr.length !== 0) {
            this.runFirst();
        }
    }
}
