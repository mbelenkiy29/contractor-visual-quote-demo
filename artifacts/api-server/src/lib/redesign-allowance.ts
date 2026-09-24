import { pool } from "@workspace/db";

// A conservative reservation per dispatched image request, not a reading of the
// provider's actual invoice. Failed or timed-out requests remain reserved.
function positiveInteger(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined) return fallback;
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error(`${name} must be a positive integer`);
  }
  return Number(value);
}

const contractorLimit = positiveInteger("REDESIGN_MONTHLY_CONTRACTOR_LIMIT", 3);
const monthlyBudgetCents = positiveInteger("REDESIGN_MONTHLY_BUDGET_CENTS", 1000);
const reservationCents = positiveInteger("REDESIGN_RESERVATION_CENTS", 100);

function period() {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  return {
    month: `${year}-${String(month + 1).padStart(2, "0")}`,
    resetsAt: new Date(Date.UTC(year, month + 1, 1)).toISOString(),
  };
}

type Totals = { contractor_count: string; total_cents: string };

function allowance(totals: Totals) {
  const count = Number(totals.contractor_count);
  const remainingBudget = Math.max(0, Math.floor((monthlyBudgetCents - Number(totals.total_cents)) / reservationCents));
  const remaining = Math.min(Math.max(0, contractorLimit - count), remainingBudget);
  return {
    remaining,
    limit: contractorLimit,
    resetsAt: period().resetsAt,
    exhaustedReason: remaining > 0 ? null : count >= contractorLimit
      ? "This contractor has used all monthly redesigns."
      : "The site's monthly AI budget has been reached.",
  };
}

async function totalsFor(contractorId: string, month: string, query: typeof pool.query) {
  const result = await query<Totals>(
    `SELECT count(*) FILTER (WHERE contractor_id = $1)::text AS contractor_count,
            COALESCE(sum(reserved_cents), 0)::text AS total_cents
     FROM redesign_usage WHERE month = $2`,
    [contractorId, month],
  );
  return result.rows[0]!;
}

export async function getRedesignAllowance(contractorId: string) {
  const { month } = period();
  return allowance(await totalsFor(contractorId, month, pool.query.bind(pool)));
}

export async function reserveRedesign(contractorId: string) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Serialize reservations across *all* contractors and app instances.
    await client.query("SELECT pg_advisory_xact_lock(675892134)");
    const { month } = period();
    const current = allowance(await totalsFor(contractorId, month, client.query.bind(client)));
    if (current.remaining === 0) {
      await client.query("COMMIT");
      return current;
    }
    await client.query(
      "INSERT INTO redesign_usage (contractor_id, month, reserved_cents) VALUES ($1, $2, $3)",
      [contractorId, month, reservationCents],
    );
    await client.query("COMMIT");
    return null;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}