import type { CapacitorConfig } from '@capacitor/cli';

// Remote-URL shell: the Android app is a thin WebView wrapper that loads the LIVE
// ceres.prominentdental.com — the same PWA everyone already uses in a browser tab. Ordinary
// web deploys (Railway) update the app instantly for every installed user; an APK rebuild /
// reinstall is only needed when something in the NATIVE shell itself changes (this config,
// the Android project under android/, or a plugin version — see the ceres-android.yml
// workflow and PhotoListUpload's nativeScanner.ts bridge).
const config: CapacitorConfig = {
  appId: 'com.prominentdental.ceres',
  appName: 'Ceres',
  webDir: 'dist',
  server: {
    url: 'https://ceres.prominentdental.com',
    androidScheme: 'https',
    // Without this, ANY top-level navigation off the server.url host is kicked out to the
    // system browser — which is exactly what the portal-SSO login redirect
    // (pantheon.prominentdental.com) does on first open. Allow the whole suite so SSO
    // round-trips and AppSwitcher hops (juno/apollo/...) all stay inside the app's WebView.
    allowNavigation: ['*.prominentdental.com'],
  },
};

export default config;
