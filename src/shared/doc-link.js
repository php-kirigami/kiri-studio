// The Markdown link to a document of the site (a file of the `studio.files` folder, published as is
// from under `kirigami.root`): [name](/folder/name.pdf). The path starts at the site's root, plus the
// path of `baseurl` when the site lives in a sub-folder (user.github.io/repo), so it is valid from a
// page at any depth. Spaces, accents and parentheses are percent-encoded so the link stays one token.
// Null for a file outside `root`, which is not published.
export function documentLink(scope, rel) {
	const root = `${scope.root}/`;
	if (!rel.startsWith(root)) return null;
	const parts = rel.slice(root.length).split('/');
	const label = parts.at(-1).replace(/\.[^.]+$/, '').replace(/[[\]\\]/g, '\\$&');
	const encode = (part) => encodeURIComponent(part).replace(/[()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
	return `[${label}](${scope.basePath ?? ''}/${parts.map(encode).join('/')})`;
}
