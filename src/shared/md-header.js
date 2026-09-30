// The `@tag value` header atop a Kirigami Markdown page (`_index.md`), read
// the way php-prepros's FS::splitHeader() reads it: the tag lines at the top
// of the file (leading blank lines allowed), a value wrapping onto indented
// lines, up to the first blank line (the separator) or flush-left line that
// isn't a tag. `@@tag` is a tag passed down to child pages too.
//
// Used by the main process (discovery, labels, new pages) and the renderer
// (the header form). Joining an untouched header gives back the exact
// original text, and editing one field only rewrites that field's line, so
// diffs stay clean.

const TAG_RE = /^(@(@?)([A-Za-z0-9_]+)[ \t]*)(.*)$/;

// Lines with their terminators: [{ text, raw }], `raw` = text + "\r\n" / "\n" / "".
function lines(text) {
	const out = [];
	const re = /\r\n|\r|\n/g;
	let start = 0;
	for (let m; (m = re.exec(text));) {
		out.push({ text: text.slice(start, m.index), raw: text.slice(start, re.lastIndex) });
		start = re.lastIndex;
	}
	if (start < text.length) out.push({ text: text.slice(start), raw: text.slice(start) });
	return out;
}

// → { lead, tags: [{ name, inherited, prefix, value, raw }], sep, body, eol },
// or null when the file has no header. A `name: null` tag is a line kept as
// is (an `@`-line that isn't a valid tag).
export function splitHeader(text) {
	const all = lines(text);
	const eol = /\r\n/.test(text) ? '\r\n' : '\n';
	let i = 0;
	while (i < all.length && all[i].text.trim() === '') i++;
	if (i === all.length || !all[i].text.startsWith('@')) return null;
	const lead = all.slice(0, i).map((l) => l.raw).join('');
	const tags = [];
	for (; i < all.length; i++) {
		const { text: line, raw } = all[i];
		const tag = TAG_RE.exec(line);
		const current = tags.at(-1);
		if (tag) {
			tags.push({ name: tag[3], inherited: tag[2] === '@', prefix: tag[1], value: tag[4].trim(), raw });
		} else if (line.startsWith('@')) {
			tags.push({ name: null, raw });
		} else if (current?.name && line.trim() !== '' && /^[ \t]/.test(line)) {
			current.raw += raw;
			current.value = `${current.value} ${line.trim()}`.trim();
		} else {
			break;
		}
	}
	let sep = '';
	if (i < all.length && all[i].text.trim() === '') sep = all[i++].raw;
	return { lead, tags, sep, body: all.slice(i).map((l) => l.raw).join(''), eol };
}

// A header's tags as { name: value } (inherited ones included).
export function headerInfo(text) {
	const header = splitHeader(text);
	const info = {};
	for (const tag of header?.tags ?? []) if (tag.name) info[tag.name] = tag.value;
	return info;
}

// With a new body, the header still has to end where it did: its last line
// gets a line break, and a body that would read as part of the header (an
// indented or `@` first line) gets a blank separator line.
export function joinHeader(header, body = header.body) {
	let tags = header.tags.map((tag) => tag.raw).join('');
	let { sep } = header;
	if (body !== '') {
		if (!/[\r\n]$/.test(tags)) tags += header.eol;
		if (!sep && /^([ \t]+\S|@)/.test(body)) sep = header.eol;
	}
	return header.lead + tags + sep + body;
}

// Sets one tag's value (a new header object; the others keep their text).
// An existing tag keeps its alignment; a missing one is added after the last.
export function setTag(header, name, value) {
	const clean = String(value).replace(/\s*[\r\n]+\s*/g, ' ').trim();
	const tags = header.tags.map((tag) => ({ ...tag }));
	const line = (prefix, raw) => `${/[ \t]$/.test(prefix) || clean === '' ? prefix : `${prefix} `}${clean}`.replace(/[ \t]+$/, '') + (/(\r\n|\r|\n)$/.exec(raw)?.[0] ?? header.eol);
	const existing = tags.find((tag) => tag.name === name);
	if (existing) {
		existing.raw = line(existing.prefix, existing.raw);
		existing.value = clean;
	} else {
		const last = tags.at(-1);
		if (last && !/[\r\n]$/.test(last.raw)) last.raw += header.eol;
		tags.push({ name, inherited: false, prefix: `@${name} `, value: clean, raw: line(`@${name} `, '') });
	}
	return { ...header, tags };
}

// Removes a page's own tag (its `@@` form too); unchanged when missing.
export function removeTag(header, name) {
	return { ...header, tags: header.tags.filter((tag) => tag.name !== name) };
}

// A new page's text: `@title` first, then the collection's default tags.
export function newHeader(title, extra = {}, eol = '\n') {
	const entries = [['title', title], ...Object.entries(extra).filter(([name]) => name !== 'title')];
	const width = Math.max(...entries.map(([name]) => name.length));
	return entries.map(([name, value]) => `@${name.padEnd(width)} ${String(value).trim()}`.trimEnd()).join(eol) + eol + eol;
}
