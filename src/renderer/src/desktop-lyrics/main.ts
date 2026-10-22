import { createApp } from 'vue'
import { installCrashReporting } from '../utils/crashReporting'
import DesktopLyrics from './DesktopLyrics.vue'

/**
 * The desktop-lyrics window is a second, deliberately tiny renderer: no router, no pinia, no
 * library/source stores. It renders one component that follows a clock pushed from the main
 * process, so it cannot drift from what the app window is playing.
 */
const reportVueError = installCrashReporting()

const app = createApp(DesktopLyrics)
app.config.errorHandler = (error) => {
  reportVueError(error)
  console.error(error)
}
app.mount('#desktop-lyrics')
