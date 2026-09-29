import { createApp } from 'vue';
import App from './App.vue';
import './style.css';

createApp(App, { load: () => window.qa.loadDashboard() }).mount('#app');
