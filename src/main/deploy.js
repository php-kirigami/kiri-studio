// After a publish: follow the workflow the commit triggers (the site's build
// and deploy) and say when the website is online, or that the build failed.
//
// A site without automation has no run to follow: after a short wait that is
// just "published". A run that was cancelled because a newer commit replaced
// it (the deploy workflow cancels in-progress runs) hands over to the newer
// one, so "online" means a run that includes this publish succeeded.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The name of the workflow step running now, if the API says (it is only shown
// as a detail, so any failure just means no name).
async function currentStep(gh, site, run) {
	try {
		const { jobs = [] } = await gh.json(`/repos/${site.fullName}/actions/runs/${run.id}/jobs`);
		for (const job of jobs) {
			const step = job.steps?.find((s) => s.status === 'in_progress');
			if (step) return step.name;
		}
	} catch { /* no detail */ }
	return null;
}

export async function watchDeploy({
	gh, site, sha, onStatus, isCancelled = () => false,
	interval = 4000, patience = 60_000, limit = 15 * 60_000, pause = sleep,
}) {
	const started = Date.now();
	let following = null; // the run being followed
	onStatus({ state: 'deploying' });

	while (Date.now() - started < limit) {
		if (isCancelled()) return;
		let runs;
		try {
			const answer = await gh.json(`/repos/${site.fullName}/actions/runs?branch=${encodeURIComponent(site.branch)}&per_page=10`);
			runs = answer.workflow_runs ?? [];
		} catch {
			// Can't read the Actions (permission, network): the publish itself is done.
			return onStatus({ state: 'published' });
		}

		// Our commit's run, else the newest run after it (which supersedes it).
		const ours = runs.find((run) => run.head_sha === sha);
		const newest = runs[0];
		let run = following && runs.find((r) => r.id === following.id) || ours;
		if (run?.status === 'completed' && run.conclusion === 'cancelled' && newest && newest.id !== run.id) run = newest;

		if (!run) {
			if (Date.now() - started > patience) return onStatus({ state: 'published' });
		} else {
			following = run;
			if (run.status !== 'completed') onStatus({ state: 'deploying', url: run.html_url, queued: run.status !== 'in_progress', step: await currentStep(gh, site, run) });
			else if (run.conclusion === 'success') return onStatus({ state: 'online', url: run.html_url });
			else if (run.conclusion !== 'cancelled') return onStatus({ state: 'deployFailed', url: run.html_url });
		}
		await pause(interval);
	}
	onStatus({ state: 'published' });
}
