import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildScope, firstDocBlock, humanize, inScope, isPage, mediaRootOf, parseDocBlock, stripJsonComments } from '../src/main/scope.js';

function site(t, files) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiri-studio-scope-'));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	for (const [rel, content] of Object.entries(files)) {
		fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
		fs.writeFileSync(path.join(dir, rel), content);
	}
	return dir;
}

test('parseDocBlock matches php-prepros: tags, continuations, prose', () => {
	assert.deepEqual(parseDocBlock(`/**
 * Prose before the tags is ignored, even with an @inline word.
 *
 * @title   About us
 * @content _about.md
 * @description A value that wraps
 *   onto an indented line.
 * Flush-left prose ends it.
 * @empty
 */`), {
		title: 'About us',
		content: '_about.md',
		description: 'A value that wraps onto an indented line.',
		empty: '',
	});
});

test('firstDocBlock only looks after the PHP opening tag', () => {
	assert.equal(firstDocBlock('<p>/** not php */</p><?php /** @title Yes */'), '/** @title Yes */');
	assert.equal(firstDocBlock('<p>no php here</p>'), null);
});

test('isPage follows core: _*.php without an _-prefixed folder', () => {
	assert.equal(isPage('_index.php'), true);
	assert.equal(isPage('about/_index.php'), true);
	assert.equal(isPage('about/index.php'), false);
	assert.equal(isPage('_layout/_header.php'), false);
});

test('buildScope discovers page content and applies the studio block', (t) => {
	const dir = site(t, {
		'kirigami.yaml': `
kirigami:
  root: src
image:
  source: assets/images
studio:
  files: src/documents
  include:
    - _data/team.yaml
    - path: src/blog/*.md
      label: Blog posts
      create: true
  exclude:
    - src/data/_stats.json
    - assets/images/cache
  labels:
    src/data/_articles.yaml: Articles
`,
		'src/_index.php': '<?php\n/**\n * @intro _intro.md\n */',
		'src/about/_index.php': '<?php\n/**\n * @title   About us\n * @content _about.md\n * @remote  https://example.com/data.yaml\n * @missing _nope.md\n */',
		'src/about/_about.md': '# About',
		'src/data/_index.php': '<?php\n/**\n * @title Data\n * @articles _articles.yaml\n * @stats _stats.json\n */',
		'src/data/_articles.yaml': '- title: One',
		'src/data/_stats.json': '{}',
		'src/_intro.md': 'Hi',
		'src/_layout/_header.php': '<?php\n/**\n * @menu ../_menu.yaml\n */',
		'src/_menu.yaml': '[]',
		'_data/team.yaml': '- name: Ada',
		'src/blog/first-post.md': '# First',
		'src/blog/second-post.md': '# Second',
		'assets/images/cover.jpg': 'x',
		'assets/images/team/ada.jpg': 'x',
		'assets/images/cache/thumb.jpg': 'x',
		'src/documents/menu.pdf': 'x',
	});

	const scope = buildScope(dir);

	// Home page first, then pages in path order; files in annotation order.
	assert.deepEqual(scope.content.map(({ path, label, group, kind }) => ({ path, label, group, kind })), [
		{ path: 'src/_intro.md', label: 'Intro', group: 'Home', kind: 'markdown' },
		{ path: 'src/about/_about.md', label: 'About us', group: 'About us', kind: 'markdown' },
		{ path: 'src/data/_articles.yaml', label: 'Articles', group: 'Data', kind: 'data' },
		{ path: '_data/team.yaml', label: 'Team', group: null, kind: 'data' },
	]);
	assert.deepEqual(scope.collections, [{
		pattern: 'src/blog/*.md',
		label: 'Blog posts',
		create: true,
		header: {},
		files: [
			{ path: 'src/blog/first-post.md', label: 'First post', group: null, page: null, kind: 'markdown', schema: null },
			{ path: 'src/blog/second-post.md', label: 'Second post', group: null, page: null, kind: 'markdown', schema: null },
		],
	}]);
	assert.deepEqual(scope.images, {
		path: 'assets/images', name: 'images', files: 1,
		folders: [{ path: 'assets/images/team', name: 'team', files: 1, folders: [] }],
	});
	assert.equal(scope.files.path, 'src/documents');
	assert.equal(scope.files.files, 1);

	// Reads are limited to what the scope shows.
	assert.equal(inScope(scope, 'src/about/_about.md'), true);
	assert.equal(inScope(scope, 'src/blog/second-post.md'), true);
	assert.equal(inScope(scope, 'assets/images/team/ada.jpg'), true);
	assert.equal(inScope(scope, 'src/documents/menu.pdf'), true);
	assert.equal(inScope(scope, 'assets/images/cache/thumb.jpg'), false);
	assert.equal(inScope(scope, 'src/data/_stats.json'), false);
	assert.equal(inScope(scope, 'kirigami.yaml'), false);
	assert.equal(inScope(scope, 'src/about/_index.php'), false);
});

test('humanize turns tags and file names into labels', () => {
	assert.equal(humanize('citationBrown'), 'Citation brown');
	assert.equal(humanize('01-portraits'), 'Portraits');
	assert.equal(humanize('_about_us'), 'About us');
});

test('schemas: a modeline wins, then studio.schemas, then .vscode yaml.schemas', (t) => {
	const dir = site(t, {
		'kirigami.yaml': `
kirigami:
  root: src
studio:
  include:
    - _data/modeline.yaml
    - _data/team.yaml
    - _data/publications.yaml
    - _data/deep/publications.yaml
    - _data/plain.yaml
  schemas:
    schemas/team.json: _data/team.yaml
`,
		'_data/modeline.yaml': '# yaml-language-server: $schema=../schemas/inline.json\n- a: 1\n',
		'_data/team.yaml': '- name: Ada\n',
		'_data/publications.yaml': '[]\n',
		'_data/deep/publications.yaml': '[]\n',
		'_data/plain.yaml': 'a: 1\n',
		'.vscode/settings.json': `{
	// JSONC, like VS Code writes it
	"yaml.schemas": {
		"https://example.com/team.json": "team.yaml",
		"./assets/schemas/publications.schema.json": "publications.yaml", /* trailing comma next */
	},
}`,
	});
	const schemaOf = (rel) => buildScope(dir).content.find((entry) => entry.path === rel).schema;
	assert.deepEqual(schemaOf('_data/modeline.yaml'), { path: 'schemas/inline.json' });
	assert.deepEqual(schemaOf('_data/team.yaml'), { path: 'schemas/team.json' }, 'studio.schemas before .vscode');
	assert.deepEqual(schemaOf('_data/publications.yaml'), { path: 'assets/schemas/publications.schema.json' });
	assert.deepEqual(schemaOf('_data/deep/publications.yaml'), { path: 'assets/schemas/publications.schema.json' }, 'a bare file name matches anywhere');
	assert.equal(schemaOf('_data/plain.yaml'), null);
});

test('stripJsonComments keeps strings that look like comments', () => {
	assert.deepEqual(JSON.parse(stripJsonComments('{ "url": "https://x.com/a//b", /* c */ "n": 1, // d\n }')), { url: 'https://x.com/a//b', n: 1 });
});

test('buildScope: images default to image.source, false hides them, no files by default', (t) => {
	const base = 'kirigami:\n  root: src\n';
	assert.equal(buildScope(site(t, { 'kirigami.yaml': `${base}studio: {}\n` })).images.path, 'assets/images');
	assert.equal(buildScope(site(t, { 'kirigami.yaml': `${base}studio:\n  images: false\n` })).images, null);
	assert.equal(buildScope(site(t, { 'kirigami.yaml': `${base}studio: {}\n` })).files, null);
});

test('content remembers the page that loads it, for the preview', (t) => {
	const dir = site(t, {
		'kirigami.yaml': 'kirigami:\n  root: src\nstudio: {}\n',
		'src/about/_index.php': '<?php\n/**\n * @content _about.md\n */',
		'src/about/_about.md': '# About',
	});
	assert.equal(buildScope(dir).content[0].page, 'src/about/_index.php');
});

test('Markdown pages: an _index.md with an @tag header is a page and its own content', (t) => {
	const dir = site(t, {
		'kirigami.yaml': 'kirigami:\n  root: src\nstudio:\n  include:\n    - path: src/posts/*/_index.md\n      create: true\n',
		'src/_index.php': '<?php\n/**\n * @title Home\n * @@menu _menu.yaml\n */',
		'src/_menu.yaml': '- a\n',
		'src/notes/_index.md': '@title Notes\n@list _list.yaml\n\nText',
		'src/notes/_list.yaml': '- b\n',
		'src/plain/_index.md': 'No header: data, not a page',
		'src/about/_index.php': '<?php\n/**\n * @title About\n * @body _index.md\n */',
		'src/about/_index.md': '@title Data\n\nNext to an _index.php it is data',
		'src/posts/hello/_index.md': '@title Hello\n\nPost',
	});
	const scope = buildScope(dir);
	assert.deepEqual(scope.content.map(({ path, label, group, page }) => ({ path, label, group, page })), [
		{ path: 'src/_menu.yaml', label: 'Menu', group: 'Home', page: 'src/_index.php' },   // @@menu is discovered too
		{ path: 'src/about/_index.md', label: 'Body', group: 'About', page: 'src/about/_index.php' },
		{ path: 'src/notes/_index.md', label: 'Notes', group: 'Notes', page: 'src/notes/_index.md' },
		{ path: 'src/notes/_list.yaml', label: 'List', group: 'Notes', page: 'src/notes/_index.md' },
	]);
	// A folder collection's posts are listed there only, named after their folder.
	assert.deepEqual(scope.collections.map(({ label, files }) => ({ label, files: files.map((f) => [f.path, f.label]) })), [
		{ label: 'Posts', files: [['src/posts/hello/_index.md', 'Hello']] },
	]);
	assert.equal(isPage('notes/_index.md'), false, 'without a reader only PHP pages are known');
});

test('pageTypes: the prepros.types a client may pick, narrowed or hidden by studio.types', (t) => {
	const base = 'kirigami:\n  root: src\nprepros:\n  types:\n    post: { before: a.php }\n    note: { before: b.php }\n';
	assert.deepEqual(buildScope(site(t, { 'kirigami.yaml': `${base}studio: {}\n` })).pageTypes, ['post', 'note']);
	assert.deepEqual(buildScope(site(t, { 'kirigami.yaml': `${base}studio:\n  types: [note, missing]\n` })).pageTypes, ['note']);
	assert.deepEqual(buildScope(site(t, { 'kirigami.yaml': `${base}studio:\n  types: false\n` })).pageTypes, []);
	assert.deepEqual(buildScope(site(t, { 'kirigami.yaml': 'kirigami:\n  root: src\nstudio: {}\n' })).pageTypes, []);
});

test('page media: images/ and videos/ next to a page are media folders, for its own pages only', (t) => {
	const files = {
		'kirigami.yaml': 'kirigami:\n  root: src\nstudio:\n  pageMedia: true\n  include:\n    - path: src/course/**/_index.md\n      create: true\n',
		'src/course/intro/_index.md': '@title Intro\n\nText\n',
		'src/course/css/_index.md': '@title CSS\n\nText\n',
		'src/course/css/sprites/exercices/skate/_index.md': '@title Skate\n\nText\n',
		'src/_home.md': '@title Home\n\nText\n',
	};
	const scope = buildScope(site(t, files));
	assert.deepEqual(scope.pageMedia, ['images', 'videos']);

	// A page of the collection, at any depth — including one in a folder with no index of its own.
	assert.equal(mediaRootOf(scope, 'src/course/css/images'), 'src/course/css/images');
	assert.equal(mediaRootOf(scope, 'src/course/css/videos/loop.mp4'), 'src/course/css/videos');
	assert.equal(mediaRootOf(scope, 'src/course/css/sprites/exercices/skate/images/a/b.png'), 'src/course/css/sprites/exercices/skate/images');
	// A page created since the sync is covered by the collection's pattern.
	assert.equal(mediaRootOf(scope, 'src/course/new-page/images/x.png'), 'src/course/new-page/images');
	assert.equal(inScope(scope, 'src/course/css/images/x.png'), true);

	// Not next to a page, not one of the configured names, or trying to leave.
	assert.equal(mediaRootOf(scope, 'src/other/images/x.png'), null);
	assert.equal(mediaRootOf(scope, 'src/course/css/fonts/x.woff'), null);
	assert.equal(mediaRootOf(scope, 'src/course/css/images/../../secret.png'), null);
	// `**` also matches zero folders: the course's own home page has a media folder too.
	assert.equal(mediaRootOf(scope, 'src/course/images/x.png'), 'src/course/images');
});

test('page image: off unless studio.pageImage asks, and only with page media', (t) => {
	const base = 'kirigami:\n  root: src\nstudio:\n  include:\n    - path: src/docs/**/_index.md\n';
	const page = { 'src/docs/a/_index.md': '@title A\n\nText\n' };
	const scopeOf = (extra) => buildScope(site(t, { 'kirigami.yaml': base + extra, ...page }));
	assert.equal(scopeOf('  pageMedia: true\n').pageImage, false);
	assert.equal(scopeOf('  pageImage: true\n').pageImage, false);
	assert.equal(scopeOf('  pageMedia: true\n  pageImage: 1\n').pageImage, false);
	assert.equal(scopeOf('  pageMedia: true\n  pageImage: true\n').pageImage, true);
});

test('page media: off unless studio.pageMedia asks; a list names other folders', (t) => {
	const base = 'kirigami:\n  root: src\nstudio:\n  include:\n    - path: src/docs/**/_index.md\n';
	const page = { 'src/docs/a/_index.md': '@title A\n\nText\n' };
	const scopeOf = (extra) => buildScope(site(t, { 'kirigami.yaml': base + extra, ...page }));

	for (const extra of ['', '  pageMedia: false\n', '  pageMedia: 1\n']) {
		const off = scopeOf(extra);
		assert.deepEqual(off.pageMedia, [], `off for ${JSON.stringify(extra)}`);
		assert.equal(mediaRootOf(off, 'src/docs/a/images/x.png'), null);
	}
	assert.deepEqual(scopeOf('  pageMedia: true\n').pageMedia, ['images', 'videos']);

	const named = scopeOf('  pageMedia: [media, "bad name", 4]\n');
	assert.deepEqual(named.pageMedia, ['media']);
	assert.equal(mediaRootOf(named, 'src/docs/a/media/x.png'), 'src/docs/a/media');
	assert.equal(mediaRootOf(named, 'src/docs/a/images/x.png'), null);
});
