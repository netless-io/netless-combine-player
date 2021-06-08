const { build } = require("esbuild");

build({
    entryPoints: ["src/index.ts"],
    bundle: true,
    external: ["video.js"],
    format: "esm",
    outfile: "dist/index.esm.js",
    target: "esnext",
    minify: true,
    sourcemap: true,
});
