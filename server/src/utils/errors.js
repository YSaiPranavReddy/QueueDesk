/**
 * Error class thrown when a database atomic state transition fails 
 * due to the row having changed state underneath the operation.
 */
export class ConcurrencyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConcurrencyError';
  }
}
