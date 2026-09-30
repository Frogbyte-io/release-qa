<script setup lang="ts">
import { computed } from 'vue';
import type { ProjectView, PullRequestView, QaBridge } from '../../shared/contract.ts';
import ReleaseActions from './ReleaseActions.vue';
import { READINESS_LABEL, ROLE_NOTE, groupByEnvironment, reasonRequirement, reasonText } from '../format.ts';

const props = defineProps<{ project: ProjectView; pullRequest: PullRequestView; loadedAt: string; qa: QaBridge }>();
defineEmits<{ back: []; done: [message: string] }>();

const gate = computed(() => (props.pullRequest.gate.status === 'evaluated' ? props.pullRequest.gate : undefined));
const evaluation = computed(() => gate.value?.evaluation);
const groups = computed(() => (evaluation.value === undefined ? [] : groupByEnvironment(evaluation.value.reasons)));
const excused = computed(() => (evaluation.value === undefined ? [] : groupByEnvironment(evaluation.value.excused.map((item) => item.reason))));
const manualKeys = computed(() => new Set(props.project.requirements.filter((requirement) => requirement.mode === 'manual').map((requirement) => requirement.key)));
// Manual work is the manual requirements the evaluator still lists as blocking; nothing is inferred beyond that.
const manualWork = computed(() => (evaluation.value?.reasons ?? []).filter((reason) => manualKeys.value.has(reasonRequirement(reason) ?? '')));
</script>

<template>
  <article data-test="release">
    <button type="button" class="link" data-test="back" @click="$emit('back')">← Repositories</button>
    <h2>#{{ pullRequest.number }} {{ pullRequest.title }}</h2>
    <p class="meta">{{ project.repository }} · {{ pullRequest.headRef }} @ {{ pullRequest.headSha.slice(0, 7) }} · by {{ pullRequest.author }}<span v-if="pullRequest.draft"> · draft</span></p>
    <p v-if="project.readOnly" class="note">{{ ROLE_NOTE }}</p>
    <p class="meta" data-test="loaded-at">Last read from GitHub {{ loadedAt }}</p>
    <ReleaseActions :key="pullRequest.headSha" :project="project" :pull-request="pullRequest" :qa="qa" @done="(message) => $emit('done', message)" />

    <p v-if="pullRequest.gate.status === 'unavailable'" role="alert" data-test="gate-error">QA status is unavailable: {{ pullRequest.gate.error }}</p>

    <p v-else-if="pullRequest.releaseIntent?.length === 0" data-test="not-release">This pull request is not a release; the normal merge policy applies.</p>

    <template v-else-if="gate && evaluation">
      <p class="verdict" :class="evaluation.readiness" data-test="readiness">{{ READINESS_LABEL[evaluation.readiness] }}</p>
      <p class="meta">Release because: {{ (pullRequest.releaseIntent ?? []).join('; ') }}</p>
      <p v-if="gate.candidateId" class="meta" data-test="candidate">Candidate {{ gate.candidateId }}<span v-if="gate.candidateReleaseId"> (draft release {{ gate.candidateReleaseId }})</span></p>

      <h3>Checks by environment</h3>
      <p v-if="groups.length === 0" data-test="no-blockers">The evaluator lists nothing blocking.</p>
      <div v-for="group in groups" :key="group.environment" data-test="environment">
        <h4>{{ group.environment }}</h4>
        <ul><li v-for="(reason, index) in group.reasons" :key="index" data-test="reason">{{ reasonText(reason) }}</li></ul>
      </div>

      <template v-if="excused.length > 0">
        <h3>Waived by exception</h3>
        <div v-for="group in excused" :key="group.environment">
          <h4>{{ group.environment }}</h4>
          <ul><li v-for="(reason, index) in group.reasons" :key="index" data-test="excused">{{ reasonText(reason) }}</li></ul>
        </div>
      </template>

      <h3>Manual work</h3>
      <p v-if="manualWork.length === 0" data-test="no-manual">No manual check is waiting.</p>
      <ul v-else><li v-for="(reason, index) in manualWork" :key="index" data-test="manual">{{ reasonText(reason) }}</li></ul>

      <h3>Evidence</h3>
      <p v-if="evaluation.acceptedReportIds.length === 0" data-test="no-reports">No accepted reports yet.</p>
      <ul v-else><li v-for="id in evaluation.acceptedReportIds" :key="id" data-test="report">{{ id }}</li></ul>

      <h3>Set aside</h3>
      <p class="meta">Records the evaluator did not count, such as reports for another candidate. They stay visible.</p>
      <p v-if="evaluation.ignored.length === 0" data-test="no-ignored">Nothing was set aside.</p>
      <ul v-else><li v-for="item in evaluation.ignored" :key="`${item.kind}-${item.id}`" data-test="ignored">{{ item.kind }} {{ item.id }}: {{ item.reason }}</li></ul>
    </template>
  </article>
</template>
