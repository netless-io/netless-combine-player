const paths = require("./paths");
const nodeExternals = require('webpack-node-externals');
const { CleanWebpackPlugin } = require("clean-webpack-plugin");
const { NoEmitOnErrorsPlugin, NamedModulesPlugin } = require("webpack");
const ForkTsCheckerWebpackPlugin = require("fork-ts-checker-webpack-plugin");

module.exports = {
    entry: [paths.entryFile],

    module: {
        rules: [
            {
                test: /\.ts?$/,
                use: [
                    {
                        loader: "babel-loader",
                    },
                    {
                        loader: "eslint-loader",
                        options: {
                            fix: true,
                        },
                    },
                ],
                exclude: /node_modules/,
            },
        ],
    },

    plugins: [
        new NamedModulesPlugin(),
        new CleanWebpackPlugin(),
        new NoEmitOnErrorsPlugin(),
        new ForkTsCheckerWebpackPlugin({
            typescript: {
                configFile: paths.tsConfig,
                diagnosticOptions: {
                    semantic: true,
                    syntactic: true,
                    declaration: true,
                },
            },
        }),
    ],

    externals: [nodeExternals()],

    resolve: {
        extensions: [".ts", ".js"],
    },

    output: {
        filename: "index.js",
        path: paths.dist,
        libraryTarget: 'commonjs2',
        library: "CombinePlayer"
    },
};
