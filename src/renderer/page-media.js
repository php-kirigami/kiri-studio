// The media of one Markdown page, kept in folders next to its `_index.md` (images/, videos/ …) when
// the site turns `studio.pageMedia` on. A collapsible panel above the editor: thumbnails, add (drop
// or pick), insert the right code at the cursor, delete. Every change is a draft like any other
// (see media-view.js); the main process only allows these folders for pages that exist.
import { h } from './dom.js';
import { t } from './i18n.js';
import { maxFileSize } from '../shared/lfs.js';
import { insertBlock } from './markdown-editor.js';
import { IMAGE, VIDEO, formatSize, mediaUrl, playMedia, prepare, viewImage } from './media-view.js';

const altOf = (name) => name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim();
const flat = (node) => [...node.files, ...node.folders.flatMap(flat)];

// Returns the panel, or null when this entry has none (feature off, or not a page). `pageImage`
// ({ get, set }, only with `studio.pageImage`) reads and writes the page's `@image` tag.
export function createPageMedia(ws, entry, editor, pageImage = null) {
	const names = (ws.scope.pageMedia ?? []).filter((name) => name !== 'files'); // `files` has its own panel
	if (!names.length || !/(^|\/)_index\.md$/i.test(entry.path)) return null;

	const dir = entry.path.slice(0, entry.path.lastIndexOf('/'));
	const rootOf = (name) => `${dir}/${name}`;
	// Images and videos go to the folder of that name when the site has one, else to the first.
	const folderFor = (file) => {
		const wanted = IMAGE.test(file.name) ? 'images' : VIDEO.test(file.name) ? 'videos' : null;
		return wanted && rootOf(names.includes(wanted) ? wanted : names[0]);
	};

	const count = h('span.page-media-count');
	const status = h('p.media-status', { role: 'status' });
	const list = h('ul.page-media-files');
	const picker = h('input', { type: 'file', multiple: true, hidden: true, accept: 'image/*,video/*' });
	let files = [];

	async function refresh() {
		const trees = await Promise.all(names.map((name) => studio.media.tree(rootOf(name))));
		files = trees.flatMap(flat).sort((a, b) => a.path.localeCompare(b.path));
		count.textContent = files.length ? String(files.length) : '';
		render();
	}

	const relative = (file) => file.path.slice(dir.length + 1);
	// `@image` takes a path from the site root (what og:image and <intlink> both understand).
	const sitePath = (file) => (file.path.startsWith(`${ws.scope.root}/`) ? file.path.slice(ws.scope.root.length + 1) : file.path);
	const canPick = Boolean(ws.scope.pageImage && pageImage);
	const render = () => list.replaceChildren(...(files.length ? files.map(tile) : [h('li.page-media-empty', t('pageMedia.empty'))]));
	const insert = (code) => insertBlock(editor.view, code);

	async function remove(file) {
		const used = await studio.media.usage(file.path);
		const wasPageImage = canPick && pageImage.get() === sitePath(file);
		const question = t('media.deleteConfirm', { name: file.name });
		if (!confirm(used.length ? `${question}\n\n${t('media.usedBy', { pages: used.join(', ') })}` : question)) return;
		ws.setChanges((await studio.media.delete(file.path)).changes);
		if (wasPageImage) pageImage.set(null);
		refresh();
	}

	function tile(file) {
		const isImage = IMAGE.test(file.name);
		const images = files.filter((f) => IMAGE.test(f.name));
		const isPageImage = isImage && canPick && pageImage.get() === sitePath(file);
		const thumb = isImage
			? h('button.thumb-open', {
				title: t('media.view'),
				'aria-label': `${t('media.view')}: ${file.name}`,
				onclick: () => viewImage(ws, images, images.indexOf(file)),
			}, h('img.thumb', { src: mediaUrl(file), alt: '', loading: 'lazy', draggable: 'false' }))
			: h('button.thumb-open.play', {
				title: t('media.play'),
				'aria-label': `${t('media.play')}: ${file.name}`,
				onclick: () => playMedia(ws, file),
			}, h('span.doc.playable', { dataset: { ext: file.name.split('.').pop().toUpperCase() } }));
		return h('li.page-media-file', { dataset: { status: file.status ?? '', pageImage: isPageImage ? 'true' : '' } },
			thumb,
			h('span.page-media-name', { title: file.name }, h('strong', file.name), h('small', formatSize(file.size))),
			h('span.page-media-actions',
				isImage
					? [
						canPick && h('button.secondary', {
							'aria-pressed': String(isPageImage),
							title: t('pageMedia.pageImageHelp'),
							onclick: () => { pageImage.set(isPageImage ? null : sitePath(file)); render(); },
						}, isPageImage ? t('pageMedia.pageImageOn') : t('pageMedia.pageImage')),
						h('button.secondary', { onclick: () => insert(`![${altOf(file.name)}](${relative(file)})`) }, t('pageMedia.insert')),
					]
					: [
						h('button.secondary', { onclick: () => insert(`{% inline-clip ${relative(file)} %}`) }, t('pageMedia.insertLoop')),
						h('button.secondary', { onclick: () => insert(`{% clip ${relative(file)} %}`) }, t('pageMedia.insertPlayer')),
					],
				h('button.link.danger', { onclick: () => remove(file) }, t('media.delete'))));
	}

	async function addFiles(incoming) {
		const picked = [...incoming];
		if (!picked.length) return;
		const problems = [];
		for (const [i, file] of picked.entries()) {
			status.textContent = t('media.adding', { current: i + 1, total: picked.length });
			const folder = folderFor(file);
			if (!folder) {
				problems.push(t('pageMedia.unsupported', { name: file.name }));
				continue;
			}
			const limit = maxFileSize(ws.scope.lfs ?? [], `${folder}/${file.name}`);
			if (file.size > limit) {
				problems.push(t('media.tooLarge', { name: file.name, max: Math.round(limit / 1048576) }));
				continue;
			}
			const result = await studio.media.add(folder, file.name, await prepare(file));
			ws.setChanges(result.changes);
			if (result.error) problems.push(result.error === 'tooLarge' ? t('media.tooLarge', { name: file.name, max: Math.round(limit / 1048576) }) : t('media.addFailed', { name: file.name }));
		}
		status.textContent = problems.join(' ');
		await refresh();
		panel.open = true;
	}
	picker.addEventListener('change', () => { addFiles(picker.files); picker.value = ''; });

	const panel = h('details.page-media',
		h('summary', h('span', t('pageMedia.title')), count),
		h('div.page-media-body',
			h('div.page-media-bar',
				h('button.primary', { onclick: () => picker.click() }, t('pageMedia.add')),
				h('span.page-media-help', t('pageMedia.help')),
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
	ws.smokePageMedia = addFiles;
	return panel;
}
