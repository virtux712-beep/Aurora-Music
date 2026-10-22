import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import router from './router'
import { useUiStore } from './stores/ui'
import { installCrashReporting } from './utils/crashReporting'
import './styles/base.css'
import './styles/app.css'

// Installed before the app mounts, so a failure during startup is recorded too. Vue reports component
// errors through its own handler rather than `window.onerror`, so it is wired here as well.
const reportVueError = installCrashReporting()

const app = createApp(App)
app.config.errorHandler = (error) => {
  reportVueError(error)
  // Vue's default behaviour — log and keep going — is what we want on top of the report: one broken
  // component must not take the window down mid-song.
  console.error(error)
}
app.use(createPinia())
app.use(router)

// Theme is applied before the first paint so the window never flashes the wrong colours.
useUiStore().initTheme()

app.mount('#app')
