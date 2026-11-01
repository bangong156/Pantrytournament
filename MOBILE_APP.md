# Pantry Tournament mobile rollout

## PWA

Deploy the Vite site normally. On iOS, Safari > Share > Add to Home Screen. On Android, use Install app. Supabase data requires network connectivity; only static shell files are cached.

## Capacitor

1. `npm install`
2. `npm run build`
3. `npx cap add android`
4. On macOS: `npx cap add ios`
5. `npm run cap:sync`
6. Open with `npx cap open android` or `npx cap open ios`.

Native folders are not yet generated; generate and test them on machines with Android Studio and Xcode before committing. Never commit signing credentials. Test Supabase authentication, uploads, navigation, external links, mobile layout and device back button. For stores prepare PNG icons, screenshots, privacy policy, support details, and review account deletion and app functionality requirements.
