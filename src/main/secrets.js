// Keys a site's build scripts need in the preview (`studio.secrets` in
// kirigami.yaml: a geocoding key, say). The client types them once; they stay
// on this computer, encrypted like the GitHub token, and are written into the
// preview copy as a small YAML file the scripts read. Never published, never
// in the synced copy.
//
// <siteDir>/secrets.bin   encrypted JSON { [name]: value }
import fs from 'node:fs';
import path from 'node:path';
import * as yaml from 'yaml';

// `crypt`: Electron's safeStorage in the app; injectable for tests.
export function createSecrets(siteDir, crypt) {
	const file = path.join(siteDir, 'secrets.bin');
	const encrypting = () => crypt?.isEncryptionAvailable?.() === true;

	function read() {
		if (!fs.existsSync(file)) return {};
		const buf = fs.readFileSync(file);
		try {
			const values = JSON.parse(encrypting() ? crypt.decryptString(buf) : buf.toString('utf8'));
			return values && typeof values === 'object' ? values : {};
		} catch {
			return {}; // unreadable (keychain changed): the client types them again
		}
	}

	function write(values) {
		fs.mkdirSync(siteDir, { recursive: true });
		const text = JSON.stringify(values);
		fs.writeFileSync(file, encrypting() ? crypt.encryptString(text) : Buffer.from(text, 'utf8'), { mode: 0o600 });
	}

	return {
		// What the site asks for, and whether each one is filled in. Never the values.
		list(spec) {
			const values = read();
			return (spec?.keys ?? []).map(({ name, label }) => ({ name, label, set: typeof values[name] === 'string' && values[name] !== '' }));
		},

		// An empty value removes the key.
		set(spec, name, value) {
			if (!spec?.keys.some((key) => key.name === name)) throw new Error('Unknown key.');
			const values = read();
			if (typeof value === 'string' && value.trim()) values[name] = value.trim();
			else delete values[name];
			write(values);
		},

		// The file a preview copy gets: { rel, text }, or null when nothing is set.
		file(spec) {
			if (!spec) return null;
			const values = read();
			const known = Object.fromEntries(spec.keys.filter(({ name }) => values[name]).map(({ name }) => [name, values[name]]));
			return Object.keys(known).length ? { rel: spec.file, text: yaml.stringify(known) } : null;
		},
	};
}
