<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { CheckoutView, RunEntry, RunPreviewResult, RunRequest, RunStatus, ProjectView, PullRequestView, QaBridge } from '../../shared/contract.ts';
import { ROLE_NOTE, outcomeLabel, progressText } from '../format.ts';

const props = defineProps<{ project: ProjectView; pullRequest: PullRequestView; qa: QaBridge }>();
/** Emitted when GitHub changed (results were uploaded), so the dashboard's data is out of date. */
const emit = defineEmits<{ back: []; done: [message: string] }>();

type Preview = Extract<RunPreviewResult, { ok: true }>;

const checkout = ref<CheckoutView | undefined>();
const status = ref<RunStatus>({ state: 'idle' });
const runs = ref<RunEntry[]>([]);
const runsProblem = ref('');
const preview = ref<Preview | undefined>();
const busy = ref(false);
const problem = ref('');
const notice = ref('');
/** Why each run last failed to upload. Kept beside the run until it syncs, so a failure is never a message that vanishes. */
const syncProblems = ref<Record<string, string>>({});
const syncing = ref('');

const profile = ref(props.project.profiles.includes('windows') ? 'windows' : props.project.profiles[0] ?? '');
const suite = ref(props.project.suites[0]?.id ?? '');

const candidateId = computed(() => (props.pullRequest.gate.status === 'evaluated' ? props.pullRequest.gate.candidateId : undefined));
const running = computed(() => status.value.state === 'preparing' || status.value.state === 'running');
const otherRun = computed(() => running.value && status.value.state !== 'idle' && (status.value.repository !== props.project.repository || status.value.number !== props.pullRequest.number));

const runBlock = computed(() => {
  if (props.project.readOnly) return 'Read-only access cannot run tests or upload results.';
  if (candidateId.value === undefined) return 'There is no active candidate for this pull request. Prepare one first.';
  if (checkout.value?.status !== 'ready') return 'Choose a local checkout of this repository first.';
  if (running.value) return 'A run is already under way in this app.';
  if (profile.value === '' || suite.value === '') return 'This project defines no profile or suite to run.';
  return '';
});

const target = computed(() => ({ repository: props.project.repository, number: props.pullRequest.number, headSha: props.pullRequest.headSha }));
/** A resume repeats the environment and suite the run was started with, whatever the pickers say now. */
function request(runId?: string): RunRequest {
  const run = runId === undefined ? undefined : runs.value.find((item) => item.runId === runId);
  return { ...target.value, profile: run?.profile ?? profile.value, suite: run?.suite ?? suite.value, ...(runId === undefined ? {} : { runId }) };
}

async function refreshRuns(): Promise<void> {
  if (candidateId.value === undefined) { runs.value = []; return; }
  try {
    const result = await props.qa.listRuns({ repository: props.project.repository, candidateId: candidateId.value });
    if (result.ok) { runs.value = result.runs; runsProblem.value = ''; }
    else runsProblem.value = result.error;
  } catch {
    runsProblem.value = 'The local runs could not be read.';
  }
}

let unsubscribe: (() => void) | undefined;
onMounted(async () => {
  // Subscribe first, then ask: a window opened mid-run sees the run as it is now and every change after.
  unsubscribe = props.qa.onRunStatus((next) => { status.value = next; });
  try {
    status.value = await props.qa.getRunStatus();
    checkout.value = await props.qa.getCheckout(props.project.repository);
  } catch {
    problem.value = 'The run state could not be read.';
  }
  await refreshRuns();
});
onBeforeUnmount(() => unsubscribe?.());
// When a run starts, ends or fails, what is on disk changed.
watch(() => status.value.state, () => { void refreshRuns(); });

async function chooseCheckout(): Promise<void> {
  problem.value = '';
  try { checkout.value = await props.qa.chooseCheckout(props.project.repository); }
  catch { problem.value = 'The folder could not be chosen.'; }
}

async function review(runId?: string): Promise<void> {
  busy.value = true;
  problem.value = '';
  notice.value = '';
  try {
    const result = await props.qa.previewRun(request(runId));
    if (result.ok) preview.value = result;
    else problem.value = result.error;
  } catch {
    problem.value = 'The run could not be checked.';
  } finally {
    busy.value = false;
  }
}

async function confirm(): Promise<void> {
  const shown = preview.value;
  if (shown === undefined) return;
  busy.value = true;
  problem.value = '';
  try {
    // What the person was shown goes back with the request; the privileged side refuses if any of it has changed.
    const result = await props.qa.startRun({ ...target.value, profile: shown.profile, suite: shown.suite, candidateId: shown.candidateId, root: shown.root, ...(shown.resumes === undefined ? {} : { runId: shown.resumes }) });
    if (result.ok) { preview.value = undefined; notice.value = result.message; status.value = await props.qa.getRunStatus(); }
    else problem.value = result.error;
  } catch {
    problem.value = 'The run could not be started.';
  } finally {
    busy.value = false;
  }
}

async function stop(): Promise<void> {
  try {
    const result = await props.qa.cancelRun();
    if (!result.ok) problem.value = result.error;
  } catch {
    problem.value = 'The run could not be stopped.';
  }
}

async function sync(run: RunEntry): Promise<void> {
  syncing.value = run.runId;
  notice.value = '';
  try {
    const result = await props.qa.syncRun({ ...target.value, runId: run.runId });
    if (result.ok) {
      const { [run.runId]: _cleared, ...rest } = syncProblems.value;
      syncProblems.value = rest;
      notice.value = result.message;
      emit('done', result.message);
    } else {
      syncProblems.value = { ...syncProblems.value, [run.runId]: result.error };
      // Part of an upload may have reached GitHub, so what the dashboard shows from GitHub is read again.
      if (result.uncertain) emit('done', result.error);
    }
  } catch {
    syncProblems.value = { ...syncProblems.value, [run.runId]: 'The upload could not be completed. Your local results are kept.' };
  } finally {
    syncing.value = '';
    // Whatever happened, what is unsynced is read from the run's own journal, not assumed.
    await refreshRuns();
  }
}

const syncBlock = (run: RunEntry): string => {
  if (props.project.readOnly) return 'Read-only access cannot upload results.';
  if (running.value) return 'A run is under way; sync after it finishes.';
  if (run.attempts === 0) return 'This run has recorded no result yet.';
  if (run.problem !== undefined && !run.resumable) return run.problem;
  return '';
};
const resumeBlock = (run: RunEntry): string => (runBlock.value !== '' ? runBlock.value : !run.resumable ? 'Nothing is left to run.' : '');
</script>

<template>
  <article data-test="run">
    <button type="button" class="link" data-test="run-back" @click="$emit('back')">← Back to the release</button>
    <h2>Run a suite for #{{ pullRequest.number }}</h2>
    <p class="meta">{{ project.repository }} · {{ pullRequest.headRef }} @ {{ pullRequest.headSha.slice(0, 7) }}</p>
    <p v-if="project.readOnly" class="note">{{ ROLE_NOTE }}</p>

    <section class="card" data-test="run-setup">
      <h3>Candidate</h3>
      <p v-if="candidateId" data-test="run-candidate">Active candidate <strong>{{ candidateId }}</strong>. The exact file recorded for the chosen environment is downloaded and its SHA-256 checked before anything is installed.</p>
      <p v-else data-test="run-no-candidate">There is no active candidate for this pull request. Prepare one from the release view first.</p>

      <h3>Local checkout</h3>
      <p class="meta">The scenarios and lifecycle code in this folder run on this machine. Choose a checkout you trust, at the candidate's test revision.</p>
      <p v-if="checkout === undefined" role="status">Reading the remembered checkout…</p>
      <p v-else-if="checkout.status === 'none'" data-test="checkout-none">No checkout chosen for {{ project.repository }}.</p>
      <p v-else-if="checkout.status === 'ready'" data-test="checkout-ready"><code>{{ checkout.path }}</code></p>
      <p v-else role="alert" class="banner warn" data-test="checkout-invalid"><code>{{ checkout.path }}</code>: {{ checkout.error }}</p>
      <button type="button" data-test="choose-checkout" :disabled="busy || running" @click="chooseCheckout">Choose checkout…</button>

      <h3>What to run</h3>
      <label>Environment
        <select v-model="profile" data-test="profile"><option v-for="id in project.profiles" :key="id" :value="id">{{ id }}</option></select>
      </label>
      <label>Suite
        <select v-model="suite" data-test="suite"><option v-for="item in project.suites" :key="item.id" :value="item.id">{{ item.id }}</option></select>
      </label>
      <div class="row">
        <button type="button" data-test="review-run" :disabled="busy || runBlock !== ''" :title="runBlock" @click="review()">Review and run…</button>
      </div>
      <p v-if="runBlock" class="meta" data-test="run-block">{{ runBlock }}</p>
    </section>

    <p v-if="problem" role="alert" class="banner warn" data-test="run-error">{{ problem }}</p>
    <p v-if="notice" role="status" class="banner ok" data-test="run-notice">{{ notice }}</p>

    <div v-if="preview" class="confirm" role="group" aria-label="Confirm run" data-test="confirm-run">
      <h4>{{ preview.resumes ? `Resume ${preview.resumes}?` : 'Run this suite on this machine?' }}</h4>
      <ul>
        <li data-test="confirm-candidate">Candidate <strong>{{ preview.candidateId }}</strong> (draft release {{ preview.candidateReleaseId }}), file {{ preview.artifactName }}, SHA-256 {{ preview.artifactSha256.slice(0, 12) }}…</li>
        <li data-test="confirm-target">Environment <strong>{{ preview.profile }}</strong>, suite <strong>{{ preview.suite }}</strong>: {{ preview.automated.length }} automated scenario{{ preview.automated.length === 1 ? '' : 's' }}<span v-if="preview.manual.length > 0"> ({{ preview.manual.length }} manual, not run here)</span>.</li>
        <li data-test="confirm-consequence"><strong>This installs the candidate and launches it on this computer</strong>, inside the designated test root <code>{{ preview.root }}</code>. It resets that folder before each scenario and cleans up after it, and it runs the code in <code>{{ preview.checkout }}</code>.</li>
        <li>Results are recorded on this machine only. Nothing is uploaded until you choose Sync, and nothing is published.</li>
        <li v-if="preview.resumes">Passed and failed results carry over; everything else runs again.</li>
      </ul>
      <button type="button" data-test="confirm-run-go" :disabled="busy" @click="confirm">{{ preview.resumes ? 'Resume and install' : 'Install and run' }}</button>
      <button type="button" data-test="cancel-run" :disabled="busy" @click="preview = undefined">Cancel</button>
    </div>

    <section v-if="status.state !== 'idle'" class="card" data-test="run-status" :data-state="status.state">
      <h3>{{ running ? 'Run in progress' : status.state === 'finished' ? 'Last run' : 'Last run did not complete' }}</h3>
      <p class="meta" data-test="run-status-of">{{ status.repository }} #{{ status.number }} · candidate {{ status.candidateId }} · {{ status.profile }}/{{ status.suite }}<span v-if="status.runId"> · {{ status.runId }}</span></p>
      <p v-if="otherRun" class="note" data-test="other-run">This run belongs to a different pull request.</p>
      <p :role="status.state === 'failed' ? 'alert' : 'status'" :class="{ 'banner warn': status.state === 'failed' }" data-test="run-message">{{ status.message }}<span v-if="status.stopping"> Stopping…</span></p>
      <ul v-if="status.progress.length > 0" class="progress" data-test="progress">
        <li v-for="(line, index) in status.progress.slice(-12)" :key="index" data-test="progress-line">{{ progressText(line) }}</li>
      </ul>
      <ul v-if="status.results">
        <li v-for="result in status.results" :key="result.requirement" data-test="run-result">{{ result.requirement }}: {{ outcomeLabel(result.outcome) }}</li>
      </ul>
      <button v-if="running" type="button" data-test="stop-run" :disabled="status.stopping" @click="stop">Stop</button>
    </section>

    <section class="card" data-test="local-runs">
      <h3>Runs on this machine for this candidate</h3>
      <p v-if="runsProblem" role="alert" class="banner warn" data-test="runs-error">{{ runsProblem }}</p>
      <p v-else-if="runs.length === 0" data-test="no-runs">No local run yet.</p>
      <div v-for="run in runs" :key="run.runId" data-test="local-run" :data-run="run.runId">
        <h4>{{ run.runId }} · {{ run.profile }}/{{ run.suite }}<span v-if="run.active" class="tag"> running now</span></h4>
        <p class="meta">
          Started {{ run.startedAt }}.
          <span v-if="run.attempts === 0" class="tag" data-test="sync-state">Nothing recorded yet</span>
          <span v-else-if="run.pending > 0" class="tag warn" data-test="sync-state">Not synced: {{ run.pending }} event{{ run.pending === 1 ? '' : 's' }} exist only on this machine</span>
          <span v-else class="tag passed" data-test="sync-state">Synced</span>
        </p>
        <ul><li v-for="result in run.results" :key="result.requirement" data-test="local-result">{{ result.requirement }}: {{ outcomeLabel(result.outcome) }}</li></ul>
        <p v-if="run.problem" class="meta" data-test="run-problem">{{ run.problem }}</p>
        <p v-if="syncProblems[run.runId]" role="alert" class="banner warn" data-test="sync-error">{{ syncProblems[run.runId] }}</p>
        <div class="row">
          <button type="button" data-test="resume" :disabled="busy || resumeBlock(run) !== ''" :title="resumeBlock(run)" @click="review(run.runId)">Resume…</button>
          <button type="button" data-test="sync" :disabled="syncing !== '' || syncBlock(run) !== ''" :title="syncBlock(run)" @click="sync(run)">{{ syncing === run.runId ? 'Syncing…' : 'Sync to GitHub' }}</button>
        </div>
      </div>
    </section>
  </article>
</template>
