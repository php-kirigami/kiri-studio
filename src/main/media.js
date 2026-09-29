// Image and document folders as the client sees them: the synced copy with
// their unpublished changes laid over it (added, replaced, moved, deleted).
// Every change goes through the drafts, so media publish like text does.
//
// Git keeps no empty folders, so a new folder holds a hidden `.gitkeep`;
// dot files keep folders alive but are never listed.
import fs from 'node:fs';
import path from 'node:path';

export const MAX_FILE_SIZE = 25 * 1024 * 1024;
const KEEP = '.gitkeep';

// "Été 2026 (1).JPG" → "ete-2026-1.jpg": what survives every file system and URL.
export function safeName(name, { folder = false } = {}) {
	const ext = folder ? '' : path.extname(name).toLowerCase().replace(/[^a-z0-9.]/g, '');
	const base = (folder ? name : path.basename(name, path.extname(name)))
		.normalize('NFD').replace(/[̀-ͯ]/g, '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
	return (base || (folder ? 'folder' : 'file')) + ext;
}

export function createMedia({ treeDir, drafts, isExcluded }) {
	// Every visible file path under `root`, synced or drafted, minus deletions.
	function files(root) {
		const found = new Set();
		const walk = (rel) => {
			const abs = path.join(treeDir, rel);
			if (!fs.existsSync(abs)) return;
			for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
				const child = `${rel}/${entry.name}`;
				if (isExcluded(child)) continue;
				if (entry.isDirectory()) walk(child);
				else if (entry.isFile()) found.add(child);
			}
		};
		walk(root);
		for (const draft of drafts.list()) {
			if (!draft.path.startsWith(`${root}/`) || isExcluded(draft.path)) continue;
			if (draft.deleted) found.delete(draft.path);
			else found.add(draft.path);
		}
		return [...found];
	}

	const statusOf = (rel) => {
		const draft = drafts.list().find((d) => d.path === rel);
		if (!draft) return null;
		return draft.base ? 'modified' : 'added';
	};

	// { path, name, files: [{ name, path, size, status }], folders: [...] }
	function tree(root) {
		const make = (rel) => ({ path: rel, name: path.posix.basename(rel), files: [], folders: [] });
		const top = make(root);
		const folders = new Map([[root, top]]);
		const folderOf = (rel) => {
			if (!folders.has(rel)) {
				const node = make(rel);
				folders.set(rel, node);
				folderOf(path.posix.dirname(rel)).folders.push(node);
			}
			return folders.get(rel);
		};
		for (const rel of files(root).sort()) {
			const parent = folderOf(path.posix.dirname(rel));
			const name = path.posix.basename(rel);
			if (name.startsWith('.')) continue;
			parent.files.push({ name, path: rel, size: drafts.read(rel)?.length ?? 0, status: statusOf(rel) });
		}
		for (const node of folders.values()) node.folders.sort((a, b) => a.name.localeCompare(b.name));
		return top;
	}

	const exists = (rel, root) => files(root).some((f) => f === rel || f.startsWith(`${rel}/`));

	// "photo.jpg" → "photo-2.jpg" when taken.
	function uniquePath(folder, name, root) {
		const ext = path.posix.extname(name);
		const base = name.slice(0, name.length - ext.length);
		let candidate = `${folder}/${name}`;
		for (let n = 2; exists(candidate, root); n++) candidate = `${folder}/${base}-${n}${ext}`;
		return candidate;
	}

	return {
		files,
		tree,

		add(folder, name, bytes, root) {
			if (bytes.length > MAX_FILE_SIZE) throw Object.assign(new Error('File too large.'), { code: 'tooLarge' });
			const rel = uniquePath(folder, safeName(name), root);
			drafts.save(rel, bytes);
			return rel;
		},

		mkdir(parent, name, root) {
			const rel = uniquePath(parent, safeName(name, { folder: true }), root);
			drafts.save(`${rel}/${KEEP}`, '');
			return rel;
		},

		// Renames a file or a folder in place; returns the new path.
		rename(rel, name, root) {
			const isFolder = !files(root).includes(rel);
			const clean = safeName(name, { folder: isFolder });
			if (clean === path.posix.basename(rel)) return rel;
			const target = uniquePath(path.posix.dirname(rel), clean, root);
			const moved = isFolder ? files(root).filter((f) => f.startsWith(`${rel}/`)) : [rel];
			for (const file of moved) {
				drafts.save(target + file.slice(rel.length), drafts.read(file));
				drafts.remove(file);
			}
			return target;
		},

		// Deletes a file, or a folder with everything in it.
		delete(rel, root) {
			for (const file of files(root).filter((f) => f === rel || f.startsWith(`${rel}/`))) drafts.remove(file);
		},
	};
}
