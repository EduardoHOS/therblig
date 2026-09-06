import type { NextConfig } from 'next';

// treadle is linked from the repository root, so the bundler resolves the symlink and stops
// seeing a package — which is why `serverExternalPackages` alone does not hold it. Keeping the
// symlinked path lets it match, and the explicit externals cover the build either way.
//
// Both `dev` and `build` therefore run on webpack: Turbopack does not read the hook below, so
// `next dev --turbopack` bundles the core and dies on the schema directory, while the build
// succeeds — dev and production disagreeing about the same config is worse than a slower start.
//
// It has to stay out of the bundle: it is ESM, it reads the OMG schemas off disk through
// import.meta.url, and xmllint-wasm loads a .wasm. All of that belongs in the Node runtime.
const EXTERNAL = ['treadle', 'bpmn-moddle', 'bpmnlint', 'xmllint-wasm', 'min-dash', 'moddle'];

const config: NextConfig = {
  // A production build writes the same directory a running `next dev` is serving from, and replaces
  // the chunks it has already handed the browser — the page then dies on a module it cannot find.
  // `make build` points somewhere else so the two never collide.
  distDir: process.env.NEXT_DIST_DIR ?? '.next',
  serverExternalPackages: EXTERNAL,
  webpack: (webpackConfig, { isServer }) => {
    webpackConfig.resolve.symlinks = false;
    if (isServer) {
      webpackConfig.externals = [
        ...(Array.isArray(webpackConfig.externals) ? webpackConfig.externals : []),
        ({ request }: { request?: string }, callback: (error?: unknown, result?: string) => void) =>
          request && EXTERNAL.some((name) => request === name || request.startsWith(`${name}/`))
            ? callback(undefined, `module ${request}`)
            : callback(),
      ];
    }
    return webpackConfig;
  },
};

export default config;
