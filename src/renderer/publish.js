// The Publish button and the line of the status bar that follows a publish:
// sending the files, saving, and waiting for the website to rebuild.
import { h } from './dom.js';
import { t } from './i18n.js';

const ERRORS = ['offline', 'signedOut', 'noAccess', 'busy', 'lfs', 'notAvailable'];
const CLEAR_AFTER = 60_000;

// `apply(result)`: shows what a publish changed (the same refresh a sync
// that brought a new version does).
export function createPublisher({ ws, layout, siteName, apply }) {
	const button = layout.querySelector('.topbar .publish');
	const line = h('span.publish-line', { role: 'status' });
	layout.querySelector('.statusbar .app-news').after(line);

	let busy = false;
	let clearTimer = null;

	// While working: "(step/3) what is happening · elapsed time".
	let startedAt = 0;
	let ticker = null;
	let current = null;
	const elapsed = () => {
		const seconds = Math.floor((Date.now() - startedAt) / 1000);
		return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
	};
	const stopTicker = () => { clearInterval(ticker); ticker = null; };

	const render = () => {
		const { text, state, href, step } = current;
		const parts = [step ? `(${step}/3) ${text}` : text];
		if (state === 'working') parts.push(` · ${elapsed()}`);
		line.replaceChildren(...parts, ...(href ? [' ', h('a', { href, target: '_blank' }, t('publish.details'))] : []));
	};

	const say = (text, state = '', href = null, step = 0) => {
		clearTimeout(clearTimer);
		line.dataset.state = state;
		current = { text, state, href, step };
		if (state === 'working') {
			if (!ticker) { startedAt = Date.now(); ticker = setInterval(render, 1000); }
		} else {
			stopTicker();
		}
		render();
		if (state === 'done') clearTimer = setTimeout(() => line.replaceChildren(), CLEAR_AFTER);
	};

	const refresh = () => {
		button.disabled = busy || ws.changes.size === 0;
		button.textContent = busy ? t('publish.busy') : t('ws.publish');
		button.title = busy ? '' : ws.changes.size ? '' : t('publish.nothing');
	};
	ws.onChanges = refresh;
	refresh();

	const stopListening = studio.publish.onStatus((status) => {
		if (status.site !== siteName) return;
		switch (status.state) {
			case 'checking': return say(t('publish.checking'), 'working', null, 1);
			case 'uploading': return say(t('publish.uploading', { done: status.done, total: status.total }), 'working', null, 1);
			case 'committing': return say(t('publish.committing'), 'working', null, 2);
			case 'deploying': {
				const what = status.queued ? t('publish.queued') : status.step ? t('publish.building', { step: status.step }) : t('publish.deploying');
				return say(what, 'working', status.url ?? null, 3);
			}
			case 'online': return say(t('publish.online'), 'done');
			case 'published': return say(t('publish.published'), 'done');
			case 'deployFailed': return say(t('publish.deployFailed'), 'error', status.url);
			default:
		}
	});

	button.addEventListener('click', async () => {
		if (busy || ws.changes.size === 0) return;
		if (!confirm(t('publish.confirm'))) return;
		busy = true;
		refresh();
		say(t('publish.checking'), 'working', null, 1);
		try {
			// What is being typed reaches the drafts before they are published.
			await ws.view?.flush?.();
			const result = await studio.publish.run();
			busy = false;
			if (result.error) {
				ws.setChanges(result.changes);
				say(t(`publish.error.${ERRORS.includes(result.error) ? result.error : 'other'}`), 'error');
			} else {
				await apply(result);
				if (!result.published) say(t('publish.nothing'), 'done');
			}
		} finally {
			busy = false;
			refresh();
		}
	});

	return { close: () => { stopListening(); stopTicker(); clearTimeout(clearTimer); } };
}
