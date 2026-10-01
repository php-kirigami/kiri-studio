// The downloadable files of one Markdown page, kept in a `files/` folder next to its `_index.md` (a
// corrigé .zip, a PDF …) when the site lists `files` in `studio.pageMedia`. A collapsible panel like the
// page's media (page-media.js): add (drop or pick), insert the download link at the cursor, delete.
// Every change is a draft like any other (see media-view.js).
import { h } from './dom.js';
import { t } from './i18n.js';
import { maxFileSize } from '../shared/lfs.js';
import { insertBlock } from './markdown-editor.js';
import { formatSize, prepare } from './media-view.js';

// Words of the file name, as the label of its link: "corrige-tp-1.zip" → "corrige tp 1".
const labelOf = (name) => name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim();

// Returns the panel, or null when this entry has none (feature off, or not a page).
export function createPageFiles(ws, entry, editor) {
	if (!ws.scope.pageMedia?.includes('files') || !/(^|\/)_index\.md$/i.test(entry.path)) return null;

	const dir = `${entry.path.slice(0, entry.path.lastIndexOf('/'))}/files`;
	const count = h('span.page-media-count');
	const status = h('p.media-status', { role: 'status' });
	const list = h('ul.page-media-files');
	const picker = h('input', { type: 'file', multiple: true, hidden: true });
	let files = [];

	async function refresh() {
		files = (await studio.media.tree(dir)).files;
		count.textContent = files.length ? String(files.length) : '';
		list.replaceChildren(...(files.length ? files.map(tile) : [h('li.page-media-empty', t('pageFiles.empty'))]));
	}

	async function remove(file) {
		const used = await studio.media.usage(file.path);
		const question = t('media.deleteConfirm', { name: file.name });
		if (!confirm(used.length ? `${question}\n\n${t('media.usedBy', { pages: used.join(', ') })}` : question)) return;
		ws.setChanges((await studio.media.delete(file.path)).changes);
		refresh();
	}

	const tile = (file) => h('li.page-media-file', { dataset: { status: file.status ?? '' } },
		h('span.thumb-open', h('span.doc', { dataset: { ext: file.name.split('.').pop().toUpperCase() } })),
		h('span.page-media-name', { title: file.name }, h('strong', file.name), h('small', formatSize(file.size))),
		h('span.page-media-actions',
			h('button.secondary', { onclick: () => insertBlock(editor.view, `{% doclink ./files/${file.name} ${labelOf(file.name)} %}`) }, t('pageFiles.insert')),
			h('button.link.danger', { onclick: () => remove(file) }, t('media.delete'))));

	async function addFiles(incoming) {
		const picked = [...incoming];
		if (!picked.length) return;
		const problems = [];
		for (const [i, file] of picked.entries()) {
			status.textContent = t('media.adding', { current: i + 1, total: picked.length });
			const limit = maxFileSize(ws.scope.lfs ?? [], `${dir}/${file.name}`);
			if (file.size > limit) {
				problems.push(t('media.tooLarge', { name: file.name, max: Math.round(limit / 1048576) }));
				continue;
			}
			const result = await studio.media.add(dir, file.name, await prepare(file));
			ws.setChanges(result.changes);
			if (result.error) problems.push(result.error === 'tooLarge' ? t('media.tooLarge', { name: file.name, max: Math.round(limit / 1048576) }) : t('media.addFailed', { name: file.name }));
		}
		status.textContent = problems.join(' ');
		await refresh();
		panel.open = true;
	}
	picker.addEventListener('change', () => { addFiles(picker.files); picker.value = ''; });

	const panel = h('details.page-media',
		h('summary', h('span', t('pageFiles.title')), count),
		h('div.page-media-body',
			h('div.page-media-bar',
				h('button.primary', { onclick: () => picker.click() }, t('pageFiles.add')),
				h('span.page-media-help', t('pageFiles.help')),
				picker),
			status,
			list));

	// Drag files from the desktop onto the panel.
	panel.addEventListener('dragover', (event) => {
		if (![...event.dataTransfer.types].includes('Files')) return;
		event.preventDefault();
		panel.classList.add('dropping');
	});
	panel.addEventListener('dragleave', (event) => {
		if (!panel.contains(event.relatedTarget)) panel.classList.remove('dropping');
	});
	panel.addEventListener('drop', (event) => {
		event.preventDefault();
		panel.classList.remove('dropping');
		panel.open = true;
		addFiles(event.dataTransfer.files);
	});

	refresh().then(() => { panel.open = files.length > 0; });
	return panel;
}
