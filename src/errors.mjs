// Errors carry a stable `code` (it matches the err.<code> entries of the locale files) so the page can show
// them in the user's language. `message` is the English fallback and what goes to the log; `params` fill the
// {placeholders} of the translation.
export function fail(code, status, message, params) {
  return Object.assign(new Error(message), { code, status, params });
}
