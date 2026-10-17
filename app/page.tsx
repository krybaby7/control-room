import { requireChatGPTUser } from './chatgpt-auth';
import ControlCenter from '../components/control-center';

export const dynamic = 'force-dynamic';

export default async function Home() {
  const user = await requireChatGPTUser('/');
  return <ControlCenter userName={user.fullName ?? user.email.split('@')[0]} />;
}
