/**
 * debug 日志方法
 * @param {string} prefix - 日志前缀
 * @param {string} text - 日志简要
 * @param {string | object} data - 日志数据
 */
export const debugLog = (
    prefix: string,
    text: string,
    data: Record<string, any> | string,
): void => {
    if (typeof data === "string") {
        console.log(`[Combine-Player][${prefix}]: ${text} -`, data);
    } else {
        console.log(`[Combine-Player][${prefix}]: ${text} -`, JSON.stringify(data, null, 2));
    }
};
