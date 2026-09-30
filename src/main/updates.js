// App updates, silent: check at startup and every few hours, download in the
// background, install when the app quits. The next launch is the new version;
// the client can also restart right away from the status line. Feeds from GitHub Releases on
// php-kirigami/kiri-studio (see "publish" in electron-builder.yml).
//
// Only where an update can install itself without help:
// - Windows (NSIS, per-user install, no admin prompt);
// - Linux AppImage (a .deb updates through the system's package manager);
// - not macOS yet: Squirrel.Mac rejects an update that isn't signed, and the
//   builds aren't until the Apple Developer ID is in place.
import { app } from 'electron';
import updater from 'electron-updater';

const EVERY = 4 * 60 * 60 * 1000;

export function canSelfUpdate() {
	if (!app.isPackaged || process.env.KIRI_STUDIO_NO_UPDATES) return false;
	if (process.platform === 'win32') return true;
	if (process.platform === 'linux') return !!process.env.APPIMAGE;
	return false;
}

// onStatus gets { state: 'downloading', version, percent }, then
// { state: 'ready', version }, or null when a download failed (it is tried
// again at the next check). The client sees it as one line, never a question.
// Closes the app and starts the downloaded version (only once it is ready).
export function installUpdate() {
	if (canSelfUpdate()) updater.autoUpdater.quitAndInstall(false, true);
}

export function startUpdates(onStatus = () => {}) {
	if (!canSelfUpdate()) return;
	const { autoUpdater } = updater;
	autoUpdater.autoDownload = true;
	autoUpdater.autoInstallOnAppQuit = true;
	autoUpdater.logger = console;
	let version = null;
	let ready = false;
	autoUpdater.on('update-available', (info) => {
		version = info.version;
		if (!ready) onStatus({ state: 'downloading', version, percent: 0 });
	});
	autoUpdater.on('download-progress', (progress) => {
		if (!ready) onStatus({ state: 'downloading', version, percent: Math.floor(progress.percent) });
	});
	autoUpdater.on('update-downloaded', (info) => {
		ready = true;
		onStatus({ state: 'ready', version: info.version });
	});
	// Offline or GitHub out of reach: try again next time, say nothing.
	autoUpdater.on('error', (error) => {
		console.warn(`Kiri Studio: update check failed: ${error.message}`);
		if (!ready) onStatus(null);
	});
	const check = () => autoUpdater.checkForUpdates().catch(() => {});
	check();
	setInterval(check, EVERY).unref();
}
