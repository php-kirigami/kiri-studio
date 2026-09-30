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

test('a folder collection creates <folder>/<slug>/_index.md with a header, if the site allows it', (t) => {
	const siteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiri-studio-folders-'));
	t.after(() => fs.rmSync(siteDir, { recursive: true, force: true }));
	const treeDir = path.join(siteDir, 'tree');
	const write = (rel, text) => {
		fs.mkdirSync(path.dirname(path.join(treeDir, rel)), { recursive: true });
		fs.writeFileSync(path.join(treeDir, rel), text);
	};
	write('kirigami.yaml', [
		'kirigami:\n  root: src\nstudio:\n  include:',
		'    - path: src/posts/*/_index.md\n      create: true\n      header:\n        date: today\n        tags: ""',
		'    - path: src/pages/*/_index.md',
	].join('\n'));
	write('src/posts/hello/_index.md', '@title Hello world\n\nPost');
	write('src/posts/taken/cover.jpg', 'not a post, but the folder exists');
	const scope = buildScope(treeDir);
	const drafts = createDrafts(siteDir, treeDir);
	const collections = createCollections({ treeDir, drafts, scope, isExcluded: (rel) => isExcluded(scope.exclude, rel) });
	const POSTS = 'src/posts/*/_index.md';

	assert.deepEqual(creationTarget(POSTS), { folder: 'src/posts', ext: '.md', index: '_index.md' });
	assert.deepEqual(collections.files(POSTS).map((f) => f.label), ['Hello world']);

	const rel = collections.create(POSTS, 'Été à Montréal');
	assert.equal(rel, 'src/posts/ete-a-montreal/_index.md');
	assert.match(drafts.read(rel).toString(), /^@title Été à Montréal\n@date  \d{4}-\d{2}-\d{2}\n@tags\n\n$/);
	assert.equal(collections.create(POSTS, 'Été à Montréal'), 'src/posts/ete-a-montreal-2/_index.md');
	assert.equal(collections.create(POSTS, 'Taken'), 'src/posts/taken-2/_index.md', 'never reuses an existing folder');
	assert.equal(collections.create(POSTS, 'Hello'), 'src/posts/hello-2/_index.md');
	assert.deepEqual(collections.files(POSTS).map((f) => f.label).sort(), ['Hello', 'Hello world', 'Taken', 'Été à Montréal', 'Été à Montréal']);

	// Without `create: true` in kirigami.yaml, no new folders.
	assert.throws(() => collections.create('src/pages/*/_index.md', 'Nope'));
});

test('a tree collection nests pages: sub-pages go inside their parent, which then cannot be deleted', (t) => {
	const siteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiri-studio-tree-'));
	t.after(() => fs.rmSync(siteDir, { recursive: true, force: true }));
	const treeDir = path.join(siteDir, 'tree');
	const write = (rel, text) => {
		fs.mkdirSync(path.dirname(path.join(treeDir, rel)), { recursive: true });
		fs.writeFileSync(path.join(treeDir, rel), text);
	};
	write('kirigami.yaml', 'kirigami:\n  root: src\nstudio:\n  include:\n    - path: src/guide/**/_index.md\n      create: true\n');
	write('src/guide/_index.md', '@title Guide\n');
	write('src/guide/start/_index.md', '@title Getting started\n');
	write('src/guide/start/install/_index.md', '@title Install\n');
	const scope = buildScope(treeDir);
	const drafts = createDrafts(siteDir, treeDir);
	const collections = createCollections({ treeDir, drafts, scope, isExcluded: (rel) => isExcluded(scope.exclude, rel) });
	const GUIDE = 'src/guide/**/_index.md';

	assert.equal(scope.collections[0].label, 'Guide');
	assert.deepEqual(creationTarget(GUIDE), { folder: 'src/guide', ext: '.md', index: '_index.md', tree: true });
	assert.deepEqual(collections.files(GUIDE).map((f) => [f.path, f.parent]), [
		['src/guide/_index.md', null],
		['src/guide/start/_index.md', 'src/guide/_index.md'],
		['src/guide/start/install/_index.md', 'src/guide/start/_index.md'],
	]);

	// At the top, or under any page, at any depth.
	assert.equal(collections.create(GUIDE, 'FAQ'), 'src/guide/faq/_index.md');
	const deep = collections.create(GUIDE, 'On Windows', 'src/guide/start/install/_index.md');
	assert.equal(deep, 'src/guide/start/install/on-windows/_index.md');
	assert.equal(collections.files(GUIDE).find((f) => f.path === deep).parent, 'src/guide/start/install/_index.md');
	assert.throws(() => collections.create(GUIDE, 'x', 'src/elsewhere/_index.md'), /Not a page/);

	// Deleting a page takes its folder: sub-pages (published or new) and files kept there.
	write('src/guide/start/install/screenshot.png', 'png');
	assert.deepEqual(collections.delete('src/guide/start/install/_index.md'), [
		'src/guide/start/install/_index.md',
		'src/guide/start/install/on-windows/_index.md',
		'src/guide/start/install/screenshot.png',
	]);
	assert.equal(drafts.has(deep), false, 'a never-published sub-page just goes away');
	assert.equal(drafts.list().find((d) => d.path === 'src/guide/start/install/screenshot.png').deleted, true);
	assert.deepEqual(collections.files(GUIDE).map((f) => f.path), ['src/guide/_index.md', 'src/guide/faq/_index.md', 'src/guide/start/_index.md']);
	// The top page holds the whole collection: it waits for its sub-pages.
	assert.throws(() => collections.delete('src/guide/_index.md'), /sub-pages/);
	// Only tree collections take a parent.
	write('kirigami.yaml', 'kirigami:\n  root: src\nstudio:\n  include:\n    - path: src/guide/*/_index.md\n      create: true\n');
	const flat = createCollections({ treeDir, drafts, scope: buildScope(treeDir), isExcluded: () => false });
	assert.throws(() => flat.create('src/guide/*/_index.md', 'x', 'src/guide/start/_index.md'), /Not a page/);
});
