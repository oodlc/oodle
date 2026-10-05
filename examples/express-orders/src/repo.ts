// The service's data layer. In production this would be Postgres; here it is a module-level store.
export interface Order { id: string; userId: string; amountCents: number; chargeId: string; status: 'paid' | 'refunded'; createdAt: string }
export interface User { id: string; email: string; plan: 'free' | 'pro' }

export const store = {
  users: new Map<string, User>(),
  orders: new Map<string, Order>(),
};
