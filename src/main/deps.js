// Installs a site's dependencies (Kirigami, its plugins, canva…) from the
// site's package-lock.json, without npm: the client has no Node toolchain.
// Each package tarball listed in the lockfile is fetched from its `resolved`
// URL (or the local cache), checked against its `integrity` hash, and
// extracted. Packages for other platforms (lockfile `os`/`cpu`/`libc`) are
// skipped. Install scripts are not run: the packages Kirigami needs that have
// one (esbuild, @parcel/watcher) find their prebuilt binary in the
// platform-specific optional package the lockfile already lists.
//
// The result is <depsDir>/node_modules, reinstalled only when the lockfile
// changes (<depsDir>/lock.sha256).
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { parseTar } from './lib/tar.js';

const CONCURRENCY = 8;

const matches = (list, value) => !list
	|| list.includes(value)
	|| (list.every((item) => item.startsWith('!')) && !list.includes(`!${value}`));

function platform() {
	const libc = process.platform === 'linux'
		? (process.report.getReport().header.glibcVersionRuntime ? 'glibc' : 'musl')
		: null;
	return { os: process.platform, cpu: process.arch, libc };
}

// The lockfile entries this machine needs: [{ key, resolved, integrity }].
export function packagesFor(lock, { os, cpu, libc } = platform()) {
	if (!lock?.packages) throw Object.assign(new Error('Unsupported lockfile (npm 7 or newer needed).'), { code: 'badLockfile' });
	return Object.entries(lock.packages)
		.filter(([key, meta]) => key.startsWith('node_modules/') && !meta.link && !meta.inBundle)
		.filter(([, meta]) => matches(meta.os, os) && matches(meta.cpu, cpu) && (!libc || matches(meta.libc, libc)))
		.map(([key, meta]) => {
			if (!meta.resolved || !meta.integrity) throw Object.assign(new Error(`${key} has no download URL in the lockfile.`), { code: 'badLockfile' });
			return { key, resolved: meta.resolved, integrity: meta.integrity };
		});
}

// Extracts one npm tarball into `dest`, dropping its top folder ("package/").
export function extractPackage(tgz, dest) {
	const root = path.resolve(dest);
	for (const entry of parseTar(gunzipSync(tgz))) {
		if (entry.type !== 'file') continue;
		const rel = entry.name.split('/').slice(1).join('/');
		if (!rel) continue;
		const out = path.resolve(root, rel);
		if (!out.startsWith(root + path.sep)) throw new Error(`Unsafe path in package: ${entry.name}`);
		fs.mkdirSync(path.dirname(out), { recursive: true });
		fs.writeFileSync(out, entry.data, { mode: entry.mode & 0o111 ? 0o755 : 0o644 });
	}
}

function verify(buf, integrity) {
	const [algo, expected] = integrity.split(' ')[0].split('-');
	if (createHash(algo).update(buf).digest('base64') !== expected) {
		throw Object.assign(new Error('A downloaded package is corrupted.'), { code: 'integrity' });
	}
}

// ensureDeps({ projectDir, depsDir, cacheDir, onProgress, fetch })
// → path of the installed node_modules.
export async function ensureDeps({ projectDir, depsDir, cacheDir, onProgress = () => {}, fetch = globalThis.fetch }) {
	const lockFile = path.join(projectDir, 'package-lock.json');
	if (!fs.existsSync(lockFile)) throw Object.assign(new Error('The site has no package-lock.json.'), { code: 'noLockfile' });
	const lockText = fs.readFileSync(lockFile, 'utf8');
	const lockHash = createHash('sha256').update(lockText).digest('hex');
	const target = path.join(depsDir, 'node_modules');
	const stamp = path.join(depsDir, 'lock.sha256');
	if (fs.existsSync(target) && fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8') === lockHash) return target;

	const packages = packagesFor(JSON.parse(lockText));
	const staging = path.join(depsDir, 'node_modules.new');
	fs.rmSync(staging, { recursive: true, force: true });
	fs.mkdirSync(cacheDir, { recursive: true });

	let done = 0;
	const queue = [...packages];
	const worker = async () => {
		while (queue.length) {
			const pkg = queue.shift();
			const cached = path.join(cacheDir, `${createHash('sha256').update(pkg.integrity).digest('hex')}.tgz`);
			let tgz = fs.existsSync(cached) ? fs.readFileSync(cached) : null;
			if (!tgz) {
				let res;
				try {
					res = await fetch(pkg.resolved);
				} catch (error) {
					throw Object.assign(new Error(`Download failed: ${error.message}`), { code: 'offline' });
				}
				if (!res.ok) throw Object.assign(new Error(`Download failed (${res.status}): ${pkg.key}`), { code: 'download' });
				tgz = Buffer.from(await res.arrayBuffer());
				verify(tgz, pkg.integrity);
				fs.writeFileSync(cached, tgz);
			} else {
				verify(tgz, pkg.integrity);
			}
			extractPackage(tgz, path.join(staging, pkg.key.slice('node_modules/'.length)));
			onProgress({ done: ++done, total: packages.length });
		}
	};
	await Promise.all(Array.from({ length: CONCURRENCY }, worker));

	fs.rmSync(target, { recursive: true, force: true });
	fs.renameSync(staging, target);
	fs.writeFileSync(stamp, lockHash);
	return target;
}
