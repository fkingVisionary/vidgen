// Production build: bundles the API, worker and seed entry points into
// apps/api/dist. Workspace packages (@docengine/*, TypeScript source) are
// compiled into the bundle; npm dependencies stay external and are installed
// in the runtime image (`pnpm install --prod`).
import { readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { build } from 'esbuild';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

/** Keep bare npm imports external; bundle relative paths and @docengine/* workspace packages. */
const externalizeNpm = {
  name: 'externalize-npm',
  setup(b) {
    b.onResolve({ filter: /^[^./]/ }, (args) => {
      if (args.path.startsWith('@docengine/')) return undefined;
      return { path: args.path, external: true };
    });
  },
};

const result = await build({
  entryPoints: { server: 'src/server.ts', worker: 'src/worker.ts', seed: 'src/seed.ts', research: 'src/research-cli.ts' },
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  metafile: true,
  plugins: [externalizeNpm],
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  logLevel: 'info',
});

// The bundle resolves external packages from apps/api at runtime. With pnpm's
// strict node_modules, a dependency of a workspace package is NOT visible here
// unless @docengine/api declares it too. Fail the build instead of the deploy.
const builtins = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));
const externals = new Set(
  Object.values(result.metafile.outputs).flatMap((o) => o.imports.filter((i) => i.external).map((i) => i.path)),
);
const unresolvable = [...externals].filter((spec) => {
  if (builtins.has(spec)) return false;
  try {
    import.meta.resolve(spec);
    return false;
  } catch {
    return true;
  }
});
if (unresolvable.length > 0) {
  console.error(`\nBuild failed: these runtime imports are not resolvable from @docengine/api:\n  ${unresolvable.join('\n  ')}\nAdd them to apps/api/package.json dependencies (use "catalog:" versions).\n`);
  process.exit(1);
}
console.log(`Verified ${externals.size} external imports resolve from @docengine/api.`);
