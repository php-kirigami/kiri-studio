import assert from 'node:assert/strict';
import test from 'node:test';
import { watchDeploy } from '../src/main/deploy.js';

const SITE = { fullName: 'acme/bakery', branch: 'main' };

// A GitHub whose run list is the given snapshots, one per poll (the last repeats).
function runsAnswering(snapshots) {
	let i = 0;
	return {
		async json(path) {
			if (path.endsWith('/jobs')) return { jobs: [{ steps: [{ name: 'Build the site', status: 'in_progress' }] }] };
			return { workflow_runs: snapshots[Math.min(i++, snapshots.length - 1)] };
		},
	};
}
const run = (id, sha, status, conclusion = null) => ({ id, head_sha: sha, status, conclusion, html_url: `https://github.com/run/${id}` });

async function states(gh, options = {}) {
	const seen = [];
	await watchDeploy({ gh, site: SITE, sha: 'abc', onStatus: (s) => seen.push(s.state), pause: async () => {}, ...options });
	return seen;
}

test('follows the run of the published commit until the site is online', async () => {
	const gh = runsAnswering([[], [run(1, 'abc', 'queued')], [run(1, 'abc', 'in_progress')], [run(1, 'abc', 'completed', 'success')]]);
	assert.deepEqual(await states(gh), ['deploying', 'deploying', 'deploying', 'online']);
});

test('says whether the run is queued and which step is running', async () => {
	const seen = [];
	const gh = runsAnswering([[run(1, 'abc', 'queued')], [run(1, 'abc', 'in_progress')], [run(1, 'abc', 'completed', 'success')]]);
	await watchDeploy({ gh, site: SITE, sha: 'abc', onStatus: (s) => seen.push(s), pause: async () => {} });
	assert.equal(seen[1].queued, true);
	assert.equal(seen[2].queued, false);
	assert.equal(seen[2].step, 'Build the site');
});

test('a failed build is reported with its address', async () => {
	const seen = [];
	await watchDeploy({
		gh: runsAnswering([[run(2, 'abc', 'completed', 'failure')]]), site: SITE, sha: 'abc',
		onStatus: (s) => seen.push(s), pause: async () => {},
	});
	assert.deepEqual(seen.at(-1), { state: 'deployFailed', url: 'https://github.com/run/2' });
});

test('a run cancelled by a newer commit hands over to the newer run', async () => {
	const gh = runsAnswering([
		[run(1, 'abc', 'completed', 'cancelled')],
		[run(2, 'def', 'in_progress'), run(1, 'abc', 'completed', 'cancelled')],
		[run(2, 'def', 'completed', 'success'), run(1, 'abc', 'completed', 'cancelled')],
	]);
	assert.equal((await states(gh)).at(-1), 'online');
});

test('a site without a workflow is simply published, and unreadable Actions too', async () => {
	assert.equal((await states(runsAnswering([[]]), { patience: -1 })).at(-1), 'published');
	const denied = { async json() { throw Object.assign(new Error('no'), { status: 403 }); } };
	assert.equal((await states(denied)).at(-1), 'published');
});
