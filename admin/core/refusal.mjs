// What the admin core refuses to do, and why: a code (admin/core/codes.mjs) with its params and the files concerned,
// and the English message the Python tools print before they stop (sys.exit, status 1). Never a file's contents:
// paths, codes and (for an author's Kawari default) the KAWARI_SHIPPED_SAVES line with its CRC-32.
import { message } from './codes.mjs';

export class AdminRefusal extends Error {
  /**
   * @param {string} code  a refusal code of codes.mjs
   * @param {object} [params]
   * @param {{path: string, code: string, params?: object, line?: string}[]} [files] each gets `why`, its English text
   */
  constructor(code, params = {}, files = []) {
    const list = files.map(f => ({ ...f, why: message(f.code, f.params || {}) }));
    super(message(code, params, list));
    this.name = 'AdminRefusal';
    this.code = code;
    this.params = params;
    this.files = list;
  }

  /** {code, params, message, files: [{path, code, params?, line?, why}]} */
  toJSON() {
    return { code: this.code, params: this.params, message: this.message, files: this.files };
  }
}

/** A refusal as the API returns it (inspectSource items carry it as `refusal`). */
export const refusalOf = e => e.toJSON();
