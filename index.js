/**
 * dsh-bot-restart-btn — Host half.
 *
 * The restart machinery lives in ./lib (vendored from dsh-restart-now 1.3.0, MIT,
 * https://github.com/Mr54233/dsh-restart-now) so the button no longer depends on a
 * second plugin being installed: it was delegating to /plugins/dsh-restart-now/*,
 * and when that package disappeared from the profile the button answered HTTP 405.
 *
 * Routes served here (same contract the client speaks):
 *   GET  /plugins/dsh-bot-restart-btn/environment   probe: environment/platform/config/version
 *   POST /plugins/dsh-bot-restart-btn/restart       ?force=1 | ?wait=1 | ?cancel=1
 *   GET  /plugins/dsh-bot-restart-btn/status        wait-mode snapshot
 *   GET  /plugins/dsh-bot-restart-btn/config        read config (kept for parity)
 *   POST /plugins/dsh-bot-restart-btn/config        write config
 *
 * Config file: <profile>/restart-button.config.json
 * Receipt file: <profile>/restart-button.last.json
 */
export { apply, name } from './lib/index.js';
