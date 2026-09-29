// Builds the renderer into build/renderer/: bundles src/renderer/app.js and
// its imports (CodeMirror resolves its packages by name, which a file://
// page can't do on its own), and copies the static files next to it.
// The main process and preload run from src/ as they are.
import fs from 'node:fs';
import path from 'node:path';
import * as esbuild from 'esbuild';

const root = path.resolve(import.meta.dirname, '..');
const src = path.join(root, 'src', 'renderer');
const out = path.join(root, 'build', 'renderer');

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

await esbuild.build({
	entryPoints: [path.join(src, 'app.js')],
	outfile: path.join(out, 'app.js'),
	bundle: true,
	format: 'esm',
	target: 'chrome140',
	sourcemap: 'linked',
	logLevel: 'warning',
});

for (const file of ['index.html', 'styles.css']) {
	fs.copyFileSync(path.join(src, file), path.join(out, file));
}
