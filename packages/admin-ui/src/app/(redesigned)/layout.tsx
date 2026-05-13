import '../globals-v2.css';
import { ReadinessBanner } from '@/components/v2/readiness-banner';

export const dynamic = 'force-dynamic';

export default function V2Layout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <ReadinessBanner />
      {children}
    </>
  );
}
