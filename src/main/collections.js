// Collections: `include` globs from the studio block (e.g. `src/blog/*.md`).
// Their files are listed from the synced copy with the client's drafts laid
// over it, so a post they just created shows up and a deleted one doesn't.
// With `create: true` the client can add and delete files; that needs a
// pattern of the form "<folder>/*.<ext>" to know where a new file goes.
import fs from 'node:fs';
import path from 'node:path';
import { humanize } from './scope.js';
import { safeName } from './media.js';

const DATA_EXTS = new Set(['.md', '.yaml', '.yml', '.json']);

// "src/blog/*.md" → { folder: "src/blog", ext: ".md" }; null when new files
// can't be placed (nested or multi-extension patterns).
export function creationTarget(pattern) {
	const match = /^([^*?[\]{}]+)\/\*(\.[a-z0-9]+)$/i.exec(pattern);
	if (!match || !DATA_EXTS.has(match[2].toLowerCase())) return null;
	return { folder: match[1], ext: match[2].toLowerCase() };
}

// What a new file starts with: a heading for Markdown, an empty document
// otherwise.
function starter(ext, title) {
	if (ext === '.md') return `# ${title}\n\n`;
	if (ext === '.json') return '{}\n';
	return '';
}

// A collection file's label: its first Markdown heading, else its name.
function labelOf(rel, text) {
	if (rel.endsWith('.md')) {
		const heading = /^#{1,6}\s+(.+?)\s*#*\s*$/m.exec(text ?? '');
		if (heading) return heading[1];
	}
	return humanize(path.posix.basename(rel, path.posix.extname(rel)));
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
		return [...found].sort().map((rel) => ({
			path: rel,
			label: labelOf(rel, drafts.read(rel)?.toString('utf8')),
			group: null,
			kind: rel.endsWith('.md') ? 'markdown' : 'data',
			schema: collection.files.find((f) => f.path === rel)?.schema ?? null,
		}));
	}

	return {
		files,

		// Whether `rel` belongs to a collection (existing or new file).
		contains: (rel) => scope.collections.some((collection) => matches(collection, rel)),

		// Creates a file from a title; returns its path.
		create(pattern, title) {
			const collection = byPattern(pattern);
			const target = collection.create && creationTarget(pattern);
			if (!target) throw new Error('This collection does not allow new files.');
			const clean = String(title).trim() || 'untitled';
			const base = safeName(clean + target.ext);
			const stem = base.slice(0, -target.ext.length);
			let rel = `${target.folder}/${base}`;
			const taken = new Set(files(pattern).map((f) => f.path));
			for (let n = 2; taken.has(rel); n++) rel = `${target.folder}/${stem}-${n}${target.ext}`;
			drafts.save(rel, starter(target.ext, clean));
			return rel;
		},

		delete(rel) {
			const collection = scope.collections.find((c) => matches(c, rel));
			if (!collection?.create) throw new Error('This collection does not allow deleting files.');
			drafts.remove(rel);
		},
	};
}
