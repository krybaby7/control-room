import { requireChatGPTUser } from './chatgpt-auth';
import ControlCenter from '../components/control-center';
import { BOOT_READ_SCRIPT } from '../lib/workspace-boot-read';

export const dynamic = 'force-dynamic';

export default async function Home() {
  const user = await requireChatGPTUser('/');
  return <>
    {/* Start the first workspace read while the page's code downloads. */}
    <script dangerouslySetInnerHTML={{ __html: BOOT_READ_SCRIPT }} />
    <ControlCenter userName={user.fullName ?? user.email.split('@')[0]} />
  </>;
}
