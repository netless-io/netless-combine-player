type TaskNode<R> = {
    readonly handler: () => R | Promise<R>;
    readonly resolve: (result: R) => void;
    readonly reject: (error: Error) => void;
};

export class TaskQueue {
    private queue: TaskNode<any>[] = [];
    private isHanding: boolean = false;

    public append<R>(taskHandler: () => R | Promise<R>): Promise<R> {
        return new Promise((resolve, reject) => {
            const taskNode: TaskNode<R> = {
                handler: taskHandler,
                resolve: resolve,
                reject: reject,
            };
            this.queue.push(taskNode);

            if (!this.isHanding) {
                this.startHandingTasksLoop();
            }
        });
    }

    /**
     * 此方法只能在 CombinePlayerStatus.Disable 状态时才能调用
     */
    public destroy(): void {
        this.queue = [];
    }

    private async startHandingTasksLoop(): Promise<void> {
        try {
            this.isHanding = true;
            while (this.queue.length > 0) {
                const taskNode = this.queue.shift()!;
                try {
                    taskNode.resolve(await taskNode.handler());
                } catch (error) {
                    taskNode.reject(error);
                }
            }
        } catch (error) {
            throw new Error(error);
        } finally {
            this.isHanding = false;
        }
    }
}
