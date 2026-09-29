import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractArchive } from '../src/main/sync.js';

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
