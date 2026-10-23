/** Matching requests and surfaces to route patterns (`/orders/:id`), shared by the runner, lint and discovery. */

/** Does a "METHOD /path" trigger or capability surface reach this "METHOD /pattern" route? */
export function reaches(surface: string, route: string): boolean {
  const [m, p] = surface.split(' ');
  const [rm, rp] = route.split(' ');
  return m === rm && (p === rp || routeRegex(rp).test(p.split('?')[0]));
}

export function routeRegex(pattern: string): RegExp {
  const escaped = pattern.split('/').map((seg) => (seg.startsWith(':') ? '[^/]+' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('/');
  return new RegExp(`^${escaped}$`);
}
