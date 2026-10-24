import type { ReactNode } from 'react';
import type { ProjectsResponse } from '../shared/protocol.ts';
import { api, useLoad } from './api.ts';
import { paths } from './lib/format.ts';
import { Link, useRoute } from './router.tsx';
import { ActivityScreen } from './screens/Activity.tsx';
import { GapScreen } from './screens/Gap.tsx';
import { InboxScreen } from './screens/Inbox.tsx';
import { IntentScreen } from './screens/Intent.tsx';
import { SettingsScreen } from './screens/Settings.tsx';
import { Problem, Session } from './session.tsx';

export function App() {
  const route = useRoute();
  const session = useLoad('projects', () => api<ProjectsResponse>('GET', '/projects'));

  let body: ReactNode;
  if (session.error) body = <Problem error={session.error} />;
  else if (!session.data) body = <p className="muted">Loading…</p>;
  else if (route.screen === 'inbox') body = <InboxScreen />;
  else if (route.screen === 'gap') body = <GapScreen key={`${route.project}/${route.id}`} project={route.project} id={route.id} />;
  else if (route.screen === 'intent') body = <IntentScreen key={`${route.project}/${route.id}`} project={route.project} id={route.id} />;
  else if (route.screen === 'activity') body = <ActivityScreen key={route.project} project={route.project} />;
  else if (route.screen === 'settings') body = <SettingsScreen key={route.project} project={route.project} />;
  else
    body = (
      <p>
        Nothing here. <Link to={paths.inbox()}>Back to the inbox</Link>.
      </p>
    );

  return (
    <>
      <header className="top">
        <Link to={paths.inbox()} className="brand">
          Oodle inbox
        </Link>
        {session.data && <span className="muted small">{session.data.me}</span>}
      </header>
      <main>{session.data ? <Session.Provider value={{ data: session.data, reload: session.reload }}>{body}</Session.Provider> : body}</main>
    </>
  );
}
