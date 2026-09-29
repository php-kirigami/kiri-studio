// Live preview of the client's version of the site: the real Kirigami build,
// served locally, updated as they type.
//
// <siteDir>/preview        the synced copy with their drafts applied
// <siteDir>/deps           the site's node_modules (see deps.js), linked
//                          into the preview copy
//
// Every change to the drafts is mirrored into the preview copy; Kirigami's own
// watcher rebuilds what changed and reloads the page. The preview copy's
// kirigami.yaml drops the `studio:` block, which the build ignores anyway, so
// sites on a core that predates the block still preview.
import fs from 'node:fs';
import path from 'node:path';
import { utilityProcess } from 'electron';
import { parseDocument } from 'yaml';
import { ensureDeps } from './deps.js';

const SKIP = new Set(['.git', 'node_modules']);

function withoutStudio(text) {
	const doc = parseDocument(text);
	if (!doc.has('studio')) return text;
	doc.delete('studio');
	return String(doc);
}

export function createPreview({ siteDir, treeDir, drafts, cacheDir, onStatus }) {
	const dir = path.join(siteDir, 'preview');
	const depsDir = path.join(siteDir, 'deps');
	const link = path.join(dir, 'node_modules');
	let applied = new Set();
	let child = null;
	let starting = null;

	// Writes the client's current version of `rel` into the preview copy.
	function apply(rel) {
		const target = path.join(dir, rel);
		const data = drafts.read(rel);
		if (data === null) {
			fs.rmSync(target, { force: true });
			return;
		}
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, rel === 'kirigami.yaml' ? withoutStudio(data.toString('utf8')) : data);
	}

	// Removes the node_modules link itself, never what it points to.
	function unlink() {
		let stat;
		try { stat = fs.lstatSync(link); } catch { return; }
		if (stat.isSymbolicLink()) {
			try { fs.unlinkSync(link); } catch { fs.rmdirSync(link); } // a Windows junction needs rmdir
		} else {
			fs.rmSync(link, { recursive: true, force: true }); // a stray real folder
		}
	}

	// Fresh copy of the synced site, then every draft on top.
	function rebuild() {
		unlink();
		fs.rmSync(dir, { recursive: true, force: true });
		fs.cpSync(treeDir, dir, {
			recursive: true,
			filter: (source) => !SKIP.has(path.basename(source)),
		});
		apply('kirigami.yaml');
		applied = new Set(drafts.list().map((draft) => draft.path));
		for (const rel of applied) apply(rel);
	}

	// Mirrors what changed in the drafts since the last call.
	function refresh() {
		if (!fs.existsSync(dir)) return;
		const now = new Set(drafts.list().map((draft) => draft.path));
		for (const rel of new Set([...applied, ...now])) apply(rel);
		applied = now;
	}

	async function start() {
		if (starting) return starting;
		starting = (async () => {
			onStatus({ state: 'preparing' });
			rebuild();
			const nodeModules = await ensureDeps({
				projectDir: dir,
				depsDir,
				cacheDir,
				onProgress: ({ done, total }) => onStatus({ state: 'installing', done, total }),
			});
			fs.symlinkSync(nodeModules, link, 'junction');

			onStatus({ state: 'building' });
			child = utilityProcess.fork(path.join(import.meta.dirname, 'preview-worker.js'), [], {
				cwd: dir,
				serviceName: 'Kiri Studio preview',
				stdio: 'pipe',
			});
			const log = [];
			child.stdout?.on('data', (chunk) => log.push(String(chunk)));
			child.stderr?.on('data', (chunk) => log.push(String(chunk)));
			return new Promise((resolve, reject) => {
				child.on('message', (message) => {
					if (message.type === 'ready') {
						onStatus({ state: 'ready', url: message.url });
						resolve(message.url);
					} else if (message.type === 'build') {
						onStatus({ state: message.status === 'start' ? 'building' : message.success ? 'ready' : 'failed', error: message.error });
					} else if (message.type === 'error') {
						reject(Object.assign(new Error(message.message), { code: 'build', log: log.join('').slice(-4000) }));
					}
				});
				const self = child;
				child.on('exit', (code) => {
					if (child !== self) return; // stopped on purpose
					child = null;
					starting = null;
					const error = Object.assign(new Error(`Preview stopped (${code}).`), { code: 'stopped', log: log.join('').slice(-4000) });
					onStatus({ state: 'error', error: error.message });
					reject(error);
				});
			});
		})();
		try {
			return await starting;
		} catch (error) {
			onStatus({ state: 'error', code: error.code ?? 'failed' });
			stop();
			throw error;
		}
	}

	// Resolves once the worker is gone, so its files can be removed.
	function stop() {
		const exiting = child;
		child = null;
		starting = null;
		if (!exiting) return Promise.resolve();
		return new Promise((resolve) => {
			const timer = setTimeout(() => { exiting.kill(); resolve(); }, 2000);
			exiting.once('exit', () => { clearTimeout(timer); resolve(); });
			exiting.postMessage({ type: 'stop' });
		});
	}

	// The synced copy changed: a running preview starts over from it (its
	// dependencies may have changed too). It reports its new address through
	// onStatus({ state: 'ready', url }).
	async function resync() {
		if (!starting) return;
		await starting.catch(() => {});
		await stop();
		await start().catch(() => {});
	}

	return { start, stop, resync, refresh, get running() { return !!child; } };
}
