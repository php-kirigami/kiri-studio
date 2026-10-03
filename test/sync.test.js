import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { applyChanges, changesSince, extractArchive, syncSite } from '../src/main/sync.js';

// Minimal ustar archive, wrapped like GitHub's in "<owner>-<repo>-<sha>/".
function tar(entries) {
	const chunks = [];
	for (const { name, content = '', mode = 0o644, type = '0' } of entries) {
		const data = Buffer.from(content);
		const header = Buffer.alloc(512);
		header.write(name);
		header.write(mode.toString(8).padStart(7, '0'), 100);
		header.write(data.length.toString(8).padStart(11, '0'), 124);
		header.write(type, 156);
		chunks.push(header, data, Buffer.alloc((512 - data.length % 512) % 512));
	}
	return Buffer.concat([...chunks, Buffer.alloc(1024)]);
}

test('extractArchive strips the wrapper folder and never writes outside the target', (t) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiri-studio-sync-'));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const target = path.join(dir, 'tree');

	extractArchive(tar([
		{ name: 'owner-repo-abc123/', type: '5' },
		{ name: 'owner-repo-abc123/kirigami.yaml', content: 'kirigami: {}' },
		{ name: 'owner-repo-abc123/src/about/_about.md', content: '# About' },
		{ name: 'owner-repo-abc123/../escape.txt', content: 'nope' },
	]), target);

	assert.equal(fs.readFileSync(path.join(target, 'kirigami.yaml'), 'utf8'), 'kirigami: {}');
	assert.equal(fs.readFileSync(path.join(target, 'src/about/_about.md'), 'utf8'), '# About');
	assert.equal(fs.existsSync(path.join(dir, 'escape.txt')), false);
});

// A GitHub client answering from a table of canned responses.
function fakeGitHub(routes, calls = []) {
	return {
		calls,
		async json(path) {
			calls.push(path);
			const key = Object.keys(routes).find((route) => path.startsWith(route));
			if (!key) throw new Error(`Unexpected request: ${path}`);
			return routes[key];
		},
		async text(path) {
			calls.push(path);
			return routes.sha;
		},
		async buffer(path) {
			calls.push(path);
			return routes.tarball ?? Buffer.alloc(0);
		},
	};
}
const blob = (text) => ({ encoding: 'base64', content: Buffer.from(text).toString('base64') });
const site = { fullName: 'owner/repo', branch: 'main' };

test('changesSince: only the changed files are downloaded', async () => {
	const gh = fakeGitHub({
		'/repos/owner/repo/compare/old...new': { status: 'ahead', files: [
			{ filename: 'src/a.md', status: 'modified', sha: 'sha-a' },
			{ filename: 'src/new.md', status: 'added', sha: 'sha-new' },
			{ filename: 'src/gone.md', status: 'removed', sha: 'sha-gone' },
			{ filename: 'src/moved.md', previous_filename: 'src/was.md', status: 'renamed', sha: 'sha-moved' },
		] },
		'/repos/owner/repo/git/blobs/sha-a': blob('A2'),
		'/repos/owner/repo/git/blobs/sha-new': blob('NEW'),
		'/repos/owner/repo/git/blobs/sha-moved': blob('MOVED'),
	});
	const changes = await changesSince(gh, site, 'old', 'new');
	assert.deepEqual(changes.removed.sort(), ['src/gone.md', 'src/was.md']);
	assert.deepEqual(changes.written.map((f) => [f.path, f.data.toString()]).sort(), [['src/a.md', 'A2'], ['src/moved.md', 'MOVED'], ['src/new.md', 'NEW']]);
	assert.ok(!gh.calls.some((call) => call.includes('tarball')));
});

test('changesSince gives up (null) when the branch was rewritten, has too many files, or has a submodule', async () => {
	const compare = (body) => fakeGitHub({ '/repos/owner/repo/compare/': body });
	assert.equal(await changesSince(compare({ status: 'diverged', files: [] }), site, 'old', 'new'), null);
	assert.equal(await changesSince(compare({ status: 'behind', files: [] }), site, 'old', 'new'), null);
	const many = Array.from({ length: 100 }, (_, i) => ({ filename: `f${i}`, status: 'added', sha: `s${i}` }));
	assert.equal(await changesSince(compare({ status: 'ahead', files: many }), site, 'old', 'new'), null, '300 listed files may be truncated');
	assert.equal(await changesSince(compare({ status: 'ahead', files: [{ filename: 'vendor/sub', status: 'added' }] }), site, 'old', 'new'), null);
});

test('applyChanges: removes, writes, keeps the executable bit, stays inside the copy', (t) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiri-studio-apply-'));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const tree = path.join(dir, 'tree');
	fs.mkdirSync(path.join(tree, 'src/old'), { recursive: true });
	fs.writeFileSync(path.join(tree, 'src/gone.md'), 'x');
	fs.writeFileSync(path.join(tree, 'run.sh'), 'old', { mode: 0o755 });
	fs.writeFileSync(path.join(tree, 'src/old/inner.md'), 'inner');

	applyChanges(tree, {
		removed: ['src/gone.md', 'src/old/inner.md', '../outside.txt'],
		written: [
			{ path: 'run.sh', data: Buffer.from('new') },
			{ path: 'src/deep/new.md', data: Buffer.from('NEW') },
			{ path: 'src/old', data: Buffer.from('a folder became a file') },
			{ path: '../escape.txt', data: Buffer.from('nope') },
		],
	});

	assert.equal(fs.existsSync(path.join(tree, 'src/gone.md')), false);
	assert.equal(fs.readFileSync(path.join(tree, 'src/deep/new.md'), 'utf8'), 'NEW');
	assert.equal(fs.readFileSync(path.join(tree, 'src/old'), 'utf8'), 'a folder became a file');
	assert.equal(fs.readFileSync(path.join(tree, 'run.sh'), 'utf8'), 'new');
	if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(tree, 'run.sh')).mode & 0o111, 0o111);
	assert.equal(fs.existsSync(path.join(dir, 'escape.txt')), false);
});

test('syncSite: a moved branch updates the copy from the compare, without the archive; a rewritten branch falls back to it', async (t) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiri-studio-sync2-'));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	fs.mkdirSync(path.join(dir, 'tree'), { recursive: true });
	fs.writeFileSync(path.join(dir, 'tree/a.md'), 'A1');
	fs.writeFileSync(path.join(dir, 'sync.json'), JSON.stringify({ sha: 'old' }));

	const incremental = fakeGitHub({
		sha: 'new',
		'/repos/owner/repo/compare/old...new': { status: 'ahead', files: [{ filename: 'a.md', status: 'modified', sha: 'sha-a' }] },
		'/repos/owner/repo/git/blobs/sha-a': blob('A2'),
	});
	assert.deepEqual(await syncSite(incremental, site, dir), { sha: 'new', changed: true });
	assert.equal(fs.readFileSync(path.join(dir, 'tree/a.md'), 'utf8'), 'A2');
	assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'sync.json'), 'utf8')).sha, 'new');
	assert.ok(!incremental.calls.some((call) => call.includes('tarball')));
	assert.deepEqual(await syncSite(incremental, site, dir), { sha: 'new', changed: false });

	const rewritten = fakeGitHub({
		sha: 'newer',
		'/repos/owner/repo/compare/new...newer': { status: 'diverged', files: [] },
		tarball: gzipSync(tar([{ name: 'owner-repo-newer/a.md', content: 'A3' }])),
	});
	assert.deepEqual(await syncSite(rewritten, site, dir), { sha: 'newer', changed: true });
	assert.equal(fs.readFileSync(path.join(dir, 'tree/a.md'), 'utf8'), 'A3');
	assert.ok(rewritten.calls.some((call) => call.includes('tarball')));
});
