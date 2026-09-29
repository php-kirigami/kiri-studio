// The live preview pane: the site as Kirigami builds it from the client's
// version, next to the editor, on the page of what they're editing. The
// served page reloads itself after each rebuild (Kirigami's dev server).
import { h } from './dom.js';
import { t } from './i18n.js';

const STORAGE_KEY = 'kiri-studio.preview';
const COLLAPSED_KEY = 'kiri-studio.preview-collapsed';

// URL path of a page: "src/about/_index.php" (root "src") → "about/",
// "src/_contact.php" → "contact.html", the home page → "".
export function pagePath(root, page) {
	if (!page) return null;
	const rel = root && root !== '.' && page.startsWith(`${root}/`) ? page.slice(root.length + 1) : page;
	const slash = rel.lastIndexOf('/');
	const dir = slash === -1 ? '' : `${rel.slice(0, slash)}/`;
	const name = rel.slice(slash + 1);
	return dir + (/^_+index\.php$/i.test(name) ? '' : name.replace(/^_+/, '').replace(/\.php$/i, '.html'));
}

function remembered() {
	try { return localStorage.getItem(STORAGE_KEY) !== 'off'; } catch { return true; }
}
function remember(on) {
	try { localStorage.setItem(STORAGE_KEY, on ? 'on' : 'off'); } catch { /* per-viewer convenience only */ }
}
// Collapsed: the pane shrinks to a thin rail on the right (the preview keeps
// running), so the editor gets the room. Separate from the top bar's toggle,
// which hides the pane altogether.
function rememberedCollapsed() {
	try { return localStorage.getItem(COLLAPSED_KEY) === 'on'; } catch { return false; }
}
function rememberCollapsed(on) {
	try { localStorage.setItem(COLLAPSED_KEY, on ? 'on' : 'off'); } catch { /* per-viewer convenience only */ }
}

export function createPreviewPane(ws, workspace) {
	let url = null;
	let page = '';
	let starting = false;

	const status = h('span.preview-status', { dataset: { state: 'idle' } });
	// The site keeps its own origin (live reload, theme storage need it). That
	// can't reach the app: the app is file://, the preview http://127.0.0.1,
	// so Chromium's "can escape its sandboxing" warning doesn't apply here.
	const frame = h('iframe.preview-frame', {
		title: t('preview.title'),
		sandbox: 'allow-scripts allow-same-origin allow-forms allow-popups',
	});
	const openInBrowser = h('button.link', { onclick: () => url && studio.openPreview(url + page) }, t('preview.openBrowser'));
	// Both buttons get their arrow from CSS (::before); the label is for
	// screen readers and the tooltip.
	const collapseButton = h('button.preview-collapse', {
		'aria-label': t('preview.collapse'),
		title: t('preview.collapse'),
		onclick: () => collapse(true),
	});
	const rail = h('button.preview-rail', {
		'aria-label': t('preview.expand'),
		title: t('preview.expand'),
		onclick: () => collapse(false),
	}, h('span.preview-rail-label', t('preview.button')));
	const pane = h('aside.preview', { 'aria-label': t('preview.title') },
		h('div.preview-head', status, h('div.spacer'), openInBrowser, collapseButton),
		frame,
		rail);
	const toggle = h('button.secondary.preview-toggle', { 'aria-pressed': 'false' }, t('preview.button'));

	const setStatus = (state, text) => {
		status.dataset.state = state;
		status.textContent = text;
	};
	const describe = (s) => {
		switch (s.state) {
			case 'preparing': return t('preview.preparing');
			case 'installing': return t('preview.installing', { done: s.done, total: s.total });
			case 'building': return t('preview.building');
			case 'ready': return t('preview.ready');
			case 'failed': return t('preview.failed');
			default: return t('preview.stopped');
		}
	};
	const go = () => { if (url) frame.src = url + page; };
	const known = ['noLockfile', 'offline', 'badLockfile', 'build', 'integrity'];
	const failure = (code) => t(`preview.error.${known.includes(code) ? code : 'other'}`);

	const stopListening = studio.preview.onStatus((s) => {
		if (s.state === 'error' && s.code) return setStatus('error', failure(s.code));
		setStatus(s.state, describe(s));
		// Restarted after a sync: same pages, new address.
		if (s.url && url && s.url !== url) {
			url = s.url;
			go();
		}
	});

	async function start() {
		if (url || starting) return;
		starting = true;
		setStatus('preparing', t('preview.preparing'));
		const result = await studio.preview.start();
		starting = false;
		if (result.url) {
			url = result.url;
			go();
		} else {
			setStatus('error', failure(result.error));
		}
	}

	function collapse(on, save = true) {
		pane.classList.toggle('collapsed', on);
		workspace.classList.toggle('preview-collapsed', on);
		rail.setAttribute('aria-expanded', String(!on));
		if (save) rememberCollapsed(on);
	}

	function show(on) {
		workspace.classList.toggle('with-preview', on);
		pane.hidden = !on;
		toggle.setAttribute('aria-pressed', String(on));
		remember(on);
		if (on) start();
	}
	toggle.addEventListener('click', () => {
		// Asking for the preview from the top bar means seeing it, not a rail.
		if (pane.hidden) collapse(false);
		show(pane.hidden);
	});

	return {
		pane,
		toggle,
		init: () => {
			collapse(rememberedCollapsed(), false);
			show(remembered());
		},
		// Shows the page an entry belongs to (content without a page keeps the current one).
		navigate(entry) {
			const next = pagePath(ws.scope.root, entry.page);
			if (next === null || next === page) return;
			page = next;
			go();
		},
		ready: () => new Promise((resolve) => {
			const check = () => (url || status.dataset.state === 'error' ? resolve() : setTimeout(check, 250));
			check();
		}),
		close: stopListening,
	};
}
