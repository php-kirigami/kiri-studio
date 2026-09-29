// What the client may edit in a synced site, from its kirigami.yaml `studio:`
// block (see the core README's `studio:` section):
//
//   - content: every .md/.yaml/.yml/.json file a page loads through a PHPDOC
//     annotation, grouped by page in annotation order, plus `include`
//     entries, minus `exclude`; data files carry their JSON Schema, if any;
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
import * as yaml from 'yaml';
import { lfsPatterns } from '../shared/lfs.js';

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
	const config = yaml.parse(fs.readFileSync(path.join(treeDir, 'kirigami.yaml'), 'utf8'));
	return config && typeof config === 'object' ? config : {};
}

export function buildScope(treeDir, config = readStudioConfig(treeDir)) {
	const studio = config.studio ?? {};
	const root = toPosix(config.kirigami?.root ?? 'src');
	const exclude = (studio.exclude ?? []).map(toPosix);
	const excluded = (rel) => isExcluded(exclude, rel);
	const isFile = (rel) => {
		const abs = path.resolve(treeDir, rel);
		return inside(treeDir, abs) && fs.existsSync(abs) && fs.statSync(abs).isFile();
	};
	const schemaFor = schemaResolver(treeDir, studio);

	// Entries keep discovery order: pages as the tree walk meets them (the home
	// page first), each page's files in annotation order.
	const content = new Map();
	// `page`: the page that loads the file, for the live preview (null if none).
	const entry = (rel, label, group = null, page = null) => {
		const kind = kindOf(rel);
		return { path: rel, label: studio.labels?.[rel] ?? label, group, page, kind, schema: kind === 'data' ? schemaFor(rel) : null };
	};
	const add = (rel, label, group, page = null) => {
		if (content.has(rel) || excluded(rel) || !isFile(rel)) return;
		content.set(rel, entry(rel, label, group, page));
	};

	// Page-referenced content, grouped under the page's title.
	for (const pageRel of walk(treeDir, root, (rel) => isPage(path.posix.relative(root, rel)))) {
		const block = firstDocBlock(fs.readFileSync(path.join(treeDir, pageRel), 'utf8'));
		if (!block) continue;
		const info = parseDocBlock(block);
		const title = info.title || pageTitle(path.posix.relative(root, pageRel));
		for (const [tag, value] of Object.entries(info)) {
			if (!DATA_EXTS.has(path.posix.extname(value).toLowerCase()) || URL_RE.test(value)) continue;
			const rel = path.posix.normalize(path.posix.join(path.posix.dirname(pageRel), value));
			add(rel, tag === 'content' ? title : humanize(tag), title, pageRel);
		}
	}

	// `include`: single files join the content list; globs become collections.
	const collections = [];
	for (const item of studio.include ?? []) {
		const { path: pattern, label, create = false } = typeof item === 'string' ? { path: item } : item;
		if (!GLOB_RE.test(pattern)) {
			add(pattern, label ?? humanize(path.posix.basename(pattern, path.posix.extname(pattern))), null);
			continue;
		}
		const files = fs.globSync(pattern, { cwd: treeDir })
			.map(toPosix)
			.filter((rel) => DATA_EXTS.has(path.posix.extname(rel).toLowerCase()) && !excluded(rel) && isFile(rel))
			.sort()
			.map((rel) => entry(rel, humanize(path.posix.basename(rel, path.posix.extname(rel)))));
		collections.push({ pattern, label: label ?? humanize(path.posix.dirname(pattern).split('/').pop()), create, files });
	}

	const imagesDir = studio.images === false ? null : toPosix(studio.images ?? config.image?.source ?? 'assets/images');
	return {
		content: [...content.values()],
		collections,
		images: imagesDir && folderTree(treeDir, imagesDir, excluded),
		files: studio.files ? folderTree(treeDir, toPosix(studio.files), excluded) : null,
		exclude,
		// Paths kept in Git LFS (`filter=lfs` in .gitattributes): their bytes
		// are published to LFS, and they may be bigger than other files.
		lfs: lfsPatterns(readOptional(path.join(treeDir, '.gitattributes'))),
		// For the {% img-asset <path> <width> %} code: paths are relative to image.source.
		root,
		imageSource: toPosix(config.image?.source ?? 'assets/images'),
		imageWidth: Number.isInteger(studio.imageWidth) && studio.imageWidth > 0 ? studio.imageWidth : 800,
	};
}

function readOptional(file) {
	try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

// A path matches an `exclude` pattern, or lies inside a folder that does.
export function isExcluded(patterns, rel) {
	return patterns.some((pattern) => rel === pattern || rel.startsWith(`${pattern}/`) || path.posix.matchesGlob(rel, pattern));
}

// The media folder (images or files) `rel` belongs to, or null. Anything below
// a media folder counts, including what the client added since the sync.
export function mediaRootOf(scope, rel) {
	if (typeof rel !== 'string' || rel.split('/').some((part) => part === '..' || part === '')) return null;
	if (isExcluded(scope.exclude, rel)) return null;
	return [scope.images, scope.files].find((media) => media && (rel === media.path || rel.startsWith(`${media.path}/`)))?.path ?? null;
}

// Whether `rel` is something the client may open: guards every file read the
// renderer asks for.
export function inScope(scope, rel) {
	if (scope.content.some((entry) => entry.path === rel)) return true;
	if (scope.collections.some((c) => c.files.some((f) => f.path === rel))) return true;
	return mediaRootOf(scope, rel) !== null;
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

// Files of a folder before its subfolders, each sorted, so the home page comes
// first and the order doesn't depend on the file system.
function* walk(treeDir, rel, accept) {
	const abs = path.join(treeDir, rel);
	if (!fs.existsSync(abs)) return;
	const entries = fs.readdirSync(abs, { withFileTypes: true })
		.filter((entry) => !entry.name.startsWith('.') && entry.name !== 'node_modules')
		.sort((a, b) => (a.name < b.name ? -1 : 1));
	const child = (entry) => (rel === '.' ? entry.name : `${rel}/${entry.name}`);
	for (const entry of entries) if (entry.isFile() && accept(child(entry))) yield child(entry);
	for (const entry of entries) if (entry.isDirectory()) yield* walk(treeDir, child(entry), accept);
}

const kindOf = (rel) => (path.posix.extname(rel).toLowerCase() === '.md' ? 'markdown' : 'data');
const toPosix = (p) => String(p).replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, '');
const inside = (dir, abs) => abs === path.resolve(dir) || abs.startsWith(path.resolve(dir) + path.sep);

// "about/_index.php" → "About"; the root page → "Home".
function pageTitle(pageRel) {
	const dir = path.posix.dirname(pageRel);
	return dir === '.' ? 'Home' : humanize(dir.split('/').pop());
}

// "citationBrown" → "Citation brown", "01-portraits" → "Portraits".
export function humanize(name) {
	const words = String(name)
		.replace(/^[_\d]+[-_. ]*/, '')
		.replace(/([a-z])([A-Z])/g, '$1 $2')
		.replace(/[-_]+/g, ' ')
		.trim()
		.toLowerCase();
	return words ? words[0].toUpperCase() + words.slice(1) : String(name);
}

// JSON Schema of a data file, looked up like VS Code's YAML extension so a
// site already set up for VS Code needs nothing more. First match wins:
//   1. a `# yaml-language-server: $schema=<path or URL>` line in the file
//      (path relative to the file);
//   2. `studio.schemas` in kirigami.yaml;
//   3. `yaml.schemas` in the repo's .vscode/settings.json.
// 2 and 3 share VS Code's format: { "<schema path or URL>": "<glob>" | [globs] },
// schema paths relative to the repo root; a glob without "/" matches the file
// name anywhere. Returns { path } (repo-relative), { url }, or null.
export function schemaResolver(treeDir, studio, read = (rel) => fs.readFileSync(path.join(treeDir, rel), 'utf8')) {
	const tables = [studio.schemas, vscodeYamlSchemas(treeDir)].filter((t) => t && typeof t === 'object');
	const target = (value, baseDir) => (URL_RE.test(value)
		? { url: value }
		: { path: path.posix.normalize(path.posix.join(baseDir, toPosix(value).replace(/^\//, ''))) });

	return (rel) => {
		let head = '';
		try { head = String(read(rel) ?? '').slice(0, 2048); } catch { /* a new file: no modeline yet */ }
		const modeline = /^#\s*yaml-language-server:\s*\$schema=(\S+)/m.exec(head);
		if (modeline) return target(modeline[1], path.posix.dirname(rel));
		for (const table of tables) {
			for (const [schema, globs] of Object.entries(table)) {
				const patterns = (Array.isArray(globs) ? globs : [globs]).map((g) => toPosix(g).replace(/^\//, ''));
				const hit = patterns.some((p) => (p.includes('/') ? path.posix.matchesGlob(rel, p) : path.posix.matchesGlob(path.posix.basename(rel), p)));
				if (hit) return target(schema, '.');
			}
		}
		return null;
	};
}

function vscodeYamlSchemas(treeDir) {
	const file = path.join(treeDir, '.vscode', 'settings.json');
	if (!fs.existsSync(file)) return null;
	try {
		return JSON.parse(stripJsonComments(fs.readFileSync(file, 'utf8')))['yaml.schemas'] ?? null;
	} catch {
		return null; // a broken settings file just means no schemas from it
	}
}

// VS Code settings are JSONC: drop comments and trailing commas, leaving
// strings alone.
export function stripJsonComments(text) {
	return text
		.replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (match, string) => string ?? '')
		.replace(/("(?:\\.|[^"\\])*")|,(\s*[}\]])/g, (match, string, close) => string ?? close);
}
