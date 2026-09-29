import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createDrafts } from '../src/main/drafts.js';
import { GitHubError } from '../src/main/github.js';
import { parsePointer } from '../src/main/lfs.js';
import { publishSite } from '../src/main/publish.js';

// An in-memory slice of GitHub's Git Data API: blobs, trees, commits, one ref.
function fakeGitHub(files) {
	const blobs = new Map();
	const trees = new Map();
	const commits = new Map();
	let n = 0;
	const state = { head: 'c0', calls: [], blobs, commits, trees };
	trees.set('t0', new Map(Object.entries(files).map(([file, text]) => {
		blobs.set(`b-${file}`, Buffer.from(text));
		return [file, `b-${file}`];
	})));
	commits.set('c0', { tree: 't0', parents: [] });

	state.gh = {
		async json(url) {
			state.calls.push(`GET ${url}`);
			const sha = url.split('/').pop();
			if (!commits.has(sha)) throw new GitHubError('not found', 404);
			return { tree: { sha: commits.get(sha).tree } };
		},
		async send(method, url, body) {
			state.calls.push(`${method} ${url.split('/git/')[1]}`);
			if (state.failWith) throw state.failWith;
			if (url.endsWith('/git/blobs')) {
				const sha = `b${++n}`;
				blobs.set(sha, Buffer.from(body.content, 'base64'));
				return { sha };
			}
			if (url.endsWith('/git/trees')) {
				const tree = new Map(trees.get(body.base_tree));
				for (const entry of body.tree) {
					if (entry.sha === null) {
						if (!tree.has(entry.path)) throw new GitHubError('GitRPC::BadObjectState', 422);
						tree.delete(entry.path);
					} else tree.set(entry.path, entry.sha);
				}
				const sha = `t${++n}`;
				trees.set(sha, tree);
				return { sha };
			}
			if (url.endsWith('/git/commits')) {
				const sha = `c${++n}`;
				commits.set(sha, { tree: body.tree, parents: body.parents, message: body.message });
				return { sha };
			}
			if (method === 'PATCH') {
				state.onRef?.();
				if (commits.get(body.sha).parents[0] !== state.head) throw new GitHubError('Update is not a fast forward', 422);
				state.head = body.sha;
				return { ref: 'refs/heads/main' };
			}
			throw new Error(`unexpected ${method} ${url}`);
		},
	};
	state.read = (file) => blobs.get(trees.get(commits.get(state.head).tree).get(file))?.toString();
	state.has = (file) => trees.get(commits.get(state.head).tree).has(file);
	return state;
}

function site(files) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiri-publish-'));
	const treeDir = path.join(dir, 'tree');
	for (const [file, text] of Object.entries(files)) {
		fs.mkdirSync(path.dirname(path.join(treeDir, file)), { recursive: true });
		fs.writeFileSync(path.join(treeDir, file), text);
	}
	return { dir, treeDir, drafts: createDrafts(dir, treeDir), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const SITE = { fullName: 'acme/bakery', branch: 'main' };
const FILES = {
	'.gitattributes': '*.pdf filter=lfs diff=lfs merge=lfs -text\n',
	'src/_home.md': '# Home\n',
	'src/old.txt': 'old',
	'src/docs/report.pdf': 'version https://git-lfs.github.com/spec/v1\noid sha256:' + '0'.repeat(64) + '\nsize 9\n',
};

function fakeLfs() {
	const lfs = { uploaded: [], remembered: [], async upload(items) { lfs.uploaded.push(...items); }, remember(oid) { lfs.remembered.push(oid); } };
	return lfs;
}

test('a publish is one commit on top of the head: edits, new files, deletions', async (t) => {
	const local = site(FILES);
	const server = fakeGitHub(FILES);
	t.after(local.cleanup);
	local.drafts.save('src/_home.md', '# Home, edited\n');
	local.drafts.save('src/images/bread.png', Buffer.from([1, 2, 3, 4]));
	local.drafts.remove('src/old.txt');
	const statuses = [];

	const result = await publishSite({
		gh: server.gh, lfs: fakeLfs(), site: SITE, siteDir: local.dir, treeDir: local.treeDir, drafts: local.drafts,
		message: 'Update the home page', onStatus: (s) => statuses.push(s.state), sync: async () => ({ sha: server.head }),
	});

	assert.equal(result.published, true);
	assert.equal(server.commits.get(server.head).parents[0], 'c0');
	assert.equal(server.commits.get(server.head).message, 'Update the home page');
	assert.equal(server.read('src/_home.md'), '# Home, edited\n');
	assert.deepEqual([...Buffer.from(server.read('src/images/bread.png'))], [1, 2, 3, 4]);
	assert.equal(server.has('src/old.txt'), false);
	assert.equal(server.read('src/docs/report.pdf').startsWith('version https://git-lfs'), true, 'untouched files stay');
	assert.deepEqual(local.drafts.list(), [], 'published drafts are cleared');
	assert.ok(statuses.includes('uploading') && statuses.includes('committing'));
});

test('a file in a Git LFS path goes to LFS and only its pointer is committed', async (t) => {
	const local = site(FILES);
	const server = fakeGitHub(FILES);
	const lfs = fakeLfs();
	t.after(local.cleanup);
	const pdf = Buffer.from('%PDF-1.7 pretend report');
	local.drafts.save('src/docs/new-report.pdf', pdf);

	await publishSite({
		gh: server.gh, lfs, site: SITE, siteDir: local.dir, treeDir: local.treeDir, drafts: local.drafts,
		message: 'Add a report', sync: async () => ({ sha: server.head }),
	});

	assert.equal(lfs.uploaded.length, 1);
	assert.deepEqual(lfs.uploaded[0].bytes, pdf);
	const pointer = parsePointer(Buffer.from(server.read('src/docs/new-report.pdf')));
	assert.equal(pointer.oid, lfs.uploaded[0].oid);
	assert.equal(pointer.size, pdf.length);
	assert.deepEqual(lfs.remembered, [pointer.oid], 'the bytes are kept locally to show the file');
	assert.equal(server.read('src/docs/new-report.pdf').includes('%PDF'), false, 'no raw PDF in Git');
});

test('when someone published first, it syncs again and builds on their commit', async (t) => {
	const local = site(FILES);
	const server = fakeGitHub(FILES);
	t.after(local.cleanup);
	local.drafts.save('src/_home.md', '# Mine\n');
	let syncs = 0;
	// Someone else pushes just before our ref update, once.
	server.onRef = () => {
		if (syncs !== 1) return;
		syncs = 99;
		server.blobs.set('theirs', Buffer.from('# Theirs\n'));
		server.trees.set('t-theirs', new Map([...server.trees.get('t0'), ['src/_home.md', 'theirs'], ['src/other.md', 'theirs']]));
		server.commits.set('c-theirs', { tree: 't-theirs', parents: ['c0'] });
		server.head = 'c-theirs';
	};

	const result = await publishSite({
		gh: server.gh, lfs: fakeLfs(), site: SITE, siteDir: local.dir, treeDir: local.treeDir, drafts: local.drafts,
		message: 'Mine', wait: 1, sync: async () => { syncs = syncs === 99 ? 99 : syncs + 1; return { sha: server.head }; },
	});

	assert.equal(result.published, true);
	assert.equal(server.commits.get(server.head).parents[0], 'c-theirs');
	assert.equal(server.read('src/_home.md'), '# Mine\n', 'the client’s version wins');
	assert.equal(server.has('src/other.md'), true, 'their other changes are kept');
});

test('nothing to publish, or a deletion already done elsewhere, is not an error', async (t) => {
	const local = site(FILES);
	const server = fakeGitHub(FILES);
	t.after(local.cleanup);
	const options = { gh: server.gh, lfs: fakeLfs(), site: SITE, siteDir: local.dir, treeDir: local.treeDir, drafts: local.drafts, message: 'x', sync: async () => ({ sha: server.head }) };
	assert.equal((await publishSite(options)).published, false);

	local.drafts.remove('src/old.txt');
	fs.rmSync(path.join(local.treeDir, 'src/old.txt')); // someone else deleted it and we synced
	assert.equal((await publishSite(options)).published, false);
	assert.deepEqual(local.drafts.list(), []);
});

test('failures come back as plain codes', async (t) => {
	const local = site(FILES);
	const server = fakeGitHub(FILES);
	t.after(local.cleanup);
	local.drafts.save('src/_home.md', '# Edited\n');
	const run = () => publishSite({
		gh: server.gh, lfs: fakeLfs(), site: SITE, siteDir: local.dir, treeDir: local.treeDir, drafts: local.drafts,
		message: 'x', wait: 1, sync: async () => ({ sha: server.head }),
	});
	for (const [status, code] of [[0, 'offline'], [401, 'signedOut'], [403, 'noAccess'], [404, 'noAccess']]) {
		server.failWith = new GitHubError('boom', status);
		await assert.rejects(run(), (error) => error.code === code, `${status} → ${code}`);
	}
	assert.equal(local.drafts.list().length, 1, 'a failed publish keeps the client’s changes');
});

test('the commit message names the pages and counts the media', async () => {
	const { describeChanges } = await import('../src/main/publish.js');
	const scope = {
		content: [{ path: 'src/_home.md', label: 'Welcome text' }, { path: 'src/team.yaml', label: 'Team' }],
		collections: [],
		images: { path: 'src/images' },
		files: { path: 'src/docs' },
	};
	const message = describeChanges([
		{ path: 'src/_home.md' }, { path: 'src/team.yaml' }, { path: 'src/images/a.png' }, { path: 'src/images/b.png' },
		{ path: 'src/docs/r.pdf' }, { path: 'src/old.txt', deleted: true },
	], scope);
	assert.equal(message.split('\n')[0], 'Update “Welcome text”, “Team”, 2 images and 1 document; remove 1 file');
	assert.match(message, /- delete src\/old\.txt/);
	assert.match(message, /Published with Kiri Studio\.$/);
	assert.equal(describeChanges([{ path: 'src/old.txt', deleted: true }], scope).split('\n')[0], 'remove 1 file');
});
