// Comments may mention Math.random(), 0.5 and 'You win the auction' freely.
/* Block comments too: Date.now() and parseFloat('1.5'). */
import { CORE_VERSION } from './version.js';

export const KEY = 'auction.bid.rejected';
export const BASIS_POINTS = 10000;
export const PERCENT = 8;
export const PATTERN = /["'`]\d+\.\d+/g;
export const DIVIDED = (CORE_VERSION + 4) / 2;
export const TEMPLATE = `${CORE_VERSION}:${KEY}`;
export function fail(reason) {
  throw new Error('Invalid command payload: ' + reason);
}
export const NOTE = '0.5 and 1e6';
