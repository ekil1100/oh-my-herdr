import { registerPiHooks } from '../src/pi-hooks.mjs';

export default function ohMyHerdr(pi, env = process.env) {
  registerPiHooks(pi, undefined, env);
}
