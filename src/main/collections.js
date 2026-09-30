// Collections: `include` globs from the studio block (e.g. `src/blog/*.md`).
// Their files are listed from the synced copy with the client's drafts laid
// over it, so a post they just created shows up and a deleted one doesn't.
// With `create: true` (and only then: the site's kirigami.yaml decides) the
// client can add and delete entries. That needs a pattern that says where a
// new one goes: "<folder>/*.<ext>" (one file per entry),
// "<folder>/*/_index.md" (one folder per entry, holding a Markdown page) or
// "<folder>/**/_index.md" (a tree: any page can get sub-pages, each a folder
// inside its own). A page that still has sub-pages can't be deleted, so
// nothing below it is lost by accident.
import fs from 'node:fs';
import path from 'node:path';
import { humanize } from './scope.js';
import { safeName } from './media.js';
import { headerInfo, newHeader } from '../shared/md-header.js';

const DATA_EXTS = new Set(['.md', '.yaml', '.yml', '.json']);

// "src/blog/*.md" → { folder: "src/blog", ext: ".md" }, "src/posts/*/_index.md"
// → { folder: "src/posts", ext: ".md", index: "_index.md" },
// "src/docs/**/_index.md" → the same plus `tree: true`; null when new entries
// can't be placed (other nested or multi-extension patterns).
export function creationTarget(pattern) {
	const tree = /^([^*?[\]{}]+)\/\*\*\/(_index\.md)$/i.exec(pattern);
	if (tree) return { folder: tree[1], ext: '.md', index: tree[2], tree: true };
	const index = /^([^*?[\]{}]+)\/\*\/(_index\.md)$/i.exec(pattern);
	if (index) return { folder: index[1], ext: '.md', index: index[2] };
	const match = /^([^*?[\]{}]+)\/\*(\.[a-z0-9]+)$/i.exec(pattern);
	if (!match || !DATA_EXTS.has(match[2].toLowerCase())) return null;
	return { folder: match[1], ext: match[2].toLowerCase() };
}

// Today as YYYY-MM-DD, in the client's time zone.
function today(now = new Date()) {
	const pad = (n) => String(n).padStart(2, '0');
	return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

// What a new entry starts with: a Markdown page's `@tag` header (the
// collection's `header` defaults, `today` meaning the creation date), a
// heading for other Markdown, an empty document otherwise.
export function starter(target, title, header = {}, now = new Date()) {
	if (target.index) {
		const extra = Object.fromEntries(Object.entries(header).map(([name, value]) => [name, value === 'today' ? today(now) : value]));
		return newHeader(title, extra);
	}
	if (target.ext === '.md') return `# ${title}\n\n`;
	if (target.ext === '.json') return '{}\n';
	return '';
}

// A collection file's label: a Markdown page's @title, else its first
// Markdown heading, else its name (the folder's for an `_index.md`).
export function labelOf(rel, text) {
	if (rel.endsWith('.md')) {
		const title = headerInfo(text ?? '').title;
		if (title) return title;
		const heading = /^#{1,6}\s+(.+?)\s*#*\s*$/m.exec(text ?? '');
		if (heading) return heading[1];
	}
	const name = path.posix.basename(rel, path.posix.extname(rel));
	return humanize(name.toLowerCase() === '_index' ? path.posix.basename(path.posix.dirname(rel)) : name);
}

export function createCollections({ treeDir, drafts, scope, isExcluded }) {
	const byPattern = (pattern) => {
		const collection = scope.collections.find((c) => c.pattern === pattern);
		if (!collection) throw new Error('Unknown collection.');
		return collection;
	};

	const matches = (collection, rel) => path.posix.matchesGlob(rel, collection.pattern)
		&& DATA_EXTS.has(path.posix.extname(rel).toLowerCase())
		&& !isExcluded(rel);

	function files(pattern) {
		const collection = byPattern(pattern);
		const found = new Set(fs.globSync(pattern, { cwd: treeDir }).map((p) => p.replaceAll('\\', '/')).filter((rel) => matches(collection, rel)));
		for (const draft of drafts.list()) {
			if (!matches(collection, draft.path)) continue;
			if (draft.deleted) found.delete(draft.path);
			else found.add(draft.path);
		}
		// In a tree, each page's parent: the nearest folder above it holding a
		// page of the collection (null at the top).
		const parentOf = (rel) => {
			for (let dir = path.posix.dirname(path.posix.dirname(rel)); dir !== '.' && dir !== path.posix.dirname(dir); dir = path.posix.dirname(dir)) {
				const page = `${dir}/${path.posix.basename(rel)}`;
				if (page !== rel && found.has(page)) return page;
			}
			return null;
		};
		const tree = isTree(pattern);
		return [...found].sort().map((rel) => ({
			path: rel,
			label: labelOf(rel, drafts.read(rel)?.toString('utf8')),
			group: null,
			kind: rel.endsWith('.md') ? 'markdown' : 'data',
			schema: collection.files.find((f) => f.path === rel)?.schema ?? null,
			...(tree && { parent: parentOf(rel) }),
		}));
	}

	return {
		files,

		// Whether `rel` belongs to a collection (existing or new file).
		contains: (rel) => scope.collections.some((collection) => matches(collection, rel)),

		// Creates an entry from a title; returns its path. A folder collection
		// gets a new folder named after the title, never one that already
		// exists (in the synced copy or the drafts). In a tree, `parent` (a
		// page of the collection) puts the new page inside that page's folder.
		create(pattern, title, parent = null) {
			const collection = byPattern(pattern);
			const target = collection.create && creationTarget(pattern);
			if (!target) throw new Error('This collection does not allow new files.');
			const clean = String(title).trim() || 'untitled';
			const existing = files(pattern);
			const taken = new Set(existing.map((f) => f.path));
			if (parent !== null && (!target.tree || !taken.has(parent))) throw new Error('Not a page of this collection.');
			let rel;
			if (target.index) {
				const folder = parent ? path.posix.dirname(parent) : target.folder;
				const stem = safeName(clean + target.ext).slice(0, -target.ext.length);
				const used = (name) => fs.existsSync(path.join(treeDir, folder, name))
					|| drafts.list().some((d) => d.path.startsWith(`${folder}/${name}/`))
					|| taken.has(`${folder}/${name}/${target.index}`);
				let name = stem;
				for (let n = 2; used(name); n++) name = `${stem}-${n}`;
				rel = `${folder}/${name}/${target.index}`;
			} else {
				const base = safeName(clean + target.ext);
				const stem = base.slice(0, -target.ext.length);
				rel = `${target.folder}/${base}`;
				for (let n = 2; taken.has(rel); n++) rel = `${target.folder}/${stem}-${n}${target.ext}`;
			}
			drafts.save(rel, starter(target, clean, collection.header));
			return rel;
		},

		// Deletes an entry; returns the paths removed. A page of a folder
		// collection goes with its whole folder: its sub-pages and the files
		// kept next to it (images…), which nothing else owns. The top page of a
		// tree lives in the collection's own folder, so it can only go once it
		// has no sub-pages left.
		delete(rel) {
			const collection = scope.collections.find((c) => matches(c, rel));
			if (!collection?.create) throw new Error('This collection does not allow deleting files.');
			const target = creationTarget(collection.pattern);
			const dir = path.posix.dirname(rel);
			if (!target?.index || dir === target.folder) {
				if (isTree(collection.pattern) && files(collection.pattern).some((f) => f.parent === rel)) {
					throw new Error('This page has sub-pages: delete them first.');
				}
				drafts.remove(rel);
				return [rel];
			}
			const removed = new Set(filesUnder(treeDir, dir));
			for (const draft of drafts.list()) if (!draft.deleted && draft.path.startsWith(`${dir}/`)) removed.add(draft.path);
			for (const file of removed) drafts.remove(file);
			return [...removed].sort();
		},
	};
}

// Every file below `dir` in the synced copy, as repo-relative POSIX paths.
function filesUnder(treeDir, dir) {
	const abs = path.join(treeDir, dir);
	if (!fs.existsSync(abs)) return [];
	return fs.readdirSync(abs, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => path.posix.join(dir, path.relative(abs, path.join(entry.parentPath, entry.name)).replaceAll('\\', '/')));
}

// "src/docs/**/_index.md": pages nest, at any depth.
export const isTree = (pattern) => /\/\*\*\/_index\.md$/i.test(pattern);
