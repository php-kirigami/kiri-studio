// Unpublished changes ("drafts") of one site, kept apart from the synced copy
// so a sync never overwrites the client's work and a crash never loses it.
//
// <siteDir>/drafts/files/<path>  an added or edited file, written atomically
// <siteDir>/drafts/index.json    { [path]: { base, deleted?, updatedAt } }
//
// `base` is the sha-256 of the synced file the change started from (null for
// a new file). Publishing (phase 4) compares it with the synced copy to tell
// whether someone else changed the same file in the meantime. `deleted`
// marks a synced file the client removed (or moved: a rename is a delete
// plus an add).
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
		return fs.existsSync(file) && fs.statSync(file).isFile() ? fs.readFileSync(file) : null;
	};
	const baseOf = (index, rel) => {
		if (index[rel]?.base !== undefined) return index[rel].base;
		const original = synced(rel);
		return original && hash(original);
	};

	return {
		has: (rel) => rel in readIndex(),

		list: () => Object.entries(readIndex()).map(([rel, meta]) => ({ path: rel, ...meta })),

		// The client's current version: their change if any (null when they
		// deleted it), else the synced file (null when there is none).
		read(rel) {
			const meta = readIndex()[rel];
			if (meta?.deleted) return null;
			const draft = path.join(filesDir, rel);
			if (meta && fs.existsSync(draft)) return fs.readFileSync(draft);
			return synced(rel);
		},

		// Saves a change (text or bytes). Saving content identical to the
		// synced file drops the draft, so undoing a change by hand leaves
		// nothing to publish.
		save(rel, data) {
			const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
			const index = readIndex();
			const original = synced(rel);
			if (original && original.equals(buf)) {
				if (rel in index) this.discard(rel);
				return false;
			}
			writeAtomic(path.join(filesDir, rel), buf);
			index[rel] = { base: baseOf(index, rel), updatedAt: new Date().toISOString() };
			writeIndex(index);
			return true;
		},

		// Deletes a file: a synced one is marked deleted; one that only exists
		// as a draft simply goes away.
		remove(rel) {
			const index = readIndex();
			fs.rmSync(path.join(filesDir, rel), { force: true });
			if (synced(rel)) {
				index[rel] = { base: baseOf(index, rel), deleted: true, updatedAt: new Date().toISOString() };
			} else {
				delete index[rel];
			}
			writeIndex(index);
		},

		discard(rel) {
			const index = readIndex();
			delete index[rel];
			writeIndex(index);
			fs.rmSync(path.join(filesDir, rel), { force: true });
		},

		// After a publish: drops the changes that went out. A change the client
		// made again while publishing (a newer `updatedAt`) stays.
		forget(changes) {
			const index = readIndex();
			let dropped = 0;
			for (const change of changes) {
				if (index[change.path]?.updatedAt !== change.updatedAt) continue;
				delete index[change.path];
				fs.rmSync(path.join(filesDir, change.path), { force: true });
				dropped++;
			}
			if (dropped) writeIndex(index);
			return dropped;
		},

		// Changes whose synced file moved since the edit started: someone else
		// published that file (or created one at the same path) in the meantime.
		outdated() {
			return Object.entries(readIndex())
				.filter(([rel, meta]) => (meta.base ?? null) !== (synced(rel) && hash(synced(rel))))
				.map(([rel]) => rel);
		},

		// After a sync: drops the changes the synced copy now matches (the same
		// edit or deletion published from elsewhere). Returns their paths.
		tidy() {
			const index = readIndex();
			const dropped = Object.entries(index).filter(([rel, meta]) => {
				const original = synced(rel);
				if (meta.deleted) return original === null;
				const draft = path.join(filesDir, rel);
				return original !== null && fs.existsSync(draft) && original.equals(fs.readFileSync(draft));
			}).map(([rel]) => rel);
			for (const rel of dropped) {
				delete index[rel];
				fs.rmSync(path.join(filesDir, rel), { force: true });
			}
			if (dropped.length) writeIndex(index);
			return dropped;
		},
	};
}

function writeAtomic(file, data) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, data);
	fs.renameSync(tmp, file);
}
