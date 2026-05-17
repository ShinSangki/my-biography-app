import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.yourname.voicebiography',
  appName: 'Voice Biography',
  webDir: 'build',
  // 실제 배포(HTTPS 서버 통신) 시에는 cleartext 허용 옵션을 제거하거나 주석 처리합니다.
  // server: {
  //   cleartext: true
  // }
};

export default config;
