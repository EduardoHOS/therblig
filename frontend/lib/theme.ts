/**
 * Where the reader's choice is remembered.
 *
 * This is a plain module on purpose. The constant is read by the root layout, which is a server
 * component, and by the switch, which is a client one. Importing it from the client module instead
 * hands the server a client-reference proxy rather than the string — the pre-paint script then
 * reads `localStorage.getItem('function() { throw ... }')`, finds nothing, and the theme silently
 * fails to survive a reload.
 */
export const THEME_KEY = 'treadle-theme';
