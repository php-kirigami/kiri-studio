// Publishing: the client's drafts become one commit on the site's branch, made
// through GitHub's Git Data API, with no Git on this machine.
//
//   1. sync, so the synced copy is the branch head the commit builds on;
//   2. one blob per added or edited file (LFS-tracked paths: the bytes go to
//      Git LFS and a pointer file becomes the blob);
//   3. one tree on top of the head's tree, one commit whose parent is the head;
//   4. move the branch to it with force: false. That last call is the only one
//      that changes the branch, so a publish is all or nothing.
//
// If someone published in between, step 4 is refused ("not a fast forward"):
// sync again and rebuild on the new head. The client's version of a file wins
// over a concurrent change to it, and never asks (the other version stays in
// Git history, so the maintainer can always recover it).
import fs from 'node:fs';
import path from 'node:path';
import { syncSite } from './sync.js';
import { isLfsPath, lfsPatterns } from '../shared/lfs.js';
import { pointerFor, sha256 } from './lfs.js';

const ATTEMPTS = 4;
const PARALLEL = 3;

export class PublishError extends Error {
	constructor(code, message, cause) {
		super(message);
		this.name = 'PublishError';
		this.code = code;
		this.cause = cause;
	}
}

// What the client should be told, from whatever went wrong.
function explain(error) {
	if (error instanceof PublishError) return error;
	if (error.name === 'LfsError') {
		return new PublishError(error.status === 0 ? 'offline' : error.status === 401 || error.status === 403 ? 'noAccess' : 'lfs', error.message, error);
	}
	if (error.name === 'GitHubError') {
		const code = error.status === 0 ? 'offline'
			: error.status === 401 ? 'signedOut'
				: error.status === 403 || error.status === 404 ? 'noAccess'
					: error.status === 422 ? 'busy'
						: 'failed';
		return new PublishError(code, error.message, error);
	}
	return new PublishError('failed', error.message, error);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Runs `task` over `items`, PARALLEL at a time.
async function pool(items, task) {
	let next = 0;
	await Promise.all(Array.from({ length: Math.min(PARALLEL, items.length) }, async () => {
		while (next < items.length) await task(items[next++]);
	}));
}

// A network hiccup on one upload shouldn't lose the whole publish.
async function retrying(fn, { tries = 3, wait = 800 } = {}) {
	for (let attempt = 1; ; attempt++) {
		try {
			return await fn();
		} catch (error) {
			if (attempt >= tries || (error.status ?? 0) !== 0 && error.status < 500) throw error;
			await sleep(wait * attempt);
		}
	}
}

export async function publishSite({
	gh, lfs, site, siteDir, treeDir, drafts, message, onStatus = () => {}, sync = syncSite, wait = 1000,
}) {
	const repo = `/repos/${site.fullName}`;
	const branch = encodeURIComponent(site.branch);
	const blobs = new Map(); // sha-256 of the content → blob sha, kept across attempts

	try {
		for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
			onStatus({ state: 'checking' });
			const { sha: head } = await sync(gh, site, siteDir);
			drafts.tidy();

			const started = drafts.list();
			const exists = (rel) => fs.existsSync(path.join(treeDir, rel));
			// A deletion of a file that is already gone would make the tree call fail.
			const work = started.filter((change) => !change.deleted || exists(change.path));
			if (!work.length) {
				drafts.forget(started);
				return { published: false, sha: head };
			}

			const attributes = exists('.gitattributes') ? fs.readFileSync(path.join(treeDir, '.gitattributes'), 'utf8') : '';
			const patterns = lfsPatterns(attributes);

			// Read every file once, and decide what each becomes.
			const uploads = new Map(); // oid → { oid, size, bytes }
			const files = work.map((change) => {
				if (change.deleted) return { change, entry: { path: change.path, mode: '100644', type: 'blob', sha: null } };
				const bytes = drafts.read(change.path);
				if (isLfsPath(patterns, change.path)) {
					const pointer = pointerFor(bytes);
					uploads.set(pointer.oid, { oid: pointer.oid, size: pointer.size, bytes });
					return { change, content: Buffer.from(pointer.text) };
				}
				return { change, content: bytes };
			});

			const total = files.length + uploads.size;
			let done = 0;
			const tick = () => onStatus({ state: 'uploading', done: ++done, total });
			onStatus({ state: 'uploading', done: 0, total });

			await pool([...uploads.values()], async (item) => {
				await retrying(() => lfs.upload([item], site.branch));
				lfs.remember?.(item.oid, item.bytes);
				tick();
			});

			await pool(files.filter((f) => f.content), async (file) => {
				const key = `${file.content.length}:${sha256(file.content)}`;
				if (!blobs.has(key)) {
					const blob = await retrying(() => gh.send('POST', `${repo}/git/blobs`, {
						content: file.content.toString('base64'),
						encoding: 'base64',
					}));
					blobs.set(key, blob.sha);
				}
				file.entry = { path: file.change.path, mode: '100644', type: 'blob', sha: blobs.get(key) };
				tick();
			});

			onStatus({ state: 'committing' });
			const parent = await gh.json(`${repo}/git/commits/${head}`);
			const tree = await gh.send('POST', `${repo}/git/trees`, {
				base_tree: parent.tree.sha,
				tree: files.map((f) => f.entry),
			});
			const commit = await gh.send('POST', `${repo}/git/commits`, {
				message: typeof message === 'function' ? message(work) : message,
				tree: tree.sha,
				parents: [head],
			});
			try {
				await gh.send('PATCH', `${repo}/git/refs/heads/${branch}`, { sha: commit.sha, force: false });
			} catch (error) {
				// Refused: the branch moved since our sync. Try again on top of it.
				if (error.status === 422 && attempt < ATTEMPTS) {
					await sleep(wait);
					continue;
				}
				throw error;
			}

			drafts.forget(work);
			// The synced copy now has to be the commit we just made.
			await sync(gh, site, siteDir);
			return { published: true, sha: commit.sha, files: work.length };
		}
	} catch (error) {
		throw explain(error);
	}
	throw new PublishError('busy', 'The site kept changing while publishing.');
}

// The commit message: what a maintainer reading the history wants to know.
// "Update “Team” and 2 images", then the paths.
export function describeChanges(work, scope) {
	const labels = new Map([...scope.content, ...scope.collections.flatMap((c) => c.files)].map((entry) => [entry.path, entry.label]));
	const under = (root, rel) => root && rel.startsWith(`${root.path}/`);
	const pages = new Set();
	let images = 0;
	let documents = 0;
	let removed = 0;
	let other = 0;
	for (const change of work) {
		if (change.deleted) removed++;
		else if (labels.has(change.path)) pages.add(labels.get(change.path));
		else if (under(scope.images, change.path)) images++;
		else if (under(scope.files, change.path)) documents++;
		else other++;
	}
	const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
	const names = [...pages];
	const parts = [
		...names.slice(0, 3).map((name) => `“${name}”`),
		...(names.length > 3 ? [plural(names.length - 3, 'more page')] : []),
		...(images ? [plural(images, 'image')] : []),
		...(documents ? [plural(documents, 'document')] : []),
		...(other ? [plural(other, 'file')] : []),
	];
	const head = parts.length ? `Update ${parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0]}` : '';
	const title = [head, removed ? `remove ${plural(removed, 'file')}` : ''].filter(Boolean).join('; ') || 'Update the site';
	const list = work.slice(0, 30).map((change) => `- ${change.deleted ? 'delete ' : ''}${change.path}`);
	if (work.length > 30) list.push(`- … and ${work.length - 30} more`);
	return `${title}\n\n${list.join('\n')}\n\nPublished with Kiri Studio.`;
}
