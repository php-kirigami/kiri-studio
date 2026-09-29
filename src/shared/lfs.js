// Git LFS rules of a site, shared by the main process and the renderer.
//
// A site can keep big binaries (PDF reports) in Git LFS: its .gitattributes
// says `*.pdf filter=lfs …`. Git then stores a small pointer file instead of
// the bytes. Kiri Studio has no Git, so it has to know which paths those are:
// their bytes go to LFS on publish and only the pointer is committed.

// Plain files are capped low so a photo never bloats the repository; LFS
// paths (already meant for big files) can go further.
export const MAX_FILE_SIZE = 25 * 1024 * 1024;
export const MAX_LFS_FILE_SIZE = 100 * 1024 * 1024;

// The patterns of a .gitattributes text that route files to LFS. Later lines
// win in Git, so `-filter` / `filter=other` turns a pattern off again.
export function lfsPatterns(text) {
	const patterns = new Map();
	for (const raw of String(text ?? '').split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith('#')) continue;
		const [pattern, ...attributes] = line.split(/\s+/);
		if (attributes.includes('filter=lfs')) patterns.set(pattern, true);
		else if (attributes.some((a) => a === '-filter' || a.startsWith('filter='))) patterns.set(pattern, false);
	}
	return [...patterns].filter(([, on]) => on).map(([pattern]) => pattern);
}

// gitattributes glob → RegExp: `*` stays in a folder, `**` crosses folders, a
// pattern without a slash matches the file name anywhere.
function globToRegExp(pattern) {
	const anchored = pattern.startsWith('/');
	const body = pattern.replace(/^\//, '');
	let out = '';
	for (let i = 0; i < body.length; i++) {
		const c = body[i];
		if (c === '*') {
			if (body[i + 1] === '*') {
				i++;
				if (body[i + 1] === '/') { i++; out += '(?:.*/)?'; } else out += '.*';
			} else out += '[^/]*';
		} else if (c === '?') out += '[^/]';
		else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
	}
	const hasSlash = body.includes('/');
	return new RegExp(anchored || hasSlash ? `^${out}$` : `(?:^|/)${out}$`);
}

export function isLfsPath(patterns, rel) {
	return patterns.some((pattern) => globToRegExp(pattern).test(rel));
}

export const maxFileSize = (patterns, rel) => (isLfsPath(patterns, rel) ? MAX_LFS_FILE_SIZE : MAX_FILE_SIZE);
