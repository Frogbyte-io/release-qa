<script setup lang="ts">
import { computed, ref } from 'vue';
import { MERGE_METHODS, type ActionResult, type MergeMethod, type MergePreviewResult, type ProjectView, type PullRequestView, type QaBridge } from '../../shared/contract.ts';
import { READINESS_LABEL } from '../format.ts';

const props = defineProps<{ project: ProjectView; pullRequest: PullRequestView; qa: QaBridge }>();
/** Emitted when GitHub changed, so the window's data is out of date. */
const emit = defineEmits<{ done: [message: string]; started: [] }>();

type Preview = Extract<MergePreviewResult, { ok: true }>;
type Panel = { kind: 'prepare' } | { kind: 'run' } | { kind: 'merge'; preview: Preview };
const panel = ref<Panel | undefined>();
const busy = ref(false);
const problem = ref('');
// Only an ordinary pull request lets the person choose; a release is always merged with a merge commit (see release-actions.ts).
const method = ref<MergeMethod>('merge');

const target = computed(() => ({ repository: props.project.repository, number: props.pullRequest.number, headSha: props.pullRequest.headSha }));
const seenCandidate = computed(() => (props.pullRequest.gate.status === 'evaluated' ? props.pullRequest.gate.candidateId : undefined));
const isOrdinary = computed(() => props.pullRequest.releaseIntent?.length === 0);

const prepareBlock = computed(() => (props.project.readOnly ? 'Read-only access cannot prepare candidates.' : isOrdinary.value ? 'This pull request is not a release.' : ''));
const runOptions = computed(() => props.project.remoteRun?.options ?? []);
// The pair chosen in the confirmation; the first offered one until the person picks another.
const chosen = ref(0);
const runChoice = computed(() => runOptions.value[chosen.value] ?? runOptions.value[0]);
const runBlock = computed(() => {
  if (props.project.readOnly) return 'Read-only access cannot run suites on Linux.';
  if (props.project.remoteRun === undefined) return 'This project has not set up a Linux run workflow (workflows.run in qa/project.json).';
  if (runOptions.value.length === 0) return 'The project lists no suite that covers a Linux profile.';
  if (seenCandidate.value === undefined) return 'There is no active candidate to run; prepare one first.';
  return '';
});
const mergeBlock = computed(() => {
  if (props.project.readOnly) return 'Read-only access cannot merge.';
  const gate = props.pullRequest.gate;
  if (gate.status === 'unavailable') return 'QA status is unavailable, so it cannot be merged from here.';
  return gate.evaluation.readiness === 'blocked' ? 'QA is blocked for this pull request.' : '';
});

/** What changed between what the window showed and what GitHub says now. Empty when nothing did. */
const drift = computed(() => {
  if (panel.value?.kind !== 'merge') return '';
  const { preview } = panel.value;
  if (preview.headSha !== props.pullRequest.headSha) return `The pull request head is now ${preview.headSha.slice(0, 7)}, not the ${props.pullRequest.headSha.slice(0, 7)} you were looking at.`;
  if (preview.candidateId !== seenCandidate.value) return `The active candidate is now ${preview.candidateId ?? 'none'}, not ${seenCandidate.value ?? 'none'}.`;
  return '';
});

async function run(action: () => Promise<ActionResult>, afterStart = false): Promise<void> {
  busy.value = true;
  problem.value = '';
  try {
    const result = await action();
    if (result.ok) { panel.value = undefined; if (afterStart) emit('started'); emit('done', result.message); }
    else if (result.uncertain) { panel.value = undefined; emit('done', result.error); }
    else { problem.value = result.error; }
  } catch {
    problem.value = 'The action could not be completed.';
  } finally {
    busy.value = false;
  }
}

/** Opening the page changes nothing here, so it leaves an open confirmation and the notice alone. */
async function openPull(): Promise<void> {
  try {
    const result = await props.qa.openPullRequest(target.value);
    if (!result.ok) problem.value = result.error;
  } catch {
    problem.value = 'The pull request could not be opened.';
  }
}

async function chooseMerge(): Promise<void> {
  busy.value = true;
  problem.value = '';
  try {
    const preview = await props.qa.previewMerge(target.value);
    if (preview.ok) panel.value = { kind: 'merge', preview };
    else problem.value = preview.error;
  } catch {
    problem.value = 'The merge could not be checked.';
  } finally {
    busy.value = false;
  }
}

const confirmPrepare = (): Promise<void> => run(() => props.qa.prepareCandidate(target.value));
const confirmRun = (): Promise<void> => {
  const choice = runChoice.value;
  if (choice === undefined || seenCandidate.value === undefined) return Promise.resolve();
  return run(() => props.qa.runOnLinux({ ...target.value, candidateId: seenCandidate.value!, profile: choice.profile, suite: choice.suite }), true);
};
const confirmMerge = (): Promise<void> => run(() => props.qa.mergePullRequest({ ...target.value, method: panel.value?.kind === 'merge' && panel.value.preview.publishes ? 'merge' : method.value, ...(seenCandidate.value === undefined ? {} : { candidateId: seenCandidate.value }) }));
const cancel = (): void => { panel.value = undefined; problem.value = ''; };
</script>

<template>
  <section class="card" data-test="actions">
    <h3>Actions</h3>
    <div class="row">
      <button type="button" data-test="prepare" :disabled="busy || prepareBlock !== ''" :title="prepareBlock" @click="panel = { kind: 'prepare' }">Prepare candidate</button>
      <button type="button" data-test="run-linux" :disabled="busy || runBlock !== ''" :title="runBlock" @click="panel = { kind: 'run' }">Run on Linux…</button>
      <button type="button" data-test="merge" :disabled="busy || mergeBlock !== ''" :title="mergeBlock" @click="chooseMerge">Merge…</button>
      <button type="button" data-test="open-pr" :disabled="busy" @click="openPull">Open pull request on GitHub</button>
    </div>
    <p v-if="prepareBlock" class="meta" data-test="prepare-block">{{ prepareBlock }}</p>
    <p v-if="runBlock" class="meta" data-test="run-block">{{ runBlock }}</p>
    <p v-if="mergeBlock" class="meta" data-test="merge-block">{{ mergeBlock }}</p>
    <p v-if="problem" role="alert" class="banner warn" data-test="action-error">{{ problem }}</p>

    <div v-if="panel?.kind === 'prepare'" class="confirm" role="group" aria-label="Confirm candidate preparation" data-test="confirm-prepare">
      <h4>Prepare a candidate for #{{ pullRequest.number }}?</h4>
      <ul>
        <li>Starts the trusted <code>qa-prepare</code> workflow from {{ project.repository }}'s default branch, building the exact head {{ pullRequest.headSha.slice(0, 7) }}.</li>
        <li>The result becomes the active candidate. Results recorded for {{ seenCandidate ? `candidate ${seenCandidate}` : 'an earlier candidate' }} will no longer count towards it.</li>
        <li>Nothing is installed or published by this step.</li>
      </ul>
      <button type="button" data-test="confirm-prepare-go" :disabled="busy" @click="confirmPrepare">Start preparation</button>
      <button type="button" data-test="cancel" :disabled="busy" @click="cancel">Cancel</button>
    </div>

    <div v-if="panel?.kind === 'run' && runChoice" class="confirm" role="group" aria-label="Confirm Linux run" data-test="confirm-run">
      <h4>Run a suite on Linux for #{{ pullRequest.number }}?</h4>
      <label v-if="runOptions.length > 1">Suite and profile
        <select v-model="chosen" data-test="run-choice"><option v-for="(option, index) in runOptions" :key="index" :value="index">{{ option.suite }} on {{ option.profile }}</option></select>
      </label>
      <ul>
        <li data-test="run-subject">Candidate {{ seenCandidate }}, profile {{ runChoice.profile }}, suite {{ runChoice.suite }}, exact head {{ pullRequest.headSha.slice(0, 7) }}.</li>
        <li>Starts the trusted <code>{{ project.remoteRun?.workflow }}</code> workflow from {{ project.repository }}'s default branch. It runs on a GitHub Linux runner, not on this computer, and keeps running if you close this window.</li>
        <li>It uses GitHub Actions minutes for {{ project.repository }}. Its results count only after they have been synced to the candidate and accepted by the gate.</li>
        <li>Nothing is installed on this computer and nothing is published.</li>
      </ul>
      <button type="button" data-test="confirm-run-go" :disabled="busy" @click="confirmRun">Start run</button>
      <button type="button" data-test="cancel" :disabled="busy" @click="cancel">Cancel</button>
    </div>

    <div v-if="panel?.kind === 'merge'" class="confirm" role="group" aria-label="Confirm merge" data-test="confirm-merge">
      <h4>Merge #{{ pullRequest.number }} into {{ panel.preview.baseRef }}?</h4>
      <ul>
        <li data-test="merge-state">QA: {{ READINESS_LABEL[panel.preview.readiness] }} at head {{ panel.preview.headSha.slice(0, 7) }}<span v-if="panel.preview.candidateId">, candidate {{ panel.preview.candidateId }}</span>.</li>
        <li v-if="panel.preview.publishes" data-test="merge-publishes"><strong>This authorizes publication.</strong> The exact binaries tested in this candidate are published as the release; they are not rebuilt. The release notes as they are now are saved with the candidate first, and the merge uses a merge commit so the merged code is the tested code.</li>
        <li v-else data-test="merge-plain">This is not a release, so merging follows the normal merge policy and publishes nothing.</li>
        <li>GitHub is told the head you reviewed, and refuses the merge if anyone has pushed since.</li>
      </ul>
      <p v-if="drift" role="alert" class="banner warn" data-test="drift">{{ drift }} Nothing was merged; refresh and review it again.</p>
      <label v-if="!panel.preview.publishes">Method
        <select v-model="method" data-test="method"><option v-for="option in MERGE_METHODS" :key="option" :value="option">{{ option }}</option></select>
      </label>
      <button type="button" data-test="confirm-merge-go" :disabled="busy || drift !== '' || panel.preview.readiness === 'blocked'" @click="confirmMerge">Merge</button>
      <button type="button" data-test="cancel" :disabled="busy" @click="cancel">Cancel</button>
    </div>
  </section>
</template>
