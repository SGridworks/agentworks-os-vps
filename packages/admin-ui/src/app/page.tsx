import { redirect } from 'next/navigation';

const ONBOARDING_KEY = 'aw_onboarding_state';

export const dynamic = 'force-dynamic';

export default function RootPage() {
  // This runs server-side; client-side redirect is handled by the onboarding
  // redirect flow via useEffect in the shell/check, but for direct navigations
  // we check a cookie as a signal of onboarding completion.
  // The real redirect-to-dashboard vs redirect-to-onboarding is handled client-side.
  redirect('/mission-control');
}
