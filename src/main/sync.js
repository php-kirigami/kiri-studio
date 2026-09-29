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
