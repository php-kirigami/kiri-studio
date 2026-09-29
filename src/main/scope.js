// What the client may edit in a synced site, from its kirigami.yaml `studio:`
// block (see the core README's `studio:` section):
//
//   - content: every .md/.yaml/.yml/.json file a page loads through a PHPDOC
//     annotation, plus `include` entries, minus `exclude`;
//   - collections: `include` globs whose files the client may add or delete;
//   - images / files: the media folders, as folder trees.
//
// Page discovery and annotation parsing mirror Kirigami exactly: a page is a
// `_*.php` file under kirigami.root with no `_`-prefixed folder on its path
// (core's isPage()); annotations come from the file's first doc comment, parsed
// like php-prepros's FS::parseDocBlock(); a data value is resolved against the
// page's folder, like php-prepros's `page_info` hook. All returned paths are
// POSIX, relative to the repository root.
import fs from 'node:fs';
import path from 'node:path';
import * as yaml from 'js-yaml';

const DATA_EXTS = new Set(['.md', '.yaml', '.yml', '.json']);
const URL_RE = /^[a-z][a-z0-9+.-]*:\/\//i;
const GLOB_RE = /[*?[\]{}]/;

// Port of php-prepros FS::parseDocBlock(): `@tag value` lines; a value wraps
// onto indented continuation lines, up to the next tag, a blank line, or a
// flush-left prose line.
export function parseDocBlock(block) {
	const info = {};
	let current = null;
	for (let line of block.split(/\r\n|\r|\n/)) {
		line = line.replace(/^\s*\/\*\*+/, '').replace(/\s*\*\/\s*$/, '').replace(/^[ \t]*\*[ \t]?/, '');
		const tag = /^@([A-Za-z0-9_]+)[ \t]*(.*)$/.exec(line);
		if (tag) {
			current = tag[1];
			info[current] = tag[2].trim();
		} else if (line.trim() === '') {
			current = null;
		} else if (current !== null && /^[ \t]/.test(line)) {
			info[current] = `${info[current]} ${line.trim()}`.trim();
		} else {
			current = null;
		}
	}
	return info;
}

// First doc comment in PHP code. PHP's tokenizer only sees doc comments after
// the opening tag, so text before `<?php` is skipped.
export function firstDocBlock(source) {
	const start = source.indexOf('<?php');
	if (start === -1) return null;
	return /\/\*\*[\s\S]*?\*\//.exec(source.slice(start))?.[0] ?? null;
}

// Same rule as core's isPage(): relative to kirigami.root, POSIX separators.
export function isPage(rel) {
	const parts = rel.split('/');
	const name = parts.pop();
	return /^_.*\.php$/i.test(name) && !parts.some((part) => part.startsWith('_'));
}

export function readStudioConfig(treeDir) {
	const config = yaml.load(fs.readFileSync(path.join(treeDir, 'kirigami.yaml'), 'utf8'));
	return config && typeof config === 'object' ? config : {};
}

export function buildScope(treeDir, config = readStudioConfig(treeDir)) {
	const studio = config.studio ?? {};
	const root = toPosix(config.kirigami?.root ?? 'src');
	const excluded = (rel) => (studio.exclude ?? []).some((pattern) => rel === pattern || path.matchesGlob(rel, pattern));
	const isFile = (rel) => {
		const abs = path.resolve(treeDir, rel);
		return inside(treeDir, abs) && fs.existsSync(abs) && fs.statSync(abs).isFile();
	};
	const labelFor = (rel, fallback) => studio.labels?.[rel] ?? fallback;

	const content = new Map();
	const add = (rel, fallback, page = null) => {
		if (content.has(rel) || excluded(rel) || !isFile(rel)) return;
		content.set(rel, { path: rel, label: labelFor(rel, fallback), kind: kindOf(rel), page });
	};

	// Page-referenced content.
	for (const pageRel of walk(treeDir, root, (rel) => isPage(path.posix.relative(root, rel)))) {
		const block = firstDocBlock(fs.readFileSync(path.join(treeDir, pageRel), 'utf8'));
		if (!block) continue;
		const info = parseDocBlock(block);
		const title = info.title || pageTitle(path.posix.relative(root, pageRel));
		for (const [tag, value] of Object.entries(info)) {
			if (!DATA_EXTS.has(path.posix.extname(value).toLowerCase()) || URL_RE.test(value)) continue;
			const rel = path.posix.normalize(path.posix.join(path.posix.dirname(pageRel), value));
			add(rel, tag === 'content' ? title : `${title} · ${humanize(tag)}`, pageRel);
		}
	}

	// `include`: single files join the content list; globs become collections.
	const collections = [];
	for (const item of studio.include ?? []) {
		const { path: pattern, label, create = false } = typeof item === 'string' ? { path: item } : item;
		if (!GLOB_RE.test(pattern)) {
			add(pattern, label ?? humanize(path.posix.basename(pattern, path.posix.extname(pattern))));
			continue;
		}
		const files = fs.globSync(pattern, { cwd: treeDir })
			.map(toPosix)
			.filter((rel) => DATA_EXTS.has(path.posix.extname(rel).toLowerCase()) && !excluded(rel) && isFile(rel))
			.sort()
			.map((rel) => ({ path: rel, label: humanize(path.posix.basename(rel, path.posix.extname(rel))), kind: kindOf(rel) }));
		collections.push({ pattern, label: label ?? humanize(path.posix.dirname(pattern).split('/').pop()), create, files });
	}

	const imagesDir = studio.images === false ? null : toPosix(studio.images ?? config.image?.source ?? 'assets/images');
	return {
		content: [...content.values()].sort((a, b) => a.label.localeCompare(b.label)),
		collections,
		images: imagesDir && folderTree(treeDir, imagesDir, excluded),
		files: studio.files ? folderTree(treeDir, toPosix(studio.files), excluded) : null,
	};
}

// Whether `rel` is something the client may open: guards every file read the
// renderer asks for.
export function inScope(scope, rel) {
	if (scope.content.some((entry) => entry.path === rel)) return true;
	if (scope.collections.some((c) => c.files.some((f) => f.path === rel))) return true;
	return [scope.images, scope.files].some((media) => media && inTree(media, rel));
}

function inTree(node, rel) {
	if (!rel.startsWith(`${node.path}/`)) return false;
	const rest = rel.slice(node.path.length + 1);
	if (!rest.includes('/')) return true; // a file directly in this folder
	const child = node.folders.find((folder) => rel.startsWith(`${folder.path}/`));
	return !!child && inTree(child, rel); // excluded folders are absent from the tree
}

// { path, name, files, folders: [...] } — `files` counts direct children.
// `excluded` hides folders and files the same way it hides content (e.g. a
// plugin's cache folder inside the images folder).
export function folderTree(treeDir, rel, excluded = () => false) {
	const abs = path.join(treeDir, rel);
	const node = { path: rel, name: path.posix.basename(rel), files: 0, folders: [] };
	if (!fs.existsSync(abs)) return node;
	for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
		const child = `${rel}/${entry.name}`;
		if (entry.name.startsWith('.') || excluded(child)) continue;
		if (entry.isDirectory()) node.folders.push(folderTree(treeDir, child, excluded));
		else if (entry.isFile()) node.files++;
	}
	node.folders.sort((a, b) => a.name.localeCompare(b.name));
	return node;
}

function* walk(treeDir, rel, accept) {
	const abs = path.join(treeDir, rel);
	if (!fs.existsSync(abs)) return;
	for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
		if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
		const child = rel === '.' ? entry.name : `${rel}/${entry.name}`;
		if (entry.isDirectory()) yield* walk(treeDir, child, accept);
		else if (entry.isFile() && accept(child)) yield child;
	}
}

const kindOf = (rel) => (path.posix.extname(rel).toLowerCase() === '.md' ? 'markdown' : 'data');
const toPosix = (p) => String(p).replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, '');
const inside = (dir, abs) => abs === path.resolve(dir) || abs.startsWith(path.resolve(dir) + path.sep);

// "about/_index.php" → "About"; the root page → "Home".
function pageTitle(pageRel) {
	const dir = path.posix.dirname(pageRel);
	return dir === '.' ? 'Home' : humanize(dir.split('/').pop());
}

export function humanize(name) {
	const words = String(name).replace(/^_+/, '').replace(/[-_]+/g, ' ').trim();
	return words ? words[0].toUpperCase() + words.slice(1) : String(name);
}
