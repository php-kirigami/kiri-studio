// GitHub sign-in through the Kiri Studio GitHub App's device flow. Only the
// App's public client ID is needed: no secret ships with the app. The App has
// token expiration turned off, so a token lasts until the user revokes it and
// there is nothing to refresh. The token is encrypted at rest with Electron's
// safeStorage (DPAPI / Keychain / libsecret).
import fs from 'node:fs';
import path from 'node:path';
import { safeStorage } from 'electron';

export const CLIENT_ID = 'Iv23lioowQVMtYGG2LsY';

const form = (fields) => ({
	method: 'POST',
	headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
	body: new URLSearchParams({ client_id: CLIENT_ID, ...fields }),
});

// Step 1: ask GitHub for a user code. Returns { deviceCode, userCode,
// verificationUri, expiresIn, interval }.
export async function requestDeviceCode() {
	const res = await fetch('https://github.com/login/device/code', form({}));
	const body = await res.json();
	if (!body.user_code) throw new Error(body.error_description || body.error || 'GitHub refused the sign-in request.');
	return {
		deviceCode: body.device_code,
		userCode: body.user_code,
		verificationUri: body.verification_uri,
		expiresIn: body.expires_in,
		interval: body.interval,
	};
}

// Step 2: poll until the user approves. Resolves to the token; rejects with an
// Error whose `code` is 'expired' or 'denied' when the attempt is over.
// `signal` (an AbortSignal) stops polling when a new attempt replaces this one.
export async function pollForToken({ deviceCode, interval }, signal) {
	let wait = interval;
	for (;;) {
		await new Promise((resolve) => setTimeout(resolve, wait * 1000));
		if (signal?.aborted) throw Object.assign(new Error('Sign-in cancelled.'), { code: 'cancelled' });
		const body = await (await fetch('https://github.com/login/oauth/access_token', form({
			device_code: deviceCode,
			grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
		}))).json();
		if (body.access_token) return body.access_token;
		if (body.error === 'authorization_pending') continue;
		if (body.error === 'slow_down') { wait = body.interval ?? wait + 5; continue; }
		const code = body.error === 'expired_token' ? 'expired' : body.error === 'access_denied' ? 'denied' : body.error;
		throw Object.assign(new Error(body.error_description || body.error), { code });
	}
}

export function createTokenStore(userData) {
	const file = path.join(userData, 'auth.bin');
	return {
		load() {
			// Development and smoke tests: a token from the environment, never saved.
			if (process.env.KIRI_STUDIO_TOKEN) return process.env.KIRI_STUDIO_TOKEN;
			if (!fs.existsSync(file)) return null;
			const buf = fs.readFileSync(file);
			try {
				return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(buf) : buf.toString('utf8');
			} catch {
				return null; // unreadable (e.g. keychain changed): sign in again
			}
		},
		save(token) {
			fs.mkdirSync(userData, { recursive: true });
			const data = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(token) : Buffer.from(token, 'utf8');
			fs.writeFileSync(file, data, { mode: 0o600 });
		},
		clear() {
			fs.rmSync(file, { force: true });
		},
	};
}
