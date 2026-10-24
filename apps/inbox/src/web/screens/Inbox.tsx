import type { GapRecord, GapsResponse, IntentRecord, IntentsResponse, ProjectSummary } from '../../shared/protocol.ts';
import { api, useLoad } from '../api.ts';
import { age, groupGaps, humanize, kindLabel, paths } from '../lib/format.ts';
import { Link } from '../router.tsx';
import { Problem, useSession } from '../session.tsx';

type ProjectInbox = { project: ProjectSummary; gaps: GapRecord[]; intents: IntentRecord[] };

/** Open human-routed gaps (and gaps with an unresolved conflict) per project, plus intents in review. */
async function loadInbox(projects: ProjectSummary[]): Promise<ProjectInbox[]> {
  return Promise.all(
    projects.map(async (project) => {
      const base = `/projects/${encodeURIComponent(project.id)}`;
      const [open, conflicted, intents] = await Promise.all([
        api<GapsResponse>('GET', `${base}/gaps?status=open&route=human`),
        api<GapsResponse>('GET', `${base}/gaps?conflicts=open`),
        api<IntentsResponse>('GET', `${base}/intents?status=in_review`),
      ]);
      const gaps = new Map([...open.gaps, ...conflicted.gaps].map((g) => [g.id, g]));
      return { project, gaps: [...gaps.values()], intents: intents.intents };
    }),
  );
}

export function InboxScreen() {
  const { data: session } = useSession();
  const inbox = useLoad('inbox', () => loadInbox(session.projects));

  if (session.projects.length === 0) {
    return (
      <p>
        You are not a member of any project yet. Ask a project owner to add <strong>{session.me}</strong>.
      </p>
    );
  }
  if (inbox.error) return <Problem error={inbox.error} />;
  if (!inbox.data) return <p className="muted">Loading…</p>;

  const total = inbox.data.reduce((n, p) => n + p.gaps.length + p.intents.length, 0);
  return (
    <>
      <h1>Inbox</h1>
      <p className="muted">
        {total === 0
          ? 'Nothing needs you. The builds agree on everything people were asked.'
          : 'Questions the builds left open, and changes waiting for review.'}
      </p>
      {inbox.data.map((p) => (
        <ProjectSection key={p.project.id} {...p} />
      ))}
    </>
  );
}

function ProjectSection({ project, gaps, intents }: ProjectInbox) {
  const titles = new Map(intents.map((i) => [i.id, i.body.title]));
  return (
    <section className="project">
      <div className="project-head">
        <h2>{project.name}</h2>
        <nav className="small">
          <Link to={paths.activity(project.id)}>Activity</Link>
          {project.role === 'owner' && <Link to={paths.settings(project.id)}>People and tokens</Link>}
        </nav>
      </div>

      {intents.length > 0 && (
        <>
          <h3>Changes to review</h3>
          <ul className="rows">
            {intents.map((i) => (
              <li key={i.id}>
                <Link to={paths.intent(project.id, i.id)}>{i.body.title}</Link>
                <span className="muted small">{i.body.why}</span>
              </li>
            ))}
          </ul>
        </>
      )}

      {gaps.length === 0 && intents.length === 0 && <p className="muted">No open questions.</p>}
      {groupGaps(gaps).map((group) => (
        <div key={group.intent ?? '-'} className="group">
          {group.intent && (
            <h3>
              Raised by the change <Link to={paths.intent(project.id, group.intent)}>{titles.get(group.intent) ?? group.intent}</Link>
            </h3>
          )}
          {!group.intent && <h3>Questions</h3>}
          {group.entities.map(({ entity, gaps: gs }) => (
            <div key={entity ?? '-'}>
              <h4 className="entity">{entity ? humanize(entity) : 'Other'}</h4>
              <ul className="rows">
                {gs.map((g) => (
                  <li key={g.id}>
                    <span className="badge">{kindLabel(g.kind)}</span>
                    <Link to={paths.gap(project.id, g.id)}>{g.question}</Link>
                    <span className="muted small">{age(g.created_at)}</span>
                    {g.open_conflicts > 0 && <span className="badge warn">Two answers disagree</span>}
                    {g.note && <span className="badge warn">Evidence changed</span>}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      ))}
    </section>
  );
}
