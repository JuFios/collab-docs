import type { Metadata } from 'next';
import { NotificationsList } from '@/components/notifications/notifications-list';
import { getNotifications } from '@/lib/workspaces/data';

export const metadata: Metadata = { title: 'Notifications' };

/** First page rendered on the server; the client list takes over from there. */
export default async function NotificationsPage() {
  const initialPage = await getNotifications();
  return <NotificationsList initialPage={initialPage} />;
}
