<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type { DashboardSnapshot, ProjectView, PullRequestView, QaBridge } from '../shared/contract.ts';
import { accountText, isEmpty, problemText } from './format.ts';
import Release from './views/Release.vue';
import Repositories from './views/Repositories.vue';

const props = defineProps<{ qa: QaBridge }>();

type State = { kind: 'loading' } | { kind: 'failed'; message: string } | { kind: 'ready'; snapshot: DashboardSnapshot };
const state = ref<State>({ kind: 'loading' });
const selected = ref<{ repository: string; number: number } | undefined>();
/** What the last action did. It stays across the refresh that follows it, until the next action or a manual refresh. */
const notice = ref('');

async function refresh(options: { quiet?: boolean } = {}): Promise<void> {
  // A refresh after an action keeps the current view on screen instead of blanking it to a loading line.
  if (options.quiet !== true) { state.value = { kind: 'loading' }; notice.value = ''; }
  try {
    state.value = { kind: 'ready', snapshot: await props.qa.loadDashboard() };
  } catch {
    state.value = { kind: 'failed', message: 'The dashboard could not read its data.' };
  }
}
onMounted(() => refresh());

async function done(message: string, refreshNeeded: boolean): Promise<void> {
  notice.value = message;
  if (refreshNeeded) await refresh({ quiet: true });
}

const snapshot = computed(() => (state.value.kind === 'ready' ? state.value.snapshot : undefined));

// The selection is looked up in each new snapshot, so a refresh that no longer has the pull request drops back to the list.
const current = computed<{ project: ProjectView; pullRequest: PullRequestView } | undefined>(() => {
  const chosen = selected.value;
  if (chosen === undefined || snapshot.value === undefined) return undefined;
  const project = snapshot.value.projects.find((item) => item.repository === chosen.repository);
  const pullRequest = project?.pullRequests.status === 'ok' ? project.pullRequests.items.find((item) => item.number === chosen.number) : undefined;
  return project !== undefined && pullRequest !== undefined ? { project, pullRequest } : undefined;
});

const open = (repository: string, number: number): void => { selected.value = { repository, number }; };
</script>

<template>
  <div class="shell">
    <header class="bar">
      <h1>Release QA</h1>
      <nav aria-label="Views">
        <button type="button" data-test="nav-repositories" :aria-current="current === undefined ? 'page' : undefined" @click="selected = undefined">Repositories</button>
        <button type="button" data-test="nav-release" :disabled="current === undefined" :aria-current="current !== undefined ? 'page' : undefined">Release</button>
      </nav>
      <span v-if="snapshot" class="account" data-test="account">{{ accountText(snapshot.account) }}</span>
      <button type="button" data-test="refresh" :disabled="state.kind === 'loading'" @click="refresh()">Refresh</button>
    </header>

    <main>
      <p v-if="state.kind === 'loading'" role="status" data-test="loading">Loading repositories and release status…</p>
      <p v-else-if="state.kind === 'failed'" role="alert" data-test="failed">{{ state.message }}</p>

      <template v-else-if="snapshot">
        <section v-if="snapshot.account.status === 'signed-out'" class="banner warn" role="alert" data-test="signed-out">
          <strong>Not signed in.</strong> {{ problemText(snapshot.account.reason) }}
        </section>
        <section v-if="snapshot.stale" class="banner warn" role="status" data-test="stale">
          <strong>Showing older data.</strong> GitHub could not be read, so this is the copy from {{ snapshot.loadedAt }}.
        </section>

        <p v-if="notice" class="banner ok" role="status" data-test="notice">{{ notice }}</p>
        <Release v-if="current" :project="current.project" :pull-request="current.pullRequest" :loaded-at="snapshot.loadedAt" :qa="qa" @back="selected = undefined" @done="done" />
        <p v-else-if="isEmpty(snapshot) && snapshot.account.status === 'signed-in'" data-test="empty">
          No projects are set up for Release QA. A repository appears here once it has a <code>qa/project.json</code> and you can read it.
        </p>
        <Repositories v-else :snapshot="snapshot" @open="open" />
      </template>
    </main>
  </div>
</template>
