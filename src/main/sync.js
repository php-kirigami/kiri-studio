// Keeps a local copy of a site in sync with its branch, without Git: compare
// the branch head with the last synced commit, and when it moved, download the
// repository tarball at that commit and swap it in. The copy lives in
// <siteDir>/tree; <siteDir>/sync.json remembers which commit it is.
import fs from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { parseTar } from './lib/tar.js';

export function readSyncState(siteDir) {
	try {
		return JSON.parse(fs.readFileSync(path.join(siteDir, 'sync.json'), 'utf8'));
	} catch {
		return null;
	}
}

// Returns { sha, changed }. Throws a GitHubError when GitHub can't be reached;
// the previous copy, if any, is left untouched.
export async function syncSite(gh, site, siteDir, onStatus = () => {}) {
	const treeDir = path.join(siteDir, 'tree');
	const state = readSyncState(siteDir);

	onStatus('checking');
	const ref = encodeURIComponent(site.branch);
	const sha = (await gh.text(`/repos/${site.fullName}/commits/${ref}`, 'application/vnd.github.sha')).trim();
	if (state?.sha === sha && fs.existsSync(treeDir)) return { sha, changed: false };

	onStatus('downloading');

	// The branch moved: fetch only the files that changed since the last sync
	// (a publish or a CI commit touches a handful), instead of the whole
	// repository (images and videos make it tens of MB).
	if (state?.sha && fs.existsSync(treeDir)) {
		const changes = await changesSince(gh, site, state.sha, sha).catch(() => null);
		if (changes) {
			applyChanges(treeDir, changes);
			fs.writeFileSync(path.join(siteDir, 'sync.json'), JSON.stringify({ sha, syncedAt: new Date().toISOString() }, null, 2));
			return { sha, changed: true };
		}
	}

	const archive = await gh.buffer(`/repos/${site.fullName}/tarball/${sha}`);

	// Extract next to the current copy, then swap, so a failure midway never
	// leaves a half-written site behind.
	const fresh = `${treeDir}.new`;
	const stale = `${treeDir}.old`;
	fs.rmSync(fresh, { recursive: true, force: true });
	extractArchive(gunzipSync(archive), fresh);
	fs.rmSync(stale, { recursive: true, force: true });
	if (fs.existsSync(treeDir)) fs.renameSync(treeDir, stale);
	fs.renameSync(fresh, treeDir);
	fs.rmSync(stale, { recursive: true, force: true });

	fs.writeFileSync(path.join(siteDir, 'sync.json'), JSON.stringify({ sha, syncedAt: new Date().toISOString() }, null, 2));
	return { sha, changed: true };
}

// GitHub's compare lists at most 300 files; past this many, a fresh archive is simpler.
const MAX_CHANGED_FILES = 250;
const PARALLEL = 4;

// The files that differ between two commits, with their new bytes:
// { removed: [path], written: [{ path, data }] } — or null when an incremental
// update isn't safe (the branch was rewritten, too many files, a submodule…),
// and the caller downloads the whole archive instead. Nothing is written here:
// every download finishes before the copy is touched, so a failure midway
// leaves the previous copy as it was.
export async function changesSince(gh, site, from, to) {
	const repo = `/repos/${site.fullName}`;
	const files = [];
	for (let page = 1; page <= 3; page++) {
		const compare = await gh.json(`${repo}/compare/${from}...${to}?per_page=100&page=${page}`);
		if (compare.status !== 'ahead' && compare.status !== 'identical') return null; // behind or diverged
		files.push(...(compare.files ?? []));
		if ((compare.files ?? []).length < 100) break;
	}
	if (files.length > MAX_CHANGED_FILES) return null;

	const removed = [];
	const toWrite = [];
	for (const file of files) {
		if (file.status === 'removed') {
			removed.push(file.filename);
			continue;
		}
		if (!file.sha) return null; // a submodule or something else without a blob
		if (file.status === 'renamed' && file.previous_filename) removed.push(file.previous_filename);
		toWrite.push(file);
	}

	const written = [];
	let next = 0;
	await Promise.all(Array.from({ length: Math.min(PARALLEL, toWrite.length) }, async () => {
		while (next < toWrite.length) {
			const file = toWrite[next++];
			const blob = await gh.json(`${repo}/git/blobs/${file.sha}`);
			if (blob.encoding !== 'base64') throw new Error('Unexpected blob encoding.');
			written.push({ path: file.filename, data: Buffer.from(blob.content, 'base64') });
		}
	}));
	return { removed, written };
}

// Applies changesSince() to the synced copy. Paths stay inside it.
export function applyChanges(treeDir, { removed, written }) {
	const root = path.resolve(treeDir);
	const inside = (rel) => {
		const dest = path.resolve(root, rel);
		return dest !== root && dest.startsWith(root + path.sep) ? dest : null;
	};
	for (const rel of removed) {
		const dest = inside(rel);
		if (dest) fs.rmSync(dest, { force: true });
	}
	for (const { path: rel, data } of written) {
		const dest = inside(rel);
		if (!dest) continue;
		fs.mkdirSync(path.dirname(dest), { recursive: true });
		if (fs.existsSync(dest) && fs.statSync(dest).isDirectory()) fs.rmSync(dest, { recursive: true, force: true }); // a folder became a file
		const mode = fs.existsSync(dest) ? fs.statSync(dest).mode & 0o777 : 0o644; // keep the executable bit
		fs.writeFileSync(dest, data, { mode });
	}
}

// GitHub wraps the archive in a "<owner>-<repo>-<sha>/" folder: drop it.
export function extractArchive(tar, target) {
	const root = path.resolve(target);
	for (const entry of parseTar(tar)) {
		const rel = entry.name.split('/').slice(1).join('/');
		if (!rel) continue;
		const dest = path.resolve(root, rel);
		if (dest !== root && !dest.startsWith(root + path.sep)) continue; // never write outside the copy
		if (entry.type === 'dir') {
			fs.mkdirSync(dest, { recursive: true });
			continue;
		}
		fs.mkdirSync(path.dirname(dest), { recursive: true });
		fs.writeFileSync(dest, entry.data, { mode: entry.mode & 0o111 ? 0o755 : 0o644 });
	}
}
