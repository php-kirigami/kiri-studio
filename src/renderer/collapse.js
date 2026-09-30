// Which sidebar sections and tree pages the client folded, remembered per site.
// A per-viewer convenience only: storage can be missing or throw (private mode, tests), in
// which case every choice simply lasts until the sidebar is rebuilt.

const PREFIX = 'kiri-studio:folded:';

export function createCollapseStore(siteName, storage = globalThis.localStorage) {
	const key = PREFIX + siteName;
	let choices = {};
	try { choices = JSON.parse(storage?.getItem(key) ?? '{}') ?? {}; } catch { choices = {}; }
	if (typeof choices !== 'object' || Array.isArray(choices)) choices = {};

	return {
		// The client's last choice for `id`, else `fallback`.
		isOpen(id, fallback) {
			return typeof choices[id] === 'boolean' ? choices[id] : fallback;
		},
		set(id, open) {
			choices[id] = open;
			try { storage?.setItem(key, JSON.stringify(choices)); } catch { /* not remembered, still applied */ }
		},
	};
}
