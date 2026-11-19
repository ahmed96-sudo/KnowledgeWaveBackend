/** The database stores money as integer cents; the API speaks dollars (a number with at most 2 decimals). */
export const toCents = (dollars: number) => Math.round(dollars * 100);
export const fromCents = (cents: number) => cents / 100;
