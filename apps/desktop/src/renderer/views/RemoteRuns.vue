<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { ProjectView, PullRequestView, QaBridge, RemoteRunView } from '../../shared/contract.ts';
import { REMOTE_STATE_LABEL, problemText } from '../format.ts';

const props = withDefaults(defineProps<{ project: ProjectView; pullRequest: PullRequestView; qa: QaBridge; refreshToken?: number; pollMs?: number }>(), { refreshToken: 0, pollMs: 15000 });

// Nothing here is remembered between openings: the list is whatever GitHub says about this pull request's runs, read
// again each time the view opens, when a run is started, and on a timer while it stays open.
const runs = ref<RemoteRunView[]>([]);
const configured = ref(true);
const loaded = ref(false);
const problem = ref('');
let timer: ReturnType<typeof setInterval> | undefined;
let latest = 0;

async function read(): Promise<void> {
  const mine = ++latest;
  try {
    const result = await props.qa.listRemoteRuns({ repository: props.project.repository, number: props.pullRequest.number });
    if (mine !== latest) return;
    if (result.ok) { runs.value = result.runs; configured.value = result.configured; problem.value = ''; loaded.value = true; }
    // The runs already shown stay, marked as not refreshed, rather than being replaced by an empty list.
    else problem.value = problemText(result.error);
  } catch {
    if (mine === latest) problem.value = 'The remote runs could not be read.';
  }
}

onMounted(() => { void read(); timer = setInterval(() => void read(), props.pollMs); });
// Leaving the view stops the polling; the runs themselves keep going on GitHub.
onBeforeUnmount(() => { latest++; if (timer !== undefined) clearInterval(timer); });
watch(() => props.refreshToken, () => void read());

const currentCandidate = computed(() => (props.pullRequest.gate.status === 'evaluated' ? props.pullRequest.gate.candidateId : undefined));
/** A run for another head or candidate says nothing about what is on screen now. */
const stale = (run: RemoteRunView): boolean => run.headSha !== props.pullRequest.headSha || run.candidateId !== currentCandidate.value;
const bad = (run: RemoteRunView): boolean => run.state === 'completed' && run.conclusion !== 'success';
</script>

<template>
  <section v-if="project.remoteRun" class="card" data-test="remote-runs">
    <h3>Linux runs on GitHub</h3>
    <p class="meta">Read from GitHub, so they are the same after closing and reopening this window. Finished means the job ended; it is not a QA result until its reports are synced and the gate accepts them.</p>
    <p v-if="problem" role="alert" class="banner warn" data-test="remote-error">Could not refresh: {{ problem }}<span v-if="runs.length > 0"> The runs below are from the last successful read.</span></p>
    <p v-if="!loaded && !problem" role="status" data-test="remote-loading">Reading runs from GitHub…</p>
    <p v-else-if="loaded && !configured" data-test="remote-not-configured">This project has not set up a Linux run workflow.</p>
    <p v-else-if="loaded && runs.length === 0" data-test="remote-none">No Linux run has been started for this pull request.</p>
    <ul v-if="runs.length > 0">
      <li v-for="run in runs" :key="run.runId" data-test="remote-run" :data-state="run.state">
        <span class="state" :class="[run.state, { bad: bad(run) }]" data-test="remote-state">{{ REMOTE_STATE_LABEL[run.state] }}<template v-if="run.conclusion"> · {{ run.conclusion }}</template></span>
        {{ run.suite }} on {{ run.profile }} · candidate {{ run.candidateId }} · head {{ run.headSha.slice(0, 7) }} · run {{ run.runId }}<span v-if="run.attempt > 1"> (attempt {{ run.attempt }})</span>
        <span v-if="stale(run)" class="tag warn" data-test="remote-stale">not the current head or candidate</span>
        <div class="meta" data-test="remote-detail">{{ run.detail }} Started {{ run.createdAt }}.</div>
      </li>
    </ul>
  </section>
</template>
