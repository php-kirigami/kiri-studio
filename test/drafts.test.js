import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDrafts } from '../src/main/drafts.js';

function setup(t) {
	const siteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiri-studio-drafts-'));
	t.after(() => fs.rmSync(siteDir, { recursive: true, force: true }));
	const treeDir = path.join(siteDir, 'tree');
	fs.mkdirSync(path.join(treeDir, 'src'), { recursive: true });
	fs.writeFileSync(path.join(treeDir, 'src', 'about.md'), '# About\n');
	return { siteDir, treeDir, drafts: createDrafts(siteDir, treeDir) };
}

test('a draft shadows the synced file and survives a new drafts instance', (t) => {
	const { siteDir, treeDir, drafts } = setup(t);
	assert.equal(drafts.read('src/about.md').toString(), '# About\n');
	assert.equal(drafts.save('src/about.md', '# About us\n'), true);

	const reopened = createDrafts(siteDir, treeDir);
	assert.equal(reopened.has('src/about.md'), true);
	assert.equal(reopened.read('src/about.md').toString(), '# About us\n');
	assert.equal(fs.readFileSync(path.join(treeDir, 'src', 'about.md'), 'utf8'), '# About\n', 'synced copy untouched');
});

test('the base hash is the synced file the edit started from, kept across saves', (t) => {
	const { drafts } = setup(t);
	drafts.save('src/about.md', 'one');
	const [first] = drafts.list();
	assert.match(first.base, /^[0-9a-f]{64}$/);
	drafts.save('src/about.md', 'two');
	assert.equal(drafts.list()[0].base, first.base);
});

test('saving the original content back drops the draft; discard removes it', (t) => {
	const { drafts } = setup(t);
	drafts.save('src/about.md', 'changed');
	assert.equal(drafts.save('src/about.md', '# About\n'), false);
	assert.deepEqual(drafts.list(), []);

	drafts.save('src/about.md', 'changed again');
	drafts.discard('src/about.md');
	assert.deepEqual(drafts.list(), []);
	assert.equal(drafts.read('src/about.md').toString(), '# About\n');
});

test('a new file has a null base', (t) => {
	const { drafts } = setup(t);
	drafts.save('src/blog/new-post.md', '# New');
	assert.equal(drafts.list()[0].base, null);
	assert.equal(drafts.read('src/blog/new-post.md').toString(), '# New');
});
