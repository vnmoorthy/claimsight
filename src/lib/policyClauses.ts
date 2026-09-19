/** Northwind Home policy clauses (data/policy.json) — shown on chips and in the trace panel. */
export const POLICY_CLAUSES: Record<string, string> = {
  P1: 'Refund window is 30 days from delivery',
  P2: 'Damage must be visible in customer evidence',
  P3: 'Amounts above $75 require human approval',
  P4: 'Kitchen and lighting items: offer replacement first when in stock',
  P5: 'Matching evidence across different accounts is escalated as suspected fraud',
  P6: 'Worn apparel is not returnable',
};

export const POLICY_CLAUSE_IDS = Object.keys(POLICY_CLAUSES);

export function clauseText(id: string): string {
  return POLICY_CLAUSES[id.toUpperCase()] ?? id;
}
