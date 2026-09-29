import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDrafts } from '../src/main/drafts.js';
import { createMedia, safeName } from '../src/main/media.js';

const ROOT = 'assets/images';

function setup(t) {
	const siteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiri-studio-media-'));
	t.after(() => fs.rmSync(siteDir, { recursive: true, force: true }));
	const treeDir = path.join(siteDir, 'tree');
	for (const rel of ['assets/images/cover.jpg', 'assets/images/team/ada.jpg', 'assets/images/cache/thumb.jpg']) {
		fs.mkdirSync(path.dirname(path.join(treeDir, rel)), { recursive: true });
		fs.writeFileSync(path.join(treeDir, rel), `synced ${rel}`);
	}
	const drafts = createDrafts(siteDir, treeDir);
	const media = createMedia({ treeDir, drafts, isExcluded: (rel) => rel.startsWith('assets/images/cache') });
	return { drafts, media };
}

const names = (node) => ({
	files: node.files.map((f) => `${f.name}${f.status ? ` (${f.status})` : ''}`),
	folders: node.folders.map((f) => f.name),
});

test('safeName makes names safe for every system and URL', () => {
	assert.equal(safeName('Été 2026 (1).JPG'), 'ete-2026-1.jpg');
	assert.equal(safeName("Photo de l'équipe.png"), 'photo-de-l-equipe.png');
	assert.equal(safeName('!!!.pdf'), 'file.pdf');
	assert.equal(safeName('Nos Réalisations', { folder: true }), 'nos-realisations');
});

test('the tree overlays drafts on the synced copy and hides excluded folders', (t) => {
	const { media } = setup(t);
	media.add(ROOT, 'New Photo.PNG', Buffer.from('png'), ROOT);
	assert.deepEqual(names(media.tree(ROOT)), { files: ['cover.jpg', 'new-photo.png (added)'], folders: ['team'] });
});

test('adding never overwrites: a taken name gets a number', (t) => {
	const { media } = setup(t);
	assert.equal(media.add(ROOT, 'cover.jpg', Buffer.from('x'), ROOT), 'assets/images/cover-2.jpg');
	assert.equal(media.add(ROOT, 'Cover.JPG', Buffer.from('y'), ROOT), 'assets/images/cover-3.jpg');
});

test('files over 25 MB are refused', (t) => {
	const { media } = setup(t);
	assert.throws(() => media.add(ROOT, 'big.jpg', Buffer.alloc(25 * 1024 * 1024 + 1), ROOT), { code: 'tooLarge' });
});

test('a new folder exists, empty, through a hidden .gitkeep', (t) => {
	const { media, drafts } = setup(t);
	const folder = media.mkdir(ROOT, 'Événements 2026', ROOT);
	assert.equal(folder, 'assets/images/evenements-2026');
	assert.equal(drafts.has(`${folder}/.gitkeep`), true);
	const node = media.tree(ROOT).folders.find((f) => f.path === folder);
	assert.deepEqual(names(node), { files: [], folders: [] });
});

test('renaming a folder moves everything in it; the old paths are deletions', (t) => {
	const { media, drafts } = setup(t);
	assert.equal(media.rename('assets/images/team', 'Équipe', ROOT), 'assets/images/equipe');
	assert.deepEqual(names(media.tree(ROOT)), { files: ['cover.jpg'], folders: ['equipe'] });
	assert.equal(drafts.read('assets/images/equipe/ada.jpg').toString(), 'synced assets/images/team/ada.jpg');
	assert.equal(drafts.list().find((d) => d.path === 'assets/images/team/ada.jpg').deleted, true);
});

test('renaming to the same clean name changes nothing', (t) => {
	const { media, drafts } = setup(t);
	assert.equal(media.rename('assets/images/cover.jpg', 'Cover.jpg', ROOT), 'assets/images/cover.jpg');
	assert.deepEqual(drafts.list(), []);
});

test('deleting: a synced file is marked deleted, a new one just goes away', (t) => {
	const { media, drafts } = setup(t);
	const added = media.add(ROOT, 'temp.jpg', Buffer.from('t'), ROOT);
	media.delete(added, ROOT);
	media.delete('assets/images/team', ROOT);
	assert.deepEqual(drafts.list().map(({ path: p, deleted }) => [p, deleted]), [['assets/images/team/ada.jpg', true]]);
	assert.deepEqual(names(media.tree(ROOT)), { files: ['cover.jpg'], folders: [] });
});
