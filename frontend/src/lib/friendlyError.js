// Turns raw database / network error text into a message a staff member can
// act on. Readable business messages raised deliberately by our own RPCs
// (e.g. "You are not authorized to accept Factory Requests") are passed
// through untouched; only technical strings are replaced. The original is
// always logged to the console for debugging.
const TECHNICAL = [
  [/Failed to fetch|NetworkError|Load failed|network request failed/i, "Can't reach the server. Check your internet connection and try again."],
  [/JWT|token.*expired|not authenticated|Invalid Refresh Token/i, "Your session has expired. Please sign in again."],
  [/row-level security|permission denied|42501/i, "You don't have permission to do this."],
  [/duplicate key|unique constraint|23505/i, "This already exists."],
  [/violates foreign key|23503/i, "This is linked to other records and can't be changed this way."],
  [/violates not-null|null value in column|23502/i, "A required field is missing."],
  [/violates check constraint|23514|invalid input (syntax|value)|22P02/i, "One of the values isn't valid. Please check and try again."],
  [/PGRST\d+|relation .* does not exist|column .* does not exist|function .* does not exist|schema cache|syntax error/i, "Something went wrong on our side. Please try again, and tell your administrator if it keeps happening."],
  [/timeout|timed out|statement timeout/i, "This is taking too long. Please try again."],
];

export function friendlyError(message) {
  const text = typeof message === "string" ? message : message?.message || "";
  if (!text) return "Something went wrong. Please try again.";
  for (const [re, friendly] of TECHNICAL) {
    if (re.test(text)) {
      console.error("[friendlyError] original:", text);
      return friendly;
    }
  }
  return text;
}
