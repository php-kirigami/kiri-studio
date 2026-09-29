// Manual check of publishing against real GitHub, on a throwaway branch of a
// scratch repository (never a client's site). Not part of `npm test`:
//
//   GH_TOKEN=$(gh auth token) node scripts/publish-live.mjs php-kirigami/kiri-studio-sandbox
//
// It creates a branch, adds a .gitattributes routing *.pdf to Git LFS, then
// publishes drafts through the same code the app uses: a text edit, a new
// image, a deletion, and a PDF that must land in LFS as a pointer. It reads the
// result back (commit tree, pointer, LFS download) and deletes the branch.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDrafts } from '../src/main/drafts.js';
import { createClient } from '../src/main/github.js';
import { createLfs, parsePointer } from '../src/main/lfs.js';
import { describeChanges, publishSite } from '../src/main/publish.js';
import { syncSite } from '../src/main/sync.js';

const fullName = process.argv[2];
const token = process.env.GH_TOKEN;
if (!fullName || !token) {
	console.error('Usage: GH_TOKEN=<token> node scripts/publish-live.mjs <owner/repo>');
	process.exit(2);
}

const gh = createClient(token);
const repo = `/repos/${fullName}`;
const branch = `kiri-studio-live-${Date.now()}`;
const site = { fullName, branch };
const b64 = (text) => Buffer.from(text).toString('base64');

const main = await gh.json(`${repo}/git/ref/heads/${(await gh.json(repo)).default_branch}`);
await gh.send('POST', `${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: main.object.sha });
console.log(`branch ${branch} created`);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiri-live-'));
try {
	// A branch with the LFS rule, a file to edit, and one to delete.
	const put = (file, text, message) => gh.send('PUT', `${repo}/contents/${file}`, { message, content: b64(text), branch });
	await put('.gitattributes', '*.pdf filter=lfs diff=lfs merge=lfs -text\n', 'test: LFS rule');
	await put('live/home.md', '# Home\n', 'test: home');
	await put('live/old.txt', 'to delete\n', 'test: old');

	// What the app has once a site is open: the synced copy, then drafts on top.
	const treeDir = path.join(dir, 'tree');
	await syncSite(gh, site, dir);
	const drafts = createDrafts(dir, treeDir);
	const image = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
	const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(300_000, 7)]);
	drafts.save('live/home.md', '# Home, edited from Kiri Studio\n');
	drafts.save('live/images/dot.png', image);
	drafts.save('live/rapports/report.pdf', pdf);
	drafts.remove('live/old.txt');

	const lfs = createLfs(token, fullName);
	const states = [];
	const result = await publishSite({
		gh, lfs, site, siteDir: dir, treeDir, drafts,
		message: (work) => describeChanges(work, { content: [{ path: 'live/home.md', label: 'Home' }], collections: [], images: { path: 'live/images' }, files: { path: 'live/rapports' } }),
		onStatus: (s) => states.push(s.state),
	});
	assert.equal(result.published, true);
	console.log(`published ${result.sha.slice(0, 7)} (${states.join(' → ')})`);

	// Read it back.
	const commit = await gh.json(`${repo}/git/commits/${result.sha}`);
	console.log(`message: ${commit.message.split('\n')[0]}`);
	const read = (file) => gh.text(`${repo}/contents/${file}?ref=${branch}`);
	assert.equal(await read('live/home.md'), '# Home, edited from Kiri Studio\n');
	const dot = await gh.json(`${repo}/contents/live/images/dot.png?ref=${branch}`);
	assert.equal(Buffer.from(dot.content, 'base64').equals(image), true);
	await assert.rejects(read('live/old.txt'), (error) => error.status === 404, 'deleted file is gone');

	const pointerText = await read('live/rapports/report.pdf');
	const pointer = parsePointer(Buffer.from(pointerText));
	assert.ok(pointer, `the PDF is committed as an LFS pointer, got: ${pointerText.slice(0, 80)}`);
	assert.equal(pointer.size, pdf.length);
	const back = await lfs.download(pointer, branch);
	assert.equal(back.equals(pdf), true, 'LFS returns the uploaded bytes');
	assert.deepEqual(drafts.list(), [], 'drafts are cleared');
	console.log('OK: text, image, deletion and an LFS PDF all published and read back');
} finally {
	await gh.send('DELETE', `${repo}/git/refs/heads/${branch}`).catch(() => {});
	fs.rmSync(dir, { recursive: true, force: true });
	console.log(`branch ${branch} deleted`);
}
