// Unpublished changes ("drafts") of one site, kept apart from the synced copy
// so a sync never overwrites the client's work and a crash never loses it.
//
// <siteDir>/drafts/files/<path>  the edited file, written atomically
// <siteDir>/drafts/index.json    { [path]: { base, updatedAt } }
//
// `base` is the sha-256 of the synced file the edit started from (null for a
// new file). Publishing (phase 4) compares it with the synced copy to tell
// whether someone else changed the same file in the meantime.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const hash = (data) => createHash('sha256').update(data).digest('hex');

export function createDrafts(siteDir, treeDir) {
	const dir = path.join(siteDir, 'drafts');
	const filesDir = path.join(dir, 'files');
	const indexFile = path.join(dir, 'index.json');

	const readIndex = () => {
		try { return JSON.parse(fs.readFileSync(indexFile, 'utf8')); } catch { return {}; }
	};
	const writeIndex = (index) => writeAtomic(indexFile, JSON.stringify(index, null, 2));
	const synced = (rel) => {
		const file = path.join(treeDir, rel);
		return fs.existsSync(file) ? fs.readFileSync(file) : null;
	};

	return {
		has: (rel) => rel in readIndex(),

		list: () => Object.entries(readIndex()).map(([rel, meta]) => ({ path: rel, ...meta })),

		// The client's current version: the draft if there is one, else the synced file.
		read(rel) {
			const draft = path.join(filesDir, rel);
			if (rel in readIndex() && fs.existsSync(draft)) return fs.readFileSync(draft);
			return synced(rel);
		},

		// Saves an edit. Saving content identical to the synced file drops the
		// draft, so undoing a change by hand leaves nothing to publish.
		save(rel, data) {
			const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
			const index = readIndex();
			const original = synced(rel);
			if (original && original.equals(buf)) {
				if (rel in index) this.discard(rel);
				return false;
			}
			writeAtomic(path.join(filesDir, rel), buf);
			index[rel] = {
				base: index[rel]?.base !== undefined ? index[rel].base : original && hash(original),
				updatedAt: new Date().toISOString(),
			};
			writeIndex(index);
			return true;
		},

		discard(rel) {
			const index = readIndex();
			delete index[rel];
			writeIndex(index);
			fs.rmSync(path.join(filesDir, rel), { force: true });
		},
	};
}

function writeAtomic(file, data) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, data);
	fs.renameSync(tmp, file);
}
