<script setup lang="ts">
import type { DashboardSnapshot } from '../../shared/contract.ts';
import { READINESS_LABEL, ROLE_NOTE, problemText } from '../format.ts';

defineProps<{ snapshot: DashboardSnapshot }>();
defineEmits<{ open: [repository: string, number: number] }>();
</script>

<template>
  <div>
    <section v-for="project in snapshot.projects" :key="project.repository" class="card" :data-test="`project-${project.repository}`">
      <h2>{{ project.repository }}</h2>
      <p class="meta">
        {{ project.projectId }} · release branch {{ project.releaseBranch }} · environments {{ project.profiles.join(', ') }} · role {{ project.role }}
        <span v-if="project.readOnly" class="tag" data-test="read-only">Read-only</span>
      </p>
      <p v-if="project.readOnly" class="note">{{ ROLE_NOTE }}</p>

      <h3>Pull requests</h3>
      <p v-if="project.pullRequests.status === 'unavailable'" role="alert" data-test="pulls-unavailable">Pull requests could not be read: {{ problemText(project.pullRequests.reason) }}</p>
      <p v-else-if="project.pullRequests.items.length === 0">No open pull requests.</p>
      <ul v-else>
        <li v-for="pull in project.pullRequests.items" :key="pull.number">
          <button type="button" class="link" :data-test="`open-${project.repository}-${pull.number}`" @click="$emit('open', project.repository, pull.number)">#{{ pull.number }} {{ pull.title }}</button>
          <span class="meta"> by {{ pull.author }}</span>
          <span v-if="pull.releaseIntent.length === 0" class="tag">Not a release</span>
          <span v-else-if="pull.gate.status === 'evaluated'" class="tag" :class="pull.gate.evaluation.readiness" data-test="readiness">{{ READINESS_LABEL[pull.gate.evaluation.readiness] }}</span>
          <span v-else class="tag warn" data-test="gate-unavailable">Status unavailable</span>
        </li>
      </ul>

      <h3>Published history</h3>
      <p v-if="project.history.status === 'unavailable'" role="alert">History could not be read: {{ problemText(project.history.reason) }}</p>
      <p v-else-if="project.history.releases.length === 0">No published releases.</p>
      <ul v-else>
        <li v-for="release in project.history.releases" :key="release.tag">
          {{ release.name }} <span class="meta">{{ release.publishedAt }}</span>
          <span v-if="release.qa === 'missing'" class="tag warn" data-test="history-missing">No QA record</span>
          <span v-else class="tag passed">QA recorded</span>
        </li>
      </ul>
    </section>

    <section v-if="snapshot.problems.length > 0" class="card" data-test="problems">
      <h2>Not available</h2>
      <p class="meta">These could not be read. The others above are unaffected.</p>
      <ul>
        <li v-for="problem in snapshot.problems" :key="problem.repository" data-test="problem">
          <strong>{{ problem.repository === '*' ? 'GitHub' : problem.repository }}</strong>: {{ problemText(problem.reason) }}
        </li>
      </ul>
    </section>
  </div>
</template>
