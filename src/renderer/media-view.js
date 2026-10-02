// Image and document manager: browse folders, drop or pick files to add,
// create, rename, and delete files and folders. Every change becomes a draft
// in the main process; nothing here touches the disk.
import { h } from './dom.js';
import { t } from './i18n.js';
import { documentLink, sitePath } from '../shared/doc-link.js';
import { maxFileSize } from '../shared/lfs.js';

export const IMAGE = /\.(jpe?g|png|webp|gif|svg|avif)$/i;
const AUDIO = /\.(mp3|m4a|aac|wav|flac|ogg|oga|opus)$/i;
export const VIDEO = /\.(mp4|m4v|webm|ogv|mov)$/i;
const isPlayable = (name) => AUDIO.test(name) || VIDEO.test(name);
const RESIZABLE = /^image\/(jpeg|png|webp)$/;
const MAX_SIDE = 2560; // px: plenty for any web layout; Kirigami makes the smaller sizes

export const mediaUrl = (file) => `studio-media://site/${encodeURIComponent(file.path)}?v=${file.size}-${file.status ?? ''}`;

// Photos straight from a phone or camera are shrunk before they enter the
// site; anything already small keeps its original bytes.
export async function prepare(file) {
	if (RESIZABLE.test(file.type)) {
		const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
		const scale = MAX_SIDE / Math.max(bitmap.width, bitmap.height);
		if (scale < 1) {
			const canvas = new OffscreenCanvas(Math.round(bitmap.width * scale), Math.round(bitmap.height * scale));
			canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
			const blob = await canvas.convertToBlob({ type: file.type, quality: 0.88 });
			bitmap.close();
			return new Uint8Array(await blob.arrayBuffer());
		}
		bitmap.close();
	}
	return new Uint8Array(await file.arrayBuffer());
}

// The Markdown code that shows an image on a page, for images inside
// `image.source`: {% img-asset team/ada.png 800 %}. Null otherwise.
// php-mdhtml splits the arguments at whitespace, so a path with a space
// ("photo (1).jpeg", common for phone photos) is double-quoted, with `"`
// and `\` escaped the way its tokenizer unescapes them.
export function imageCode(scope, rel) {
	const prefix = `${scope.imageSource}/`;
	if (!rel.startsWith(prefix)) return null;
	const path = rel.slice(prefix.length);
	const arg = /[\s"'\\]/.test(path) ? `"${path.replace(/["\\]/g, '\\$&')}"` : path;
	return `{% img-asset ${arg} ${scope.imageWidth} %}`;
}

export const formatSize = (bytes) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

// Copies an image's Markdown code; the button says so for a moment.
async function copyCode(button, code) {
	await studio.copy(code);
	const label = button.textContent;
	button.textContent = t('media.copied');
	button.disabled = true;
	setTimeout(() => {
		button.textContent = label;
		button.disabled = false;
	}, 1500);
}

// Full-size viewer: ← / → browse the folder's images, Esc closes.
export function viewImage(ws, images, index) {
	let current = index;
	const img = h('img.lightbox-img', { alt: '' });
	const name = h('strong.lightbox-name');
	const meta = h('span.lightbox-meta');
	const copy = h('button.primary', t('media.copyCode'));
	const prev = h('button.lightbox-nav.prev', { 'aria-label': t('media.previous'), title: t('media.previous') });
	const next = h('button.lightbox-nav.next', { 'aria-label': t('media.next'), title: t('media.next') });
	const close = h('button.secondary', t('media.close'));
	const dialog = h('dialog.lightbox',
		h('div.lightbox-bar', h('div', name, meta), h('div.spacer'), copy, close),
		h('div.lightbox-stage', prev, img, next));

	const show = () => {
		const file = images[current];
		const code = imageCode(ws.scope, file.path);
		img.src = mediaUrl(file);
		name.textContent = file.name;
		meta.textContent = formatSize(file.size);
		img.onload = () => { meta.textContent = `${img.naturalWidth} × ${img.naturalHeight} px · ${formatSize(file.size)}`; };
		copy.hidden = !code;
		copy.onclick = () => copyCode(copy, code);
		prev.disabled = current === 0;
		next.disabled = current === images.length - 1;
	};
	const go = (step) => {
		current = Math.min(images.length - 1, Math.max(0, current + step));
		show();
	};
	prev.addEventListener('click', () => go(-1));
	next.addEventListener('click', () => go(1));
	close.addEventListener('click', () => dialog.close());
	dialog.addEventListener('keydown', (event) => {
		if (event.key === 'ArrowLeft') go(-1);
		if (event.key === 'ArrowRight') go(1);
	});
	// A click on the dark backdrop closes too.
	dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); });
	dialog.addEventListener('close', () => dialog.remove());

	document.body.append(dialog);
	show();
	dialog.showModal();
	close.focus();
	return dialog;
}

// Player for an audio or video file the client added, in the same frame as the
// image viewer. The bytes come from studio-media:, which answers Range requests,
// so the timeline can be dragged. Returns the dialog and its media element.
export function playMedia(ws, file) {
	const media = h(VIDEO.test(file.name) ? 'video.lightbox-media' : 'audio.lightbox-media',
		{ controls: true, preload: 'metadata', playsinline: true, src: mediaUrl(file) });
	const note = h('p.lightbox-note', { role: 'alert', hidden: true }, t('media.playError'));
	// A codec this app can't play: say so, instead of a dead control bar.
	media.addEventListener('error', () => { note.hidden = false; });
	const close = h('button.secondary', t('media.close'));
	const dialog = h('dialog.lightbox.lightbox-play',
		h('div.lightbox-bar', h('div', h('strong.lightbox-name', file.name), h('span.lightbox-meta', formatSize(file.size))), h('div.spacer'), close),
		h('div.lightbox-stage', media, note));
	close.addEventListener('click', () => dialog.close());
	dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); });
	dialog.addEventListener('close', () => {
		// Stop the sound and free the file before the dialog goes away.
		media.pause();
		media.removeAttribute('src');
		media.load();
		dialog.remove();
	});
	document.body.append(dialog);
	dialog.showModal();
	close.focus();
	return { dialog, media, note };
}

// Lets the client pick an image from the images folder (all subfolders).
// Resolves to its path, or null.
export async function pickImage(ws) {
	const root = ws.scope.images?.path;
	if (!root) return null;
	const tree = await studio.media.tree(root);
	const sections = [];
	const collect = (node, title) => {
		const images = node.files.filter((file) => IMAGE.test(file.name) && imageCode(ws.scope, file.path));
		if (images.length) sections.push({ title, images });
		for (const sub of node.folders) collect(sub, title ? `${title} › ${sub.name}` : sub.name);
	};
	collect(tree, '');

	return new Promise((resolve) => {
		let chosen = null;
		const dialog = h('dialog.picker',
			h('div.picker-head', h('h2', t('media.pickTitle')), h('div.spacer'),
				h('button.secondary', { onclick: () => dialog.close() }, t('common.cancel'))),
			h('p.help', t('media.pickHelp')),
			sections.length
				? sections.map((section) => [
					section.title && h('h3.picker-folder', section.title),
					h('ul.tiles.picker-tiles', section.images.map((file) => h('li.tile',
						h('button.tile-open', {
							onclick: () => {
								chosen = file.path;
								dialog.close();
							},
						}, h('img.thumb', { src: mediaUrl(file), alt: '', loading: 'lazy' }), h('span.tile-name', file.name))))),
				])
				: h('p.empty', t('media.pickNone')));
		dialog.addEventListener('close', () => {
			dialog.remove();
			resolve(chosen);
		});
		document.body.append(dialog);
		dialog.showModal();
	});
}

// A small text-input dialog (Electron has no window.prompt).
export function ask(title, value = '') {
	return new Promise((resolve) => {
		const input = h('input.field', { type: 'text', value, 'aria-label': title });
		const dialog = h('dialog.ask',
			h('form', { method: 'dialog' },
				h('h2', title),
				input,
				h('div.actions',
					h('button.primary', { value: 'ok' }, t('common.ok')),
					h('button.secondary', { value: 'cancel', formnovalidate: true }, t('common.cancel')))));
		dialog.addEventListener('close', () => {
			const answer = dialog.returnValue === 'ok' ? input.value.trim() : '';
			dialog.remove();
			resolve(answer || null);
		});
		document.body.append(dialog);
		dialog.showModal();
		input.select();
	});
}

// showMedia(ws, { root, title, kind }, folderPath) renders the manager in ws.main.
export async function showMedia(ws, media, folderPath = media.root) {
	const { main } = ws;
	const tree = await studio.media.tree(media.root);
	const find = (node, rel) => (node.path === rel ? node : node.folders.map((f) => find(f, rel)).find(Boolean));
	const folder = find(tree, folderPath) ?? tree;
	const open = (rel) => showMedia(ws, media, rel);
	const refresh = () => open(folder.path);
	const status = h('p.media-status', { role: 'status' });

	async function addFiles(list) {
		const files = [...list];
		if (!files.length) return;
		const problems = [];
		for (const [i, file] of files.entries()) {
			status.textContent = t('media.adding', { current: i + 1, total: files.length });
			// Files kept in Git LFS (PDF reports…) may be bigger than the rest.
			const limit = maxFileSize(ws.scope.lfs ?? [], `${folder.path}/${file.name}`);
			const tooLarge = () => t('media.tooLarge', { name: file.name, max: Math.round(limit / 1048576) });
			if (file.size > limit) {
				problems.push(tooLarge());
				continue;
			}
			const result = await studio.media.add(folder.path, file.name, await prepare(file));
			ws.setChanges(result.changes);
			if (result.error) problems.push(result.error === 'tooLarge' ? tooLarge() : t('media.addFailed', { name: file.name }));
		}
		await refresh();
		if (problems.length) main.querySelector('.media-status').textContent = problems.join(' ');
	}

	async function rename(item, isFolder) {
		const name = await ask(isFolder ? t('media.renameFolder') : t('media.renameFile'), item.name);
		if (!name) return;
		if (!(await confirmUsage(item.path, 'media.renameUsed'))) return;
		ws.setChanges((await studio.media.rename(item.path, name)).changes);
		refresh();
	}

	async function remove(item, isFolder) {
		const used = await studio.media.usage(item.path);
		const question = isFolder ? t('media.deleteFolderConfirm', { name: item.name }) : t('media.deleteConfirm', { name: item.name });
		if (!confirm(used.length ? `${question}\n\n${t('media.usedBy', { pages: used.join(', ') })}` : question)) return;
		ws.setChanges((await studio.media.delete(item.path)).changes);
		refresh();
	}

	async function confirmUsage(rel, key) {
		const used = await studio.media.usage(rel);
		return !used.length || confirm(t(key, { pages: used.join(', ') }));
	}

	async function newFolder() {
		const name = await ask(t('media.newFolder'));
		if (!name) return;
		const result = await studio.media.mkdir(folder.path, name);
		ws.setChanges(result.changes);
		refresh();
	}

	const menu = (item, isFolder) => {
		// What a file can copy for a page: [label key, text] pairs. Links start at the site's root; for a
		// page-relative link the client copies the name or the path and writes the rest.
		const isImage = IMAGE.test(item.name);
		const sourcePrefix = `${ws.scope.imageSource}/`;
		const copies = isFolder ? [] : isImage
			? [
				['media.copyCode', imageCode(ws.scope, item.path)],
				['media.copyImage', documentLink(ws.scope, item.path, { image: true })],
				// Under the root: its address on the site; in the image source: what {% img-asset %} takes.
				['media.copyPath', sitePath(ws.scope, item.path) ?? (item.path.startsWith(sourcePrefix) ? item.path.slice(sourcePrefix.length) : null)],
			]
			: [
				['media.copyLink', documentLink(ws.scope, item.path)],
				['media.copyName', item.name],
			];
		const buttons = copies.filter(([, text]) => text).map(([key, text]) => {
			const button = h('button.link', { onclick: () => copyCode(button, text) }, t(key));
			return button;
		});
		return h('details.tile-menu',
			h('summary', { 'aria-label': t('media.actions'), title: t('media.actions') }),
			h('div.menu',
				buttons,
				h('button.link', { onclick: () => rename(item, isFolder) }, t('media.rename')),
				h('button.link.danger', { onclick: () => remove(item, isFolder) }, t('media.delete'))));
	};
	const images = folder.files.filter((file) => IMAGE.test(file.name));

	const folderTile = (sub) => h('li.tile.folder-tile',
		h('button.tile-open', { onclick: () => open(sub.path) },
			h('span.tile-name', sub.name),
			h('span.tile-meta', t('media.items', { count: sub.files.length + sub.folders.length }))),
		menu(sub, true));

	const fileTile = (file) => h('li.tile', { dataset: { status: file.status ?? '' } },
		IMAGE.test(file.name)
			? h('button.thumb-open', {
				title: t('media.view'),
				'aria-label': `${t('media.view')}: ${file.name}`,
				onclick: () => viewImage(ws, images, images.indexOf(file)),
			}, h('img.thumb', { src: mediaUrl(file), alt: '', loading: 'lazy', draggable: 'false' }))
			: isPlayable(file.name)
				? h('button.thumb-open.play', {
					title: t('media.play'),
					'aria-label': `${t('media.play')}: ${file.name}`,
					onclick: () => playMedia(ws, file),
				}, h('span.doc.playable', { dataset: { ext: file.name.split('.').pop().toUpperCase() } }))
				: h('span.doc', { dataset: { ext: file.name.split('.').pop().toUpperCase() } }),
		h('span.tile-name', { title: file.name }, file.name),
		file.status && h('span.badge', t(`media.status.${file.status}`)),
		menu(file, false));

	// Breadcrumb: Images › team › 2026
	const crumbs = [];
	for (let node = folder; node; node = node.path === media.root ? null : find(tree, node.path.slice(0, node.path.lastIndexOf('/')))) {
		crumbs.unshift(node);
	}
	const picker = h('input', { type: 'file', multiple: true, hidden: true, accept: media.kind === 'images' ? 'image/*' : null });
	picker.addEventListener('change', () => addFiles(picker.files));

	const drop = h('div.media',
		h('div.media-head',
			h('nav.crumbs', { 'aria-label': media.title }, crumbs.map((node, i) => [
				i > 0 && h('span.crumb-sep', '›'),
				i === crumbs.length - 1
					? h('h1.crumb', i === 0 ? media.title : node.name)
					: h('button.link.crumb', { onclick: () => open(node.path) }, i === 0 ? media.title : node.name),
			])),
			h('div.spacer'),
			h('button.secondary', { onclick: newFolder }, t('media.newFolder')),
			h('button.primary', { onclick: () => picker.click() }, media.kind === 'images' ? t('media.addImages') : t('media.addFiles')),
			picker),
		h('p.help', h('span', media.kind === 'images' ? t('media.dropImages') : t('media.dropFiles'))),
		status,
		folder.folders.length + folder.files.length
			? h('ul.tiles', folder.folders.map(folderTile), folder.files.map(fileTile))
			: h('p.empty', t('ws.folderEmpty')));

	// Drag files from the desktop anywhere on the manager.
	drop.addEventListener('dragover', (event) => {
		if (![...event.dataTransfer.types].includes('Files')) return;
		event.preventDefault();
		drop.classList.add('dropping');
	});
	drop.addEventListener('dragleave', (event) => {
		if (!drop.contains(event.relatedTarget)) drop.classList.remove('dropping');
	});
	drop.addEventListener('drop', (event) => {
		event.preventDefault();
		drop.classList.remove('dropping');
		addFiles(event.dataTransfer.files);
	});

	main.replaceChildren(drop);
	// After a sync brought a new version of the site: show its files.
	const view = { synced: () => ws.view === view && refresh() };
	ws.view = view;
	ws.smokeAdd = addFiles;
	ws.smokeView = () => images.length && viewImage(ws, images, 0);
	// Smoke tests: open each audio/video file, check it loads, that a jump in the
	// timeline lands where asked (that is what needs Range requests), and that it
	// plays. Throws on the first problem. The last player stays open for the screenshot.
	const playable = folder.files.filter((file) => isPlayable(file.name));
	ws.smokePlay = async () => {
		if (!playable.length) throw new Error('no audio or video file in this folder');
		const once = (target, event) => new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`no "${event}" event`)), 15000);
			target.addEventListener(event, () => { clearTimeout(timer); resolve(); }, { once: true });
		});
		for (const file of playable) {
			const { dialog, media, note } = playMedia(ws, file);
			try {
				await once(media, 'loadedmetadata');
				if (!(media.duration > 1)) throw new Error(`duration is ${media.duration}`);
				const target = media.duration / 2;
				media.currentTime = target;
				await once(media, 'seeked');
				if (Math.abs(media.currentTime - target) > 0.5) throw new Error(`asked for ${target.toFixed(1)}s, landed on ${media.currentTime.toFixed(1)}s`);
				media.muted = true;
				await media.play();
				await new Promise((resolve) => setTimeout(resolve, 700));
				if (!(media.currentTime > target)) throw new Error('does not play');
				if (!note.hidden) throw new Error('the player reports an error');
			} catch (error) {
				throw new Error(`${file.name}: ${error.message}`);
			}
			if (file !== playable.at(-1)) dialog.close();
		}
	};
}
