import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildScope } from '../src/main/scope.js';
import { createSecrets } from '../src/main/secrets.js';
import { createDrafts } from '../src/main/drafts.js';
import { takeGenerated } from '../src/main/publish.js';

function tmp(t, files = {}) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiri-studio-secrets-'));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	for (const [rel, content] of Object.entries(files)) {
		fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
		fs.writeFileSync(path.join(dir, rel), content);
	}
	return dir;
}

const yamlSite = (studio) => `kirigami:\n  project: Test\n  baseurl: https://example.com\n  root: src\nstudio:\n${studio}`;

test('scope: studio.secrets and studio.publish', (t) => {
	const dir = tmp(t, {
		'kirigami.yaml': yamlSite([
			'  secrets:',
			'    keys:',
			'      geocodage: Clé de géocodage',
			'      autre: ""',
			'  publish:',
			'    - src/_data/comites/geocodage.json',
			'    - assets/images/comites/instagram/*.jpg',
			'    - ../outside.json',
		].join('\n')),
		'src/_index.php': '<?php /** @title Home */ ?>',
	});
	const scope = buildScope(dir);
	assert.deepEqual(scope.secrets, {
		file: 'secrets.local.yaml',
		keys: [{ name: 'geocodage', label: 'Clé de géocodage' }, { name: 'autre', label: 'Autre' }],
	});
	assert.deepEqual(scope.publish, ['src/_data/comites/geocodage.json', 'assets/images/comites/instagram/*.jpg']);
});

test('scope: no secrets or publish when the site declares none, or an unsafe file', (t) => {
	const none = buildScope(tmp(t, { 'kirigami.yaml': yamlSite('  images: false'), 'src/_index.php': '' }));
	assert.equal(none.secrets, null);
	assert.deepEqual(none.publish, []);
	const unsafe = buildScope(tmp(t, { 'kirigami.yaml': yamlSite('  secrets:\n    file: ../keys.yaml\n    keys: { a: A }'), 'src/_index.php': '' }));
	assert.equal(unsafe.secrets, null);
});

test('secrets: values stay encrypted on disk, are never listed, and make the preview file', (t) => {
	const dir = tmp(t);
	const crypt = {
		isEncryptionAvailable: () => true,
		encryptString: (s) => Buffer.from(s, 'utf8').map((b) => b ^ 0x5a),
		decryptString: (b) => Buffer.from(b).map((x) => x ^ 0x5a).toString('utf8'),
	};
	const spec = { file: 'secrets.local.yaml', keys: [{ name: 'geocodage', label: 'Clé' }, { name: 'autre', label: 'Autre' }] };
	const secrets = createSecrets(dir, crypt);

	assert.equal(secrets.file(spec), null, 'nothing set: no file');
	secrets.set(spec, 'geocodage', '  AIzaSECRET  ');
	assert.deepEqual(secrets.list(spec), [{ name: 'geocodage', label: 'Clé', set: true }, { name: 'autre', label: 'Autre', set: false }]);
	assert.ok(!fs.readFileSync(path.join(dir, 'secrets.bin')).includes('AIzaSECRET'), 'encrypted on disk');
	assert.deepEqual(secrets.file(spec), { rel: 'secrets.local.yaml', text: 'geocodage: AIzaSECRET\n' });

	assert.throws(() => secrets.set(spec, 'inconnue', 'x'), /Unknown key/);
	secrets.set(spec, 'geocodage', '');
	assert.equal(secrets.file(spec), null, 'an empty value removes the key');
});

test('takeGenerated: changed generated files become drafts, identical ones do not', (t) => {
	const siteDir = tmp(t);
	const treeDir = tmp(t, {
		'src/_data/comites/geocodage.json': '{"a":1}\n',
		'assets/images/comites/instagram/vieux.jpg': 'VIEUX',
	});
	const previewDir = tmp(t, {
		'src/_data/comites/geocodage.json': '{"a":1,"b":2}\n',
		'assets/images/comites/instagram/vieux.jpg': 'VIEUX',
		'assets/images/comites/instagram/nouveau.jpg': 'NOUVEAU',
		'src/index.html': '<p>build output, not declared</p>',
	});
	const drafts = createDrafts(siteDir, treeDir);
	const taken = takeGenerated({
		previewDir,
		patterns: ['src/_data/comites/geocodage.json', 'src/_data/comites/instagram.json', 'assets/images/comites/instagram/*.jpg'],
		drafts,
	});
	assert.deepEqual(taken.sort(), ['assets/images/comites/instagram/nouveau.jpg', 'src/_data/comites/geocodage.json']);
	assert.deepEqual(drafts.list().map((d) => d.path).sort(), taken.sort());
	assert.equal(drafts.read('src/_data/comites/geocodage.json').toString(), '{"a":1,"b":2}\n');
});
