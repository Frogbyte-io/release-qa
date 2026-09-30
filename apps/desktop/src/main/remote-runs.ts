import { discoverProjects, dispatchSuiteRun, evaluatePullRequest, inspectGitHubAccess, listSuiteRuns } from '@frogbyte-io/release-qa';
import type { ActionResult, RemoteRunRequest, RemoteRunsResult } from '../shared/contract.ts';
import { accessText, parsePullRef, parseTarget, refusal, requireWrite, type ActionDeps } from './release-actions.ts';

/** The seams a test replaces; the shared package's own functions are the defaults. */
export interface RemoteRunDeps extends ActionDeps {
  dispatchRun?: typeof dispatchSuiteRun;
  listRuns?: typeof listSuiteRuns;
  discover?: typeof discoverProjects;
  now?: () => Date;
}

const idPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Everything from the window is checked here, as if it came from anywhere: shape, then meaning. */
export function parseRemoteRunRequest(value: unknown): RemoteRunRequest | undefined {
  const target = parseTarget(value);
  if (target === undefined) return undefined;
  const { candidateId, profile, suite } = value as Record<string, unknown>;
  if (typeof candidateId !== 'string' || typeof profile !== 'string' || typeof suite !== 'string') return undefined;
  if (![candidateId, profile, suite].every((id) => idPattern.test(id))) return undefined;
  return { ...target, candidateId, profile, suite };
}

/** The project's declared run workflow and the Linux (profile, suite) pairs it offers, read from the default branch as data. */
async function runWorkflowOf(repository: string, deps: RemoteRunDeps): Promise<{ ok: true; workflow?: string; options: Array<{ profile: string; suite: string }> } | { ok: false; error: string }> {
  const found = await (deps.discover ?? discoverProjects)(deps.api, `https://github.com/${repository}`);
  const project = found.projects.find((item) => item.repository.toLowerCase() === repository.toLowerCase())?.project;
  if (project === undefined) return refusal(found.problems[0] === undefined ? 'This repository has no readable qa/project.json.' : `The project file could not be read: ${accessText(found.problems[0].reason)}`);
  const linux = project.profiles.filter((profile) => profile.os === 'linux').map((profile) => profile.id);
  const options = project.suites.flatMap((suite) => linux.filter((profile) => suite.requirements.some((key) => key.startsWith(`${profile}/`))).map((profile) => ({ profile, suite: suite.id })));
  return { ok: true, ...(project.workflows.run === undefined ? {} : { workflow: project.workflows.run }), options };
}

/**
 * Starts the consumer's Linux run workflow from the default branch for the head and candidate the person reviewed. The
 * gate is evaluated again first: the head must be unchanged and the candidate still the active one, and the profile and
 * suite must be a Linux pair the project's own `qa/project.json` offers. The run continues on GitHub whether or not this
 * app stays open; nothing is recorded locally.
 */
export async function runOnLinux(input: unknown, deps: RemoteRunDeps): Promise<ActionResult> {
  const request = parseRemoteRunRequest(input);
  if (request === undefined) return refusal('That is not a valid run request.');
  const allowed = await requireWrite(request.repository, deps.api);
  if (!allowed.ok) return allowed;
  const project = await runWorkflowOf(request.repository, deps);
  if (!project.ok) return project;
  if (project.workflow === undefined) return refusal('This project does not declare a Linux run workflow (workflows.run in qa/project.json).');
  if (!project.options.some((option) => option.profile === request.profile && option.suite === request.suite)) {
    return refusal(`The project offers no Linux run of suite "${request.suite}" for profile "${request.profile}".`);
  }
  const evaluated = await (deps.evaluate ?? evaluatePullRequest)(request.repository, request.number, deps.api, request.headSha);
  if (!evaluated.ok) return refusal(`Not started: ${evaluated.error}`);
  if (evaluated.value.candidateId !== request.candidateId) {
    return refusal(`Not started: the active candidate is now ${evaluated.value.candidateId ?? 'none'}, not the ${request.candidateId} you were looking at. Refresh and look again.`);
  }
  const dispatched = await (deps.dispatchRun ?? dispatchSuiteRun)(request.repository, project.workflow, {
    prNumber: request.number, candidateId: request.candidateId, profile: request.profile, suite: request.suite, expectedHead: request.headSha,
  }, deps.api);
  if (!dispatched.ok) {
    return refusal(dispatched.runId === undefined ? dispatched.error : `${dispatched.error} (workflow run ${dispatched.runId} was already started; check it before trying again)`);
  }
  return { ok: true, message: `Started ${request.suite} on Linux (${request.profile}) for ${request.headSha.slice(0, 7)} (workflow run ${dispatched.runId}). It keeps running on GitHub if you close this window; reopen it to see where it is.` };
}

/** Reads this pull request's remote runs from GitHub. Anything that stops the read (sign-in, access, network) is an error, never an empty list. */
export async function listRemoteRuns(input: unknown, deps: RemoteRunDeps): Promise<RemoteRunsResult> {
  const target = parsePullRef(input);
  if (target === undefined) return refusal('That is not a valid pull request.');
  const access = await inspectGitHubAccess(target.repository, deps.api);
  if (!access.ok) return refusal(accessText(access.reason));
  const project = await runWorkflowOf(target.repository, deps);
  if (!project.ok) return project;
  if (project.workflow === undefined) return { ok: true, configured: false, runs: [] };
  const listed = await (deps.listRuns ?? listSuiteRuns)(target.repository, project.workflow, target.number, deps.api, (deps.now ?? (() => new Date()))());
  if (!listed.ok) return refusal(accessText(listed.error));
  return {
    ok: true,
    configured: true,
    runs: listed.runs.map((run) => ({
      runId: run.runId, attempt: run.attempt, url: run.url, createdAt: run.createdAt, candidateId: run.candidateId, profile: run.profile, suite: run.suite,
      headSha: run.expectedHead, state: run.status.state, ...(run.status.conclusion === undefined ? {} : { conclusion: run.status.conclusion }), detail: run.status.detail,
    })),
  };
}
