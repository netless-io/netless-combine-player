const { merge } = require("webpack-merge");
const common = require("./webpack.common.js");
const { NamedModulesPlugin } = require("webpack");

module.exports = merge(common, {
    mode: "development",

    devtool: "source-map",

    // 监听文件改变
    watch: true,
    watchOptions: {
        aggregateTimeout: 600,
        ignored: ["node_modules/**"],
    },

    devServer: {
        // 开启 webpack 重载
        hot: true,
    },

    plugins: [
        new NamedModulesPlugin(),
    ],
});
