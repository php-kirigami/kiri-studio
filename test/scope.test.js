import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildScope, firstDocBlock, humanize, inScope, isPage, parseDocBlock, stripJsonComments } from '../src/main/scope.js';

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
