// Links to a file of the site that is published as is from under `kirigami.root` (a document of the
// `studio.files` folder, or an image kept under the root, like an SVG logo). The path starts at the
// site's root, plus the path of `baseurl` when the site lives in a sub-folder (user.github.io/repo),
// so it is valid from a page at any depth. Null for a file outside `root`, which is not published.

// "/folder/name.pdf": the file's address on the site, as it reads in the repo (not encoded).
export function sitePath(scope, rel) {
	const root = `${scope.root}/`;
	return rel.startsWith(root) ? `${scope.basePath ?? ''}/${rel.slice(root.length)}` : null;
}

// [name](/folder/name.pdf), or ![name](/folder/image.svg) with `image`. Spaces, accents and parentheses
// are percent-encoded so the link stays one token.
export function documentLink(scope, rel, { image = false } = {}) {
	const path = sitePath(scope, rel);
	if (path === null) return null;
	const name = rel.split('/').at(-1).replace(/\.[^.]+$/, '');
	const label = (image ? name.replace(/[-_]+/g, ' ').trim() : name).replace(/[[\]\\]/g, '\\$&');
	const encode = (part) => encodeURIComponent(part).replace(/[()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
	return `${image ? '!' : ''}[${label}](${path.split('/').map(encode).join('/')})`;
}
