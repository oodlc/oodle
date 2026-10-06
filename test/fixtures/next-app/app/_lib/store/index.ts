import 'server-only';

/** The app's store: a module-level map, pointed at ctx.state by setup() in oodle.app.ts. */
export const db: { orders: Map<string, { id: string; sku: string; paid: boolean }> } = { orders: new Map() };
