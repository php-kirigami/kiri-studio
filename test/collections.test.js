import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildScope, isExcluded } from '../src/main/scope.js';
import { createDrafts } from '../src/main/drafts.js';
import { createCollections, creationTarget } from '../src/main/collections.js';

const FIXTURE = path.join(import.meta.dirname, 'fixtures', 'site');
const BLOG = 'src/blog/*.md';

function setup(t) {
	const siteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiri-studio-collections-'));
	t.after(() => fs.rmSync(siteDir, { recursive: true, force: true }));
	const treeDir = path.join(siteDir, 'tree');
	fs.cpSync(FIXTURE, treeDir, { recursive: true });
	const scope = buildScope(treeDir);
	const drafts = createDrafts(siteDir, treeDir);
	const collections = createCollections({ treeDir, drafts, scope, isExcluded: (rel) => isExcluded(scope.exclude, rel) });
	return { drafts, collections };
}

test('creationTarget accepts "<folder>/*.<ext>" patterns only', () => {
	assert.deepEqual(creationTarget('src/blog/*.md'), { folder: 'src/blog', ext: '.md' });
	assert.deepEqual(creationTarget('_data/team/*.YAML'), { folder: '_data/team', ext: '.yaml' });
	assert.equal(creationTarget('src/blog/**/*.md'), null);
	assert.equal(creationTarget('src/*/index.md'), null);
	assert.equal(creationTarget('src/blog/*.php'), null);
});

test('collection files are labeled by their first heading', (t) => {
	const { collections } = setup(t);
	assert.deepEqual(collections.files(BLOG).map((f) => [f.path, f.label]), [
		['src/blog/new-oven.md', 'New oven'],
		['src/blog/sourdough-day.md', 'Sourdough day'],
	]);
});

test('creating a post: a safe, unique file name and a starter heading', (t) => {
	const { collections, drafts } = setup(t);
	const first = collections.create(BLOG, 'Été à la boulangerie');
	assert.equal(first, 'src/blog/ete-a-la-boulangerie.md');
	assert.equal(drafts.read(first).toString(), '# Été à la boulangerie\n\n');
	assert.equal(collections.create(BLOG, 'Été à la boulangerie'), 'src/blog/ete-a-la-boulangerie-2.md');
	assert.equal(collections.create(BLOG, 'New oven'), 'src/blog/new-oven-2.md', 'never overwrites a synced post');
	assert.equal(collections.files(BLOG).length, 5);
	assert.equal(collections.contains('src/blog/ete-a-la-boulangerie.md'), true);
});

test('deleting a post: gone from the list, published as a deletion', (t) => {
	const { collections, drafts } = setup(t);
	collections.delete('src/blog/new-oven.md');
	assert.deepEqual(collections.files(BLOG).map((f) => f.path), ['src/blog/sourdough-day.md']);
	assert.equal(drafts.list()[0].deleted, true);

	const created = collections.create(BLOG, 'Brief');
	collections.delete(created);
	assert.equal(drafts.has(created), false, 'a never-published post just goes away');
});

test('files outside a creatable collection cannot be created or deleted', (t) => {
	const { collections } = setup(t);
	assert.throws(() => collections.create('src/other/*.md', 'x'));
	assert.throws(() => collections.delete('src/_home.md'));
});
