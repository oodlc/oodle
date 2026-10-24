import { createContext, useContext } from 'react';
import type { ProjectsResponse } from '../shared/protocol.ts';

/** Who is signed in, and their projects. Loaded once by <App>; screens call `reload` after they change counts. */
export const Session = createContext<{ data: ProjectsResponse; reload: () => void } | null>(null);

export function useSession() {
  const s = useContext(Session);
  if (!s) throw new Error('useSession outside <App>');
  return s;
}

export function Problem({ error }: { error: Error }) {
  return (
    <div className="banner error" role="alert">
      {error.message}
    </div>
  );
}
