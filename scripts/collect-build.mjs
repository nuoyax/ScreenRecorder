// Collects every build artifact into a single flat `release/` directory at the repo
// root, so shipping doesn't mean spelunking through src-tauri/target/release/bundle/nsis/.
//
// Tauri scatters its outputs and the installer path is several levels deep; this copies
// them to one place with predictable names. Run it after `tauri build`.
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const targetRelease = join(root, "src-tauri", "target", "release");
const outDir = join(root, "release");

mkdirSync(outDir, { recursive: true });

/** @type {{name: string, from: string, bytes: number}[]} */
const collected = [];

const take = (from, name) => {
  if (!existsSync(from)) return;
  copyFileSync(from, join(outDir, name));
  collected.push({ name, from, bytes: statSync(from).size });
};

// The portable, self-contained binary: frontend is embedded, so this alone is shippable.
take(join(targetRelease, "screen-recorder.exe"), "screen-recorder.exe");

// Installers, flattened out of bundle/<kind>/. Missing while the NSIS toolchain is
// unavailable (tauri downloads it on first bundle), which is not an error here.
for (const kind of ["nsis", "msi"]) {
  const dir = join(targetRelease, "bundle", kind);
  if (!existsSync(dir)) continue;
  for (const f of readdirSync(dir)) {
    if (!/\.(exe|msi|zip)$/i.test(f)) continue;
    const src = join(dir, f);
    if (!statSync(src).isFile()) continue;
    take(src, f);
  }
}

if (collected.length === 0) {
  console.error("nothing to collect: run `npm run tauri build` first");
  console.error(`looked in ${targetRelease}`);
  process.exit(1);
}

const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;
console.log(`release/  (${collected.length} file${collected.length === 1 ? "" : "s"})`);
for (const { name, bytes } of collected) console.log(`  ${name.padEnd(40)} ${mb(bytes)}`);
if (!collected.some((c) => /setup|\.msi$/i.test(c.name))) {
  console.log("  (no installer — tauri build did not produce one; see README)");
}
