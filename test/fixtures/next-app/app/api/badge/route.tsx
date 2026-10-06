// JSX with "jsx": "preserve", as in every Next project.
export function GET() {
  const badge = <b className="badge">new</b>;
  return Response.json({ tag: badge.type, text: badge.props.children });
}
