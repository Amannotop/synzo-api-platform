/**
 * The API version, reported by `GET /version` and stamped into the OpenAPI
 * document.
 *
 * It lives in its own module rather than in app.ts because app.ts imports
 * every route module, so exporting the constant from there would make the
 * route files import the file that imports them.
 *
 * One definition, so /version and /openapi.json can never disagree about which
 * build a customer is talking to.
 */
export const APP_VERSION = '1.0.0';
