/**
 * Wire shapes shared by the inbox Worker, its web app and the CLI's sync client.
 * Gap and intent files follow sections 7.3 and 9 of docs/implementation-guide.md; the sync
 * and UI bodies follow 10.3 and 10.4. Fields marked "inbox extension" are optional additions
 * a client may ignore.
 */

// ---------------------------------------------------------------- gap files (7.3)

export type GapFileStatus = 'open' | 'answered' | 'dismissed' | 'applied';
/** What the inbox stores: the file's statuses, plus `superseded` once a gaps run no longer raises it. */
export type GapStatus = GapFileStatus | 'superseded';
export type GapKind = 'sort_order' | 'format' | 'permission' | 'rule' | 'extra_element' | 'wording' | 'pagination' | 'decision_moved' | 'other';
export type Tier = 'decided' | 'declared';
export type Route = 'agent' | 'human';

/** One build's side of a difference, as a user would see it. */
export type EvidenceSide = {
  summary: string;
  /** Values as they appear on screen: list items in order, a message, a status. */
  sample?: unknown[];
};

export type Evidence = {
  /** Scenario id, e.g. `explore/collections/walks-7` or `journey/first-booking#2`. */
  scenario: string;
  /** Inbox extension: the scenario in plain words, when the CLI has them. */
  scenario_text?: string;
  a: EvidenceSide;
  b: EvidenceSide;
};

export type GapOption = {
  id: string;
  label: string;
  becomes?: {
    decision?: string;
    /** Inbox extension: text of the existing decision this option would replace. */
    replaces?: string;
    /** Declared-tier effects, for permission and rule gaps (decision 0023). Only a person's answer may write these. */
    constraint?: string;
    rule?: { entity: string; text: string };
    cannot?: { persona: string; text: string };
  };
};

/** An answer, as posted from the UI (10.4) and as pulled by the CLI (10.3). Exactly one form. */
export type AnswerBody = { option: string } | { text: string; target: RuleTarget } | { dont_care: true } | { dismiss: true };

export type RuleTarget = 'decision' | 'domain_rule' | 'constraint';

/** An answer as written into a gap file: the body plus, for agents, why (8.3). */
export type GapFileAnswer = AnswerBody & { reason?: string };

export type GapFile = {
  id: string;
  status: GapFileStatus;
  kind: GapKind;
  tier: Tier;
  /** Inbox extension: why the tier was chosen (8.1 asks the CLI to record it). */
  tier_reason?: string;
  route: Route;
  spec_hash: string;
  found_in: string[];
  about: string[];
  question: string;
  evidence: Evidence;
  options: GapOption[];
  answer: GapFileAnswer | null;
  answered_by: string | null;
  answered_at: string | null;
  applied_in: string | null;
  /** Set when an intent review raised the gap (section 9, step 2). `intent` is accepted too. */
  intent_id?: string | null;
};

// ---------------------------------------------------------------- intent files (9)

export type IntentStatus = 'draft' | 'in_review' | 'approved' | 'merged' | 'rejected';

/** A structured edit to the declared tier. Known ops are typed; anything else still round-trips. */
export type IntentChange =
  | { op: 'replace_rule'; entity: string; from: string; to: string }
  | { op: 'add_rule'; entity: string; rule: string }
  | { op: 'remove_rule'; entity: string; rule: string }
  | { op: 'add_constraint'; text: string }
  | { op: 'remove_constraint'; text: string }
  | { op: 'replace_constraint'; from: string; to: string }
  | { op: 'add_journey'; journey: string; persona?: string; steps?: string[] }
  | { op: 'add_step'; journey: string; step: string; after?: string }
  | { op: 'replace_step'; journey: string; from: string; to: string }
  | { op: 'add_persona_capability'; persona: string; can: string }
  | { op: string; [field: string]: unknown };

export type IntentApprovalRecord = { by: string; at: string; via: 'inbox' | 'cli' };

export type IntentFile = {
  id: string;
  title: string;
  status: IntentStatus;
  why: string;
  changes: IntentChange[];
  keeps?: { journeys?: string[]; constraints?: string[] };
  rules_out?: string[];
  done_when?: { journeys?: string[]; evals?: string[] };
  approvals?: IntentApprovalRecord[];
};

// ---------------------------------------------------------------- CLI sync (10.3)

export type PushedGap = { id: string; content_hash: string; body: GapFile };
export type PushedIntent = { id: string; content_hash: string; body: IntentFile };
export type AppliedAck = { answer_id: string; sha: string };

export type SyncRequest = {
  client: { version: string; spec_hash?: string; git_sha?: string };
  push?: {
    gaps?: PushedGap[];
    intents?: PushedIntent[];
    applied?: AppliedAck[];
    /** Gaps that disappeared after a new gaps run. */
    superseded_gaps?: string[];
  };
  /** Last seq the client has applied. 0 on first sync. */
  cursor: number;
};

export type PulledAnswer = {
  id: string;
  gap_id: string;
  answer: AnswerBody;
  answered_by: string;
  seq: number;
  /** Inbox extension. */
  answered_at?: string;
};

export type PulledApproval = {
  intent_id: string;
  content_hash: string;
  decision: 'approve' | 'reject';
  /** The person's email, without the `person:` prefix. */
  by: string;
  seq: number;
  /** Inbox extensions. */
  id?: string;
  at?: string;
  note?: string | null;
};

export type SyncResponse = {
  answers: PulledAnswer[];
  approvals: PulledApproval[];
  cursor: number;
};

// ---------------------------------------------------------------- UI API (10.4)

export type Role = 'owner' | 'answerer' | 'viewer';

export type ProjectSummary = {
  id: string;
  name: string;
  repo_url: string | null;
  role: Role;
  open_human_gaps: number;
  intents_in_review: number;
};

export type ProjectsResponse = { me: string; projects: ProjectSummary[] };

/** A gap as the inbox holds it: the file plus the inbox's own bookkeeping. */
export type GapRecord = {
  project_id: string;
  id: string;
  status: GapStatus;
  route: Route;
  tier: Tier;
  kind: GapKind;
  question: string;
  intent_id: string | null;
  spec_hash: string;
  content_hash: string;
  version: number;
  /** Why the gap was reopened (its evidence changed after it was answered). */
  note: string | null;
  created_at: string;
  updated_at: string;
  body: GapFile;
  /** The answer that currently stands, if any. */
  answer: AnswerRecord | null;
  /** Unresolved conflicting answers (8.5). Non-zero means someone should look again. */
  open_conflicts: number;
};

export type AnswerRecord = {
  id: string;
  gap_id: string;
  answer: AnswerBody;
  answered_by: string;
  answered_at: string;
  seq: number;
  applied_sha: string | null;
  acked_at: string | null;
};

export type ConflictRecord = {
  id: string;
  gap_id: string;
  answer: AnswerBody;
  answered_by: string;
  answered_at: string;
  against_answer_id: string;
  resolution: 'kept' | 'taken' | null;
  resolved_by: string | null;
  resolved_at: string | null;
};

export type GapsResponse = { gaps: GapRecord[] };
export type GapDetailResponse = { gap: GapRecord; answers: AnswerRecord[]; conflicts: ConflictRecord[]; role: Role };

/** POST .../gaps/:id/answer. `version` is the gap version the person saw. */
export type AnswerRequest = AnswerBody & { version: number };
export type AnswerResponse = { answer: AnswerRecord; gap: GapRecord };

/** POST .../gaps/:id/conflicts/:cid/resolve: keep the standing answer, or take the conflicting one. */
export type ResolveConflictRequest = { resolution: 'keep' | 'take' };

export type ApprovalRecord = {
  id: string;
  intent_id: string;
  content_hash: string;
  decision: 'approve' | 'reject';
  by_email: string;
  at: string;
  note: string | null;
  seq: number;
  /** False once the intent's content changed after this review (10.2). */
  current: boolean;
};

export type IntentRecord = {
  project_id: string;
  id: string;
  status: IntentStatus;
  content_hash: string;
  updated_at: string;
  body: IntentFile;
};

export type IntentsResponse = { intents: IntentRecord[] };
export type IntentDetailResponse = { intent: IntentRecord; approvals: ApprovalRecord[]; gaps: GapRecord[]; role: Role };

export type ReviewRequest = { decision: 'approve' | 'reject'; note?: string; content_hash: string };
export type ReviewResponse = { approval: ApprovalRecord; intent: IntentRecord };

export type EventRecord = { id: string; at: string; actor: string; type: string; data: Record<string, unknown> };
export type ActivityResponse = { events: EventRecord[] };

export type CreateTokenRequest = { label?: string };
/** The token is returned once, here, and stored only as a hash. */
export type CreateTokenResponse = { id: string; token: string; label: string | null };
export type TokenRecord = { id: string; label: string | null; created_by: string; created_at: string; revoked_at: string | null };

export type AddMemberRequest = { email: string; role: Role };

/** Error bodies. `gap` / `intent` carry the current state on 409. */
export type ErrorResponse = { error: string; message: string; gap?: GapRecord; intent?: IntentRecord };
