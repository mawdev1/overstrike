/**
 * Storage faults are ours, not the caller's.  contracts/errors.md §3, §5.
 *
 * The store adapters raise `VALIDATION_FAILED` for a schema problem — an unknown column, a
 * missing not-null value — because from inside the adapter that is what it is. Handed to a
 * client unchanged it becomes a 400 that blames the request for a bug in our code, and it
 * names the column: `VALIDATION_FAILED "Unknown column for events_outbox: type"` was the real
 * response to a real signup. errors.md §5 is explicit that internal detail — SQL fragments,
 * column names, dependency internals — never leaves in a response.
 *
 * So a schema-shaped store failure is re-raised as `INTERNAL_ERROR`, with the original kept on
 * `cause` for the log, where the correlation id can find it.
 */
import { ApiError } from '../../core/errors.js';

/** A store column/not-null rejection carries `details.table`; a real input failure does not. */
const isSchemaFault = (err) => err instanceof ApiError
  && err.code === 'VALIDATION_FAILED'
  && !!err.details && typeof err.details.table === 'string';

export async function internalise(fn) {
  try {
    return await fn();
  } catch (err) {
    if (!isSchemaFault(err)) throw err;
    throw new ApiError('INTERNAL_ERROR', 'Something went wrong on our end.', { cause: err });
  }
}
