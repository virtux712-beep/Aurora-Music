import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.aurora.music',
  appName: 'Aurora Music',
  webDir: 'www',
  server: {
    // The desktop renderer uses hash routing and absolute-root asset paths;
    // serving over https://localhost keeps fetch/module URLs behaving like
    // the desktop file:// origin closely enough for the shell validation.
    androidScheme: 'https',
  },
}

export default config
