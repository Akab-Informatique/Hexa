// Money and rules of the service catalogue: fixed recurring services and one-time products. Pure (no db), shared by the API and the UI.
// Money is integer cents everywhere; quantities have at most 2 decimals and are handled as hundredths so no float ever touches an amount.

export const MAX_PRICE_CENTS = 100_000_000;  // 1 000 000,00 $ for one unit
export const MAX_LINE_CENTS = 100_000_000;   // 1 000 000,00 $ for one billing line
export const MAX_QUANTITY = 1000;

export type ServiceType = "recurring" | "product";
export type ServicePeriod = "monthly" | "quarterly" | "yearly";
export type ServiceKindDb = "monthly" | "quarterly" | "yearly" | "one_time";

/** The catalogue stores one `kind` column: the period of a recurring service, or `one_time` for a product. */
export const kindFor = (type: ServiceType, period?: ServicePeriod | null): ServiceKindDb => (type === "product" ? "one_time" : period ?? "monthly");
export const typeOf = (kind: ServiceKindDb): ServiceType => (kind === "one_time" ? "product" : "recurring");
export const periodOf = (kind: ServiceKindDb): ServicePeriod | null => (kind === "one_time" ? null : kind);

export const isCents = (n: unknown, max = MAX_PRICE_CENTS): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0 && n <= max;

/** Quantity in hundredths (2.5 -> 250), or null when it is not a number with at most 2 decimals within 0.01..MAX_QUANTITY. */
export function quantityHundredths(q: unknown): number | null {
  if (typeof q !== "number" || !Number.isFinite(q)) return null;
  const h = Math.round(q * 100);
  if (Math.abs(q * 100 - h) > 1e-6 || h < 1 || h > MAX_QUANTITY * 100) return null;
  return h;
}

/** unit price x quantity, rounded half up to the cent, in integer arithmetic. */
export const lineTotalCents = (unitCents: number, qtyHundredths: number) => Math.floor((unitCents * qtyHundredths + 50) / 100);

/** Cents as the decimal string a numeric(12,2) column takes: 15000 -> "150.00". */
export function centsToDecimal(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents < 0) throw new RangeError("cents must be a non-negative integer");
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

export const isValidDay = (s: unknown): s is string => {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};

export type SaleError = "price_invalid" | "quantity_invalid" | "total_too_large" | "total_zero" | "service_inactive" | "not_a_product";
export interface SaleOk { unitCents: number; qtyHundredths: number; totalCents: number }

/** Checks one product sale. A sale is never free, never negative and never absurd. */
export function checkSale(svc: { active: boolean; kind: ServiceKindDb }, unitCents: unknown, quantity: unknown): SaleOk | { error: SaleError } {
  if (!svc.active) return { error: "service_inactive" };
  if (svc.kind !== "one_time") return { error: "not_a_product" };
  if (!isCents(unitCents)) return { error: "price_invalid" };
  const q = quantityHundredths(quantity);
  if (q === null) return { error: "quantity_invalid" };
  const total = lineTotalCents(unitCents, q);
  if (total <= 0) return { error: "total_zero" };
  if (total > MAX_LINE_CENTS) return { error: "total_too_large" };
  return { unitCents, qtyHundredths: q, totalCents: total };
}

/** Can a recurring service be newly attached? Inactive ones cannot; lines already attached keep billing (billing never looks at the catalogue). */
export const canAttach = (svc: { active: boolean; kind: ServiceKindDb }) => svc.active && svc.kind !== "one_time";

/** Stable text key of one contract charge: the same charge always has the same key, so billing it twice is impossible. */
export const chargeKeyText = (contractId: string, lineId: string, date: string) => `${contractId}:${lineId}:${date}`;

/** What a person typed ("150", "150.5", "1 234,50") as integer cents, or null when it is not a plain amount with at most 2 decimals. No float involved. */
export function parseCents(text: string): number | null {
  const m = /^(\d{1,9})(?:[.,](\d{1,2}))?$/.exec(text.replace(/[\s\u00a0$]/g, ""));
  if (!m) return null;
  const c = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0") || 0);
  return c <= MAX_PRICE_CENTS ? c : null;
}
