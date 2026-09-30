<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import {
  MANUAL_EVIDENCE_MAX,
  MANUAL_NOTES_MAX,
  MANUAL_OUTCOME_CHOICES,
  type EvidenceChoice,
  type ManualCheckState,
  type ManualOutcomeChoice,
  type ManualTarget,
  type ProjectView,
  type PullRequestView,
  type QaBridge,
  type RequirementView,
} from '../../shared/contract.ts';

const props = defineProps<{ project: ProjectView; pullRequest: PullRequestView; requirement: RequirementView; qa: QaBridge }>();
/** `done` is emitted when GitHub changed (an upload, a claim), so the window's data is out of date. */
const emit = defineEmits<{ close: []; done: [message: string] }>();

type Load = { kind: 'loading' } | { kind: 'failed'; message: string } | { kind: 'ready'; state: ManualCheckState };
const load = ref<Load>({ kind: 'loading' });
const notes = ref('');
const outcome = ref<ManualOutcomeChoice>('passed');
const files = ref<EvidenceChoice[]>([]);
const busy = ref(false);
const problem = ref('');
const saved = ref('');
/** Why an upload of one result failed, by run id. The result itself stays listed as not synced. */
const syncErrors = ref<Record<string, string>>({});

const target = computed<ManualTarget>(() => ({ repository: props.project.repository, number: props.pullRequest.number, headSha: props.pullRequest.headSha, requirement: props.requirement.key }));
const state = computed(() => (load.value.kind === 'ready' ? load.value.state : undefined));
const readOnly = computed(() => props.project.readOnly || state.value?.readOnly === true);

const notesHint = computed(() => (notes.value.trim() === '' ? 'Notes are required: say what you did and what you saw.' : notes.value.length > MANUAL_NOTES_MAX ? `Notes can be at most ${MANUAL_NOTES_MAX} characters.` : ''));
const evidenceHint = computed(() => (files.value.length === 0 ? 'Attach at least one evidence file.' : ''));
const blocked = computed(() => (readOnly.value ? 'Read-only access cannot record results.' : notesHint.value || evidenceHint.value));

async function reload(): Promise<void> {
  try {
    const result = await props.qa.loadManualCheck(target.value);
    load.value = result.ok ? { kind: 'ready', state: result.state } : { kind: 'failed', message: result.error };
  } catch {
    load.value = { kind: 'failed', message: 'The check could not be read.' };
  }
}
onMounted(reload);
// A different check, or a pull request that moved to a new head, is a different form: nothing typed carries over.
watch(() => [props.requirement.key, props.pullRequest.headSha], () => { notes.value = ''; files.value = []; problem.value = ''; saved.value = ''; load.value = { kind: 'loading' }; void reload(); });

async function guarded(action: () => Promise<void>, fallback: string): Promise<void> {
  busy.value = true;
  problem.value = '';
  try {
    await action();
  } catch {
    problem.value = fallback;
  } finally {
    busy.value = false;
  }
}

const choose = (): Promise<void> => guarded(async () => {
  const picked = await props.qa.pickEvidence();
  if (!picked.ok) { problem.value = picked.error; return; }
  const known = new Set(files.value.map((file) => file.token));
  files.value = [...files.value, ...picked.files.filter((file) => !known.has(file.token))].slice(0, MANUAL_EVIDENCE_MAX);
}, 'The file dialog could not be opened.');

const remove = (token: string): void => { files.value = files.value.filter((file) => file.token !== token); };

const record = (): Promise<void> => guarded(async () => {
  // Enter in the notes field submits the form even while the button is disabled, so the same rule is checked here.
  if (blocked.value !== '') { problem.value = blocked.value; return; }
  saved.value = '';
  const result = await props.qa.recordManualCheck({ ...target.value, outcome: outcome.value, notes: notes.value, evidence: files.value.map((file) => file.token) });
  if (!result.ok) { problem.value = result.error; return; }
  saved.value = result.message;
  notes.value = '';
  files.value = [];
  await reload();
}, 'The result could not be saved.');

const upload = (runId: string): Promise<void> => guarded(async () => {
  const result = await props.qa.syncManualResult({ runId });
  if (!result.ok) { syncErrors.value = { ...syncErrors.value, [runId]: result.error }; return; }
  const { [runId]: _cleared, ...rest } = syncErrors.value;
  syncErrors.value = rest;
  await reload();
  emit('done', result.message);
}, 'The upload could not be completed.');

const claim = (intent: 'claim' | 'release'): Promise<void> => guarded(async () => {
  const result = await props.qa.claimManualCheck({ ...target.value, intent });
  if (!result.ok) { problem.value = result.error; return; }
  await reload();
  emit('done', result.message);
}, 'The claim could not be recorded.');

const ownerText = computed(() => {
  const owner = state.value?.owner;
  if (owner === undefined) return 'Nobody has said they are doing this check.';
  const who = owner.mine ? 'You' : owner.actor;
  const since = `since ${owner.recordedAt}`;
  return owner.stale ? `${who} claimed this ${since}, and that claim is stale (no result in a long time). Anyone may take it over.` : `${who} ${owner.mine ? 'have' : 'has'} claimed this ${since}.`;
});
const claimLabel = computed(() => {
  const owner = state.value?.owner;
  return owner === undefined ? 'Claim this check' : `Take over from ${owner.actor}`;
});
</script>

<template>
  <section class="card" data-test="manual-check">
    <button type="button" class="link" data-test="manual-close" @click="emit('close')">← Back to the release</button>
    <h3>{{ requirement.title }}</h3>
    <p class="meta" data-test="manual-key">{{ requirement.key }}</p>

    <p v-if="load.kind === 'loading'" role="status" data-test="manual-loading">Reading the candidate and claims…</p>
    <p v-else-if="load.kind === 'failed'" role="alert" class="banner warn" data-test="manual-failed">{{ load.message }}</p>

    <template v-else-if="state">
      <p class="meta" data-test="manual-candidate">Candidate {{ state.candidateId }} · {{ project.repository }} #{{ pullRequest.number }}</p>
      <p data-test="manual-reporter">Recorded as <strong>{{ state.login }}</strong> <span class="meta">(your GitHub sign-in; it cannot be changed here)</span></p>
      <p v-if="readOnly" class="note" data-test="manual-readonly">Read-only access: you can look at this check but not claim it, record a result or upload one.</p>

      <h4>Who is doing this</h4>
      <p data-test="manual-owner" :class="{ warn: state.owner?.stale === true }">{{ ownerText }}</p>
      <p class="meta">A claim is a note for the team, not a lock: it never stops anyone from recording a result.</p>
      <div class="row">
        <button v-if="state.owner?.mine !== true" type="button" data-test="claim" :disabled="busy || readOnly" @click="claim('claim')">{{ claimLabel }}</button>
        <button v-else type="button" data-test="manual-release" :disabled="busy || readOnly" @click="claim('release')">Release</button>
      </div>

      <h4>Record a result</h4>
      <form data-test="manual-form" @submit.prevent="record">
        <fieldset :disabled="busy || readOnly">
          <legend class="meta">Outcome</legend>
          <label v-for="choice in MANUAL_OUTCOME_CHOICES" :key="choice"><input v-model="outcome" type="radio" name="outcome" :value="choice" :data-test="`outcome-${choice}`" /> {{ choice }} </label>
          <p><label>Notes (required)<br /><textarea v-model="notes" rows="5" cols="70" :maxlength="MANUAL_NOTES_MAX * 2" data-test="notes"></textarea></label></p>
          <p v-if="notesHint" class="meta" data-test="notes-hint">{{ notesHint }}</p>
          <div class="row">
            <button type="button" data-test="choose-evidence" :disabled="busy || readOnly || files.length >= MANUAL_EVIDENCE_MAX" @click="choose">Choose evidence files…</button>
          </div>
          <ul v-if="files.length > 0" data-test="evidence-list">
            <li v-for="file in files" :key="file.token" data-test="evidence-file">{{ file.name }} ({{ file.bytes }} bytes) <button type="button" class="link" :data-test="`remove-${file.name}`" @click="remove(file.token)">Remove</button></li>
          </ul>
          <p v-if="evidenceHint" class="meta" data-test="evidence-hint">{{ evidenceHint }}</p>
          <p class="meta">The files are copied into the saved result; the originals are not touched.</p>
          <button type="submit" data-test="record" :disabled="busy || blocked !== ''" :title="blocked">Save result on this computer</button>
        </fieldset>
      </form>
      <p v-if="saved" class="banner ok" role="status" data-test="manual-saved">{{ saved }}</p>
      <p v-if="problem" class="banner warn" role="alert" data-test="manual-error">{{ problem }}</p>

      <h4>Results on this computer</h4>
      <p v-if="state.results.length === 0" data-test="no-results">No result has been saved here for this check.</p>
      <ul v-else>
        <li v-for="result in state.results" :key="result.runId" data-test="manual-result">
          <strong>{{ result.outcome }}</strong> by {{ result.reporter }}, {{ result.recordedAt }}, {{ result.evidenceCount }} evidence file{{ result.evidenceCount === 1 ? '' : 's' }}
          <span v-if="result.synced" class="tag passed" data-test="synced">Synced</span>
          <span v-else class="tag warn" data-test="not-synced">Not synced</span>
          <template v-if="!result.synced">
            <span class="meta"> Only on this computer: it does not count until it is uploaded.</span>
            <button type="button" :data-test="`sync-${result.runId}`" :disabled="busy || readOnly || result.problem !== undefined" @click="upload(result.runId)">Upload to GitHub</button>
          </template>
          <p v-if="result.problem" role="alert" class="banner warn" data-test="result-problem">{{ result.problem }}</p>
          <p v-if="syncErrors[result.runId]" role="alert" class="banner warn" data-test="sync-error">Upload failed: {{ syncErrors[result.runId] }}</p>
        </li>
      </ul>
    </template>
  </section>
</template>
