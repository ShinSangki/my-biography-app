import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.yourname.voicebiography',
  appName: 'Voice Biography',
  webDir: 'build',
  server: {
    cleartext: true
  }
};

export default config;
